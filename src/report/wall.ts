// The control-room wall (`wall` verb): many case videos at once, muted and
// looping at their evidence moments, with case state overlaid. This module is
// model assembly + HTML rendering only — no ffmpeg/pi imports, so it stays
// offline-unit-testable; src/verbs/wall.ts owns poster extraction, file writes,
// and launching. Local media is referenced by file:// URL (never base64 —
// videos are too big to embed), so the page depends on the media staying put.

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { findingStatusMap, isReady, type OvercastRecord } from "../record.js";
import { isRegisterableMediaRecord } from "../verbs/media-ref.js";
import { isRootFindingRecord } from "../verbs/finding.js";
import { escapeHtml, summarizePayload, type HtmlTheme } from "./html.js";

export interface WallAnchor {
  /** the evidence second the tile is anchored to */
  at: number;
  /** the loop window played on the wall */
  start: number;
  end: number;
  source: "finding" | "face" | "record" | "start";
  /** true only when start/end IS the evidence's own [start,end] span — synthetic
   *  windows around a point anchor must never be presented as a span */
  span?: boolean;
}

export interface WallTile {
  ref: string;
  /** file:// URL (local) or http(s) URL; null when the file is gone */
  fileUrl: string | null;
  /** video = playable in a <video> tag; still = present but browser-hostile
   *  container (poster candidate); down = missing/unresolvable (NO SIGNAL) */
  mode: "video" | "still" | "down";
  title: string;
  duration: number | null;
  anchor: WallAnchor;
  coverage: { watch: boolean; listen: boolean; see: boolean; face: boolean };
  faceCount: number;
  openFindings: number;
  summary: string;
  recordIds: string[];
  sourceType: string | null;
  lastRecordTime: string | null;
  ageSeconds: number | null;
  /** file:// URL of an extracted still (filled by the verb's poster pass) */
  poster: string | null;
}

export interface WallHud {
  caseName: string;
  caseDir: string;
  generatedAt: string;
  tilesShown: number;
  totalVideos: number;
  records: number;
  counts: Record<string, number>;
  openFindings: number;
  lastScans: Array<{ source: string; time: string; ageSeconds: number }>;
  lastScanAgeSeconds: number | null;
  monitor: { time: string; ageSeconds: number; newItems: number } | null;
  briefAgeSeconds: number | null;
  refreshSeconds: number | null;
}

export interface WallModel {
  hud: WallHud;
  tiles: WallTile[];
}

export interface BuildWallOptions {
  caseName: string;
  caseDir: string;
  /** max tiles (most evidentiary/recent first) */
  limit: number;
  /** only media from this source type; unattributed media matches "local" */
  source?: string;
  /** epoch-ms cutoff (pre-parsed via parseSince); undated tiles are kept */
  sinceCutoff?: number;
  refreshSeconds?: number;
  /** injectable clock/fs for tests */
  now?: number;
  fileExists?: (path: string) => boolean;
}

// Containers browsers actually decode in a <video>/<audio> tag — narrower than
// media-ref's AV_RE on purpose (ffmpeg reads mkv/avi/wmv; Chrome won't).
const BROWSER_SAFE_RE = /\.(mp4|m4v|mov|webm|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

export function buildWallModel(records: OvercastRecord[], opts: BuildWallOptions): WallModel {
  const now = opts.now ?? Date.now();
  const fileExists = opts.fileExists ?? existsSync;

  // Registerable media records define the wall's refs; every record sharing the
  // ref (finding/crop/view/…) joins its group for coverage + intel.
  const groups = new Map<string, OvercastRecord[]>();
  for (const r of records) {
    if (isRegisterableMediaRecord(r) && !groups.has(r.media!.ref)) groups.set(r.media!.ref, []);
  }
  for (const r of records) {
    const ref = r.media?.ref;
    if (ref) groups.get(ref)?.push(r);
  }

  const statusMap = findingStatusMap(records);
  const openRootFindings = records.filter(
    (r) => isRootFindingRecord(r) && (statusMap.get(r.id) ?? "open") === "open",
  );
  // `see` persists the extracted frame path (mediaDir/<video>_t<sec>.jpg), not
  // the video ref — join see coverage back to its video by that filename stem.
  const seeRecords = records.filter((r) => r.verb === "see" && isReady(r) && r.media?.ref);

  let tiles = [...groups.entries()].map(([ref, group]) =>
    buildTile(ref, group, { openRootFindings, seeRecords, now, fileExists }),
  );

  if (opts.source) {
    const want = opts.source.toLowerCase();
    tiles = tiles.filter((t) => (t.sourceType ?? "local").toLowerCase() === want);
  }
  if (opts.sinceCutoff != null) {
    tiles = tiles.filter((t) => {
      const t0 = t.lastRecordTime ? Date.parse(t.lastRecordTime) : NaN;
      return Number.isNaN(t0) || t0 >= opts.sinceCutoff!;
    });
  }

  // most evidentiary first: findings dominate, then sense coverage, then faces;
  // newest activity breaks ties (ref keeps the order deterministic).
  tiles.sort(
    (a, b) => tileScore(b) - tileScore(a) || tileTime(b) - tileTime(a) || a.ref.localeCompare(b.ref),
  );
  const shown = tiles.slice(0, Math.max(1, Math.floor(opts.limit)));

  return {
    hud: buildHud(records, {
      caseName: opts.caseName,
      caseDir: opts.caseDir,
      now,
      totalVideos: groups.size,
      tilesShown: shown.length,
      openFindings: openRootFindings.length,
      refreshSeconds: opts.refreshSeconds,
    }),
    tiles: shown,
  };
}

function tileScore(t: WallTile): number {
  const coverage = Object.values(t.coverage).filter(Boolean).length;
  return t.openFindings * 100 + coverage * 10 + (t.faceCount > 0 ? 5 : 0);
}

function tileTime(t: WallTile): number {
  const ms = t.lastRecordTime ? Date.parse(t.lastRecordTime) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

interface TileJoin {
  openRootFindings: OvercastRecord[];
  seeRecords: OvercastRecord[];
  now: number;
  fileExists: (path: string) => boolean;
}

function buildTile(ref: string, group: OvercastRecord[], join: TileJoin): WallTile {
  const ready = group.filter(isReady);
  // every metadata picker walks newest-first, matching the anchor rule — a
  // re-run sense on the same ref must win the title/summary/source display too
  const readyNewest = newestFirst(ready);
  const watch = readyNewest.find((r) => r.verb === "watch");
  const faceRecs = ready.filter((r) => r.verb === "face" && payloadOf(r).op !== "search");
  const frameRe = frameFileRe(ref);
  const sees = join.seeRecords.filter(
    (r) => r.media!.ref === ref || frameRe.test(basename(r.media!.ref)),
  );
  const tileFindings = join.openRootFindings.filter((r) => r.media?.ref === ref);

  const metaTitle = watch?.meta?.title;
  const title = typeof metaTitle === "string" && metaTitle.trim() ? metaTitle : displayName(ref);
  // any ready sense may know the duration (watch sets it today; don't depend on
  // that) — and the player re-clamps at loadedmetadata where the browser knows
  // the real length, so a null here only affects the model/intel display.
  let duration: number | null = null;
  for (const r of readyNewest) {
    const d = r.meta?.duration_seconds;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) {
      duration = d;
      break;
    }
  }

  let faceCount = 0;
  for (const r of faceRecs) {
    const count = payloadOf(r).count;
    if (typeof count === "number" && count > faceCount) faceCount = count;
  }

  const times = group
    .map((r) => (r.meta?.time ? Date.parse(String(r.meta.time)) : NaN))
    .filter((t) => !Number.isNaN(t));
  const lastMs = times.length ? Math.max(...times) : null;

  const { mode, fileUrl } = classifyTile(ref, join.fileExists);

  return {
    ref,
    fileUrl,
    mode,
    title,
    duration,
    // anchor candidates are READY records only, like coverage — a pending or
    // failed sense must not set the loop window
    anchor: pickAnchor(ready, tileFindings, faceRecs, duration),
    coverage: {
      watch: !!watch,
      listen: ready.some((r) => r.verb === "listen"),
      see: sees.length > 0,
      face: faceRecs.length > 0,
    },
    faceCount,
    openFindings: tileFindings.length,
    summary: pickSummary(readyNewest),
    recordIds: sortByTime(group).map((r) => r.id),
    sourceType: pickSourceType(newestFirst(group)),
    lastRecordTime: lastMs != null ? new Date(lastMs).toISOString() : null,
    ageSeconds: lastMs != null ? Math.max(0, (join.now - lastMs) / 1000) : null,
    poster: null,
  };
}

function classifyTile(
  ref: string,
  fileExists: (path: string) => boolean,
): { mode: WallTile["mode"]; fileUrl: string | null } {
  if (/^https?:\/\//i.test(ref)) {
    let path = ref;
    try {
      path = new URL(ref).pathname;
    } catch {
      /* keep the full ref for the extension test */
    }
    // a browser-hostile remote container is STILL (exists, unplayable) like its
    // local twin — "down" means missing/unreachable; a 404 at play time still
    // flips video tiles to NO SIGNAL via the runtime error handler
    return { mode: BROWSER_SAFE_RE.test(path) ? "video" : "still", fileUrl: ref };
  }
  if (!fileExists(ref)) return { mode: "down", fileUrl: null };
  const fileUrl = pathToFileURL(ref).href;
  return { mode: BROWSER_SAFE_RE.test(ref) ? "video" : "still", fileUrl };
}

/** Anchor precedence: open finding > best face moment > the media record's own
 *  media.at > start of clip. A true [start,end] span ≤20s is looped verbatim;
 *  a point anchor loops [at−2, at+6], clamped to the known duration. */
function pickAnchor(
  ready: OvercastRecord[],
  findings: OvercastRecord[],
  faceRecs: OvercastRecord[],
  duration: number | null,
): WallAnchor {
  for (const f of newestFirst(findings)) {
    if (f.media?.at != null) return anchorWindow(f.media.at, "finding", duration);
  }
  let best: { at: number | [number, number]; sim: number } | undefined;
  for (const r of faceRecs) {
    const moments = payloadOf(r).moments;
    if (!Array.isArray(moments)) continue;
    for (const m of moments) {
      if (m == null || typeof m !== "object") continue;
      const at = (m as Record<string, unknown>).at;
      if (typeof at !== "number" && !isSpan(at)) continue;
      const rawSim = (m as Record<string, unknown>).similarity;
      if (typeof rawSim !== "number") continue;
      const sim = rawSim;
      if (!best || sim > best.sim) best = { at: at as number | [number, number], sim };
    }
  }
  if (best) return anchorWindow(best.at, "face", duration);
  // newest READY anchored sense wins, matching the findings rule and tile
  // ranking — an old listen anchor must not shadow a fresher watch anchor,
  // and a pending/failed row must not set the loop at all
  for (const r of newestFirst(ready)) {
    if (isRegisterableMediaRecord(r) && r.media?.at != null) {
      return anchorWindow(r.media.at, "record", duration);
    }
  }
  return anchorWindow(0, "start", duration);
}

function anchorWindow(
  raw: number | [number, number],
  source: WallAnchor["source"],
  duration: number | null,
): WallAnchor {
  if (isSpan(raw)) {
    const [s, e] = raw;
    if (e > s && e - s <= 20) {
      return clampWindow({ at: s, start: s, end: e, source, span: true }, duration);
    }
    return clampWindow({ at: s, start: Math.max(0, s - 2), end: s + 6, source }, duration);
  }
  const at = Math.max(0, raw);
  return clampWindow({ at, start: Math.max(0, at - 2), end: at + 6, source }, duration);
}

function clampWindow(a: WallAnchor, duration: number | null): WallAnchor {
  if (duration != null && duration > 0) {
    if (a.end > duration) {
      a.end = duration;
      // a clipped window is no longer the evidence's own span — don't advertise
      // the truncated range as a verbatim --at start-end
      delete a.span;
    }
    if (a.end <= a.start) {
      // anchor beyond the clip — fall back to looping the head (no longer the
      // evidence's own span, so drop the span marker)
      a.start = 0;
      a.end = Math.min(8, duration);
      a.at = Math.min(a.at, duration);
      delete a.span;
    }
  }
  return a;
}

function isSpan(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number");
}

const SUMMARY_VERBS = ["watch", "listen", "see", "note", "face", "capture"];

/** First usable summary by verb priority; callers pass records newest-first so
 *  a re-run sense wins within its verb. */
function pickSummary(ready: OvercastRecord[]): string {
  let fallback = "";
  for (const verb of SUMMARY_VERBS) {
    for (const r of ready) {
      if (r.verb !== verb) continue;
      const s = summarizePayload(r.payload);
      if (!s || s === "(empty)") continue;
      if (s.startsWith("payload: ")) {
        fallback ||= s;
        continue;
      }
      return s;
    }
  }
  return fallback;
}

/** Source attribution from captures (then provider tags); callers pass records
 *  newest-first so the latest acquisition wins. */
function pickSourceType(group: OvercastRecord[]): string | null {
  for (const r of group) {
    if (r.verb !== "capture") continue;
    const src = payloadOf(r).source;
    if (typeof src === "string" && src.trim()) return src;
  }
  for (const r of group) {
    const p = r.meta?.provider;
    if (typeof p === "string" && p.startsWith("source:")) return p.slice("source:".length);
  }
  return null;
}

interface HudOptions {
  caseName: string;
  caseDir: string;
  now: number;
  totalVideos: number;
  tilesShown: number;
  openFindings: number;
  refreshSeconds?: number;
}

function buildHud(records: OvercastRecord[], o: HudOptions): WallHud {
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.verb] = (counts[r.verb] ?? 0) + 1;

  // last scan per source — not persisted anywhere; derived from scan records.
  // Ready rows only (like monitor/brief freshness): a failed or cred-blocked
  // sweep must not make a source look freshly scanned.
  const scanTimes = new Map<string, number>();
  for (const r of records) {
    if (r.verb !== "scan" || !isReady(r)) continue;
    const p = payloadOf(r);
    if (p.op === "pull_progress") continue;
    const t = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
    if (Number.isNaN(t)) continue;
    const source = typeof p.source === "string" && p.source ? p.source : "scan";
    if (t > (scanTimes.get(source) ?? Number.NEGATIVE_INFINITY)) scanTimes.set(source, t);
  }
  const lastScans = [...scanTimes.entries()]
    .map(([source, t]) => ({
      source,
      time: new Date(t).toISOString(),
      ageSeconds: Math.max(0, (o.now - t) / 1000),
    }))
    .sort((a, b) => a.ageSeconds - b.ageSeconds);

  const monitorLatest = latestTimed(records, "monitor");
  const briefLatest = latestTimed(records, "brief");
  const newItems = monitorLatest ? payloadOf(monitorLatest.rec).new_items : undefined;

  return {
    caseName: o.caseName,
    caseDir: o.caseDir,
    generatedAt: new Date(o.now).toISOString(),
    tilesShown: o.tilesShown,
    totalVideos: o.totalVideos,
    records: records.length,
    counts,
    openFindings: o.openFindings,
    lastScans,
    lastScanAgeSeconds: lastScans.length ? lastScans[0].ageSeconds : null,
    monitor: monitorLatest
      ? {
          time: new Date(monitorLatest.t).toISOString(),
          ageSeconds: Math.max(0, (o.now - monitorLatest.t) / 1000),
          newItems: typeof newItems === "number" ? newItems : 0,
        }
      : null,
    briefAgeSeconds: briefLatest ? Math.max(0, (o.now - briefLatest.t) / 1000) : null,
    refreshSeconds: o.refreshSeconds ?? null,
  };
}

function latestTimed(records: OvercastRecord[], verb: string): { rec: OvercastRecord; t: number } | undefined {
  let best: { rec: OvercastRecord; t: number } | undefined;
  for (const rec of records) {
    if (rec.verb !== verb || !isReady(rec)) continue;
    const t = rec.meta?.time ? Date.parse(String(rec.meta.time)) : NaN;
    if (Number.isNaN(t)) continue;
    if (!best || t > best.t) best = { rec, t };
  }
  return best;
}

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
}

function sortByTime(records: OvercastRecord[]): OvercastRecord[] {
  return records
    .map((r, i) => {
      const parsed = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
      return { r, i, t: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed };
    })
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.r);
}

/** Dated records newest-first; undated go LAST (recency can't be proven), so an
 *  undated record never shadows the newest dated one. NOT sortByTime().reverse()
 *  — reversing would surface the undated (Infinity-keyed) records first. */
function newestFirst(records: OvercastRecord[]): OvercastRecord[] {
  return records
    .map((r, i) => {
      const parsed = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
      return { r, i, t: Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed };
    })
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.r);
}

/** Matches exactly the stills extractFrame derives from this video —
 *  `<stem>_t<seconds>.jpg` — not a loose prefix (a_tool_t12.jpg must never
 *  light a.mp4's S badge just because "a_tool_t" starts with "a_t"). */
function frameFileRe(ref: string): RegExp {
  const b = basename(ref.replace(/[?#].*$/, ""));
  const dot = b.lastIndexOf(".");
  const stem = dot > 0 ? b.slice(0, dot) : b;
  return new RegExp(`^${escapeRegExp(stem)}_t\\d+\\.jpg$`, "i");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayName(ref: string): string {
  if (/^https?:\/\//i.test(ref)) {
    try {
      const u = new URL(ref);
      return basename(u.pathname) || u.hostname;
    } catch {
      return ref;
    }
  }
  return basename(ref);
}

// --- rendering ---------------------------------------------------------------

export function renderWallHtml(model: WallModel, theme: HtmlTheme): string {
  const csi = theme === "csi";
  const refreshTag = model.hud.refreshSeconds
    ? `<meta http-equiv="refresh" content="${Math.round(model.hud.refreshSeconds)}">`
    : "";
  const title = `Wall — ${model.hud.caseName}`;
  const tiles = model.tiles.map((t, i) => renderTile(t, i)).join("\n");
  // sqrt grid: a wall of 16/9 tiles on a 16/9 screen self-fills the viewport
  // (5 tiles → 3-wide, 12 → 4-wide) instead of leaving one short row of minis.
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(model.tiles.length || 1))));
  return `<!doctype html><html><head><meta charset="utf-8">${refreshTag}<title>${escapeHtml(title)}</title>
<style>${WALL_BASE_CSS}
${csi ? CSI_SKIN : PLAIN_SKIN}</style></head><body${csi ? ' data-overcast-theme="csi"' : ""}>
${renderHud(model.hud)}
<main class="wall" style="--cols:${cols}"${csi ? ' data-csi-wall="true"' : ""}>
${tiles || `<div class="empty">NO FEEDS — filters matched no case videos</div>`}
</main>
<div class="start" id="start">▶ CLICK TO START FEEDS</div>
<script>${WALL_JS}</script>
</body></html>`;
}

function renderHud(hud: WallHud): string {
  const chips: string[] = [];
  chips.push(
    `<span class="chip${hud.openFindings ? " bad" : ""}">● ${hud.openFindings} OPEN FINDING${hud.openFindings === 1 ? "" : "S"}</span>`,
  );
  for (const s of hud.lastScans.slice(0, 4)) {
    chips.push(`<span class="chip cyan">SCAN ${escapeHtml(s.source.toUpperCase())} ${fmtAge(s.ageSeconds)}</span>`);
  }
  if (hud.monitor) {
    chips.push(`<span class="chip amber">MONITOR ${fmtAge(hud.monitor.ageSeconds)} · +${hud.monitor.newItems}</span>`);
  }
  if (hud.briefAgeSeconds != null) chips.push(`<span class="chip magenta">BRIEF ${fmtAge(hud.briefAgeSeconds)}</span>`);
  chips.push(`<span class="chip">${hud.records} RECORDS</span>`);
  chips.push(`<span class="chip">${hud.tilesShown}/${hud.totalVideos} FEEDS</span>`);
  return `<header class="hud"><span class="brand">◉ OVERCAST WALL</span><span class="case" title="${escapeHtml(hud.caseDir)}">CASE ▸ ${escapeHtml(hud.caseName)}</span>${chips.join("")}<span class="clock" id="clock"></span></header>`;
}

const LIVE_LABEL: Record<WallTile["mode"], string> = { video: "● LIVE", still: "● STILL", down: "● DOWN" };
const COVER_LABEL: Record<"still" | "down", string> = { still: "STILL", down: "NO SIGNAL" };

function renderTile(tile: WallTile, index: number): string {
  const cam = `CAM ${String(index + 1).padStart(2, "0")}`;
  const openUrl = tile.fileUrl ? `${tile.fileUrl}#t=${tile.anchor.start}` : "";
  const media =
    tile.mode === "video"
      ? `<video muted playsinline loop preload="metadata" data-src="${escapeHtml(tile.fileUrl)}" data-start="${tile.anchor.start}" data-end="${tile.anchor.end}"></video>
  <div class="cover errcover"><span class="nosig-label">NO SIGNAL</span></div>`
      : `${tile.poster ? `<img class="poster" alt="${escapeHtml(tile.title)}" src="${escapeHtml(tile.poster)}">` : `<div class="static"></div>`}
  <div class="cover"><span class="nosig-label">${COVER_LABEL[tile.mode]}</span></div>`;
  const badges = (["watch", "listen", "see", "face"] as const)
    .map((k) => `<b class="${tile.coverage[k] ? "on" : ""}" title="${k}">${k[0].toUpperCase()}</b>`)
    .join("");
  const recIds = tile.recordIds.slice(0, 8).map(escapeHtml).join(", ");
  return `<figure class="tile ${tile.mode}" data-ref="${escapeHtml(tile.ref)}"${openUrl ? ` data-open="${escapeHtml(openUrl)}"` : ""}>
  ${media}
  <div class="tile-top"><span>${cam}</span><span>@ ${fmtTime(tile.anchor.at)}</span><span class="live">${LIVE_LABEL[tile.mode]}</span></div>
  <figcaption class="lower">
    <span class="title">${escapeHtml(tile.title)}</span>
    <span class="badges">${badges}</span>
    ${tile.faceCount ? `<span class="faces">FACES ${tile.faceCount}</span>` : ""}
    ${tile.openFindings ? `<span class="find">FND ${tile.openFindings}</span>` : ""}
    <span class="age">${fmtAge(tile.ageSeconds)}</span>
  </figcaption>
  <div class="intel">
    ${tile.summary ? `<p class="sum">${escapeHtml(tile.summary)}</p>` : ""}
    <div class="kv">ref ${escapeHtml(tile.ref)}</div>
    <div class="kv">anchor ${tile.anchor.source} @ ${fmtTime(tile.anchor.at)} · loop ${fmtTime(tile.anchor.start)}–${fmtTime(tile.anchor.end)}${tile.duration ? ` · dur ${fmtTime(tile.duration)}` : ""}</div>
    ${tile.sourceType ? `<div class="kv">source ${escapeHtml(tile.sourceType)}</div>` : ""}
    <div class="kv">records ${recIds}${tile.recordIds.length > 8 ? " …" : ""}</div>
    <code>overcast view ${escapeHtml(shellQuote(tile.ref))} --at ${tile.anchor.span ? `${tile.anchor.start}-${tile.anchor.end}` : Math.round(tile.anchor.at)}</code>
  </div>
</figure>`;
}

function fmtTime(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function fmtAge(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function shellQuote(s: string): string {
  return /^[\w./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// Structural stylesheet shared by both themes (palette comes from the skin).
const WALL_BASE_CSS = `*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.4;overflow:hidden;display:flex;flex-direction:column}
.hud{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
.brand{color:var(--green);font-weight:700;letter-spacing:1px}.case{color:var(--cyan)}
.chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--green);background:var(--bg);white-space:nowrap}
.chip.bad{color:var(--bad)}.chip.amber{color:var(--amber)}.chip.cyan{color:var(--cyan)}.chip.magenta{color:var(--magenta)}
.clock{margin-left:auto;color:var(--amber)}
.wall{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(var(--cols,4),minmax(0,1fr));gap:10px;padding:10px;align-content:start}
.tile{position:relative;margin:0;aspect-ratio:16/9;background:#000;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.tile[data-open]{cursor:pointer}
.tile video,.tile img.poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
.tile-top{position:absolute;top:0;left:0;right:0;display:flex;gap:8px;padding:6px 8px;font-size:10px;color:var(--cyan);background:linear-gradient(180deg,rgba(0,0,0,.7),transparent)}
.tile-top .live{margin-left:auto;color:var(--green)}
.tile.still .tile-top .live{color:var(--amber)}.tile.down .tile-top .live,.tile.err .tile-top .live{color:var(--bad)}
.lower{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:8px;padding:6px 8px;background:linear-gradient(0deg,rgba(0,0,0,.85),transparent);font-size:11px}
.lower .title{color:var(--text);font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.badges{display:inline-flex;gap:2px}
.badges b{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:3px;color:var(--muted);font-size:9px;font-weight:400;background:var(--bg)}
.badges b.on{color:var(--green);border-color:var(--green);font-weight:700}
.lower .faces{color:var(--magenta)}.lower .find{color:var(--bad)}.lower .age{color:var(--muted)}
.static{position:absolute;inset:0;background:repeating-linear-gradient(0deg,#0c0f10 0 2px,#181d1f 2px 4px)}
.cover{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.nosig-label{color:var(--bad);letter-spacing:4px;font-size:14px}
.tile.still .cover:not(.errcover) .nosig-label{color:var(--amber)}
.errcover{display:none;background:repeating-linear-gradient(0deg,#0c0f10 0 2px,#181d1f 2px 4px)}
.tile.err .errcover{display:flex}
.intel{position:absolute;inset:0;padding:10px;background:rgba(0,0,0,.9);opacity:0;transition:opacity .15s;overflow:auto}
.tile:hover .intel{opacity:1}
.intel .sum{margin:0 0 8px;white-space:pre-wrap;word-break:break-word}
.intel .kv{color:var(--muted);font-size:10px;margin:2px 0;word-break:break-word}
.intel code{display:block;margin-top:8px;color:var(--cyan);word-break:break-all}
.start{position:fixed;right:12px;bottom:12px;padding:8px 14px;border:1px solid var(--amber);color:var(--amber);background:var(--panel);border-radius:6px;cursor:pointer;display:none;z-index:10}
body.stalled .start{display:block}
.empty{grid-column:1/-1;display:flex;align-items:center;justify-content:center;min-height:40vh;color:var(--muted);letter-spacing:2px}`;

// CSI skin: the csiShell palette (src/report/html.ts) + neon glow + static flicker.
const CSI_SKIN = `:root{color-scheme:dark;--bg:#050708;--panel:#0b1214;--panel2:#10181b;--line:#1f3a3b;--green:#5cff96;--cyan:#38e8ff;--amber:#ffd166;--magenta:#ff4fd8;--text:#d8ffe4;--muted:#8aa69d;--bad:#ff6b6b}
body{background:radial-gradient(circle at top left,#10241b 0,#050708 34rem)}
.hud{background:linear-gradient(180deg,var(--panel),var(--panel2));box-shadow:0 0 24px rgba(56,232,255,.06)}
.tile{box-shadow:0 0 0 1px rgba(92,255,150,.04),0 0 24px rgba(56,232,255,.06)}
.tile-top{text-shadow:0 0 6px #000}
.nosig-label{text-shadow:0 0 10px currentColor}
@keyframes flicker{0%{opacity:.82}50%{opacity:1}100%{opacity:.92}}
.static,.tile.err .errcover{animation:flicker .4s steps(2) infinite}`;

const PLAIN_SKIN = `:root{color-scheme:dark;--bg:#101214;--panel:#16191c;--panel2:#16191c;--line:#33393d;--green:#c8d0d4;--cyan:#9fb2bd;--amber:#c9b458;--magenta:#b48ead;--text:#d5d9dc;--muted:#7d878d;--bad:#d97b7b}`;

// Inline player logic (no template interpolation — keep this plain JS).
const WALL_JS = `(function(){
var tiles = Array.prototype.slice.call(document.querySelectorAll(".tile"));
var vids = [];
function markStalled(){ document.body.classList.add("stalled"); }
tiles.forEach(function(tile, i){
  var open = tile.getAttribute("data-open");
  if (open) tile.addEventListener("click", function(){ window.open(open); });
  var v = tile.querySelector("video");
  if (!v) return;
  vids.push(v);
  var start = parseFloat(v.getAttribute("data-start")) || 0;
  var end = parseFloat(v.getAttribute("data-end")) || 0;
  v.addEventListener("loadedmetadata", function(){
    // clamp the window to the REAL duration (the model's duration is advisory
    // and may be unknown for capture/enhance-only feeds)
    if (isFinite(v.duration) && v.duration > 0) {
      end = Math.min(end, v.duration);
      if (end <= start) { start = 0; end = Math.min(8, v.duration); }
    }
    // moment loop: hold the evidence window, not the whole file. Installed only
    // AFTER the clamp so the handlers can never act on a window that outruns
    // the real clip (loadedmetadata fires once per src attach).
    if (end > start) {
      v.addEventListener("timeupdate", function(){
        if (v.currentTime >= end || v.currentTime < start - 0.75) v.currentTime = start;
      });
      v.addEventListener("ended", function(){ v.currentTime = start; v.play().catch(function(){}); });
    }
    try { v.currentTime = start; } catch (e) {}
  });
  v.addEventListener("error", function(){ tile.classList.add("err"); });
  // staggered attach avoids a simultaneous decode burst across the grid
  setTimeout(function(){
    v.src = v.getAttribute("data-src");
    v.play().catch(markStalled);
  }, i * 150);
});
if ("IntersectionObserver" in window) {
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      var v = e.target.querySelector("video");
      if (!v || !v.src) return;
      if (e.intersectionRatio >= 0.25) { if (!document.body.classList.contains("stalled")) v.play().catch(function(){}); }
      else v.pause();
    });
  }, { threshold: [0, 0.25] });
  tiles.forEach(function(t){ io.observe(t); });
}
var startBtn = document.getElementById("start");
if (startBtn) startBtn.addEventListener("click", function(){
  document.body.classList.remove("stalled");
  vids.forEach(function(v){ if (v.src) v.play().catch(function(){}); });
});
var clock = document.getElementById("clock");
if (clock) { var tick = function(){ clock.textContent = new Date().toLocaleTimeString(); }; tick(); setInterval(tick, 1000); }
})();`;
