// The situation model: one pure pass over the case records that assembles every
// panel of the live page — wall tiles (reusing report/wall.ts's model so anchors
// / coverage / ranking can't drift from the static wall), the reverse-chron
// feed of scan hits, map points (reusing report/map.ts), and the freshest still
// per recapture source. No I/O beyond an injectable fileExists — offline
// unit-testable like the report models. The server (src/situation/server.ts)
// owns URL mapping (`/media/<id>`) and the remote-media policy; the model only
// says WHERE each piece of media lives (local path vs remote URL).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isReady, recordTimeMs, stripUrlTail, type OvercastRecord } from "../record.js";
import { buildWallModel, type WallTile } from "../report/wall.js";
import { buildMapModel } from "../report/map.js";
import { parseSince } from "../providers/memory/local.js";
import type { SourceEntry } from "../state/source.js";
import type { SituationConfig } from "./state.js";
import type {
  SituationBounds,
  SituationConfigWire,
  SituationHud,
  SituationPanel,
} from "./wire.js";

/** Where a piece of media lives — at most one side set. The server turns
 *  `local` into an authenticated `/media/<id>` URL and applies the remote-embed
 *  policy (OVERCAST_REPORT_REMOTE_MEDIA) to `remote`. */
export interface SituationMediaRef {
  local?: string;
  remote?: string;
}

export interface SituationTileModel {
  ref: string;
  media: SituationMediaRef | null;
  /** local poster-frame path — filled by the server's best-effort ffmpeg pass */
  poster: SituationMediaRef | null;
  mode: WallTile["mode"];
  title: string;
  duration: number | null;
  anchor: WallTile["anchor"];
  coverage: WallTile["coverage"];
  faceCount: number;
  openFindings: number;
  summary: string;
  sourceType: string | null;
  sourceUrl: string | null;
  sourceAuthor: string | null;
  lastRecordTime: string | null;
  ageSeconds: number | null;
}

export interface SituationFeedModel {
  recordId: string;
  time: string | null;
  source: string | null;
  sourceId: string | null;
  title: string;
  url: string | null;
  snippet: string | null;
  published: string | null;
  author: string | null;
  thumb: SituationMediaRef | null;
  state: string;
  error: string | null;
}

export interface SituationPointModel {
  recordId: string;
  verb: string;
  source: string | null;
  lat: number;
  lng: number;
  place: string | null;
  time: string | null;
  summary: string;
  ref: string | null;
  url: string | null;
  thumb: SituationMediaRef | null;
  track: string | null;
  heading: number | null;
  velocity: number | null;
  onGround: boolean | null;
  label: string | null;
}

export interface SituationStillModel {
  key: string;
  recordId: string;
  title: string;
  source: string | null;
  url: string | null;
  media: SituationMediaRef | null;
  time: string | null;
}

export interface SituationModel {
  generatedAt: string;
  panels: SituationPanel[];
  config: SituationConfigWire;
  hud: SituationHud;
  tiles: SituationTileModel[];
  feed: SituationFeedModel[];
  points: SituationPointModel[];
  bounds: SituationBounds | null;
  stills: SituationStillModel[];
  sources: Array<{ id: string; type: string; ref: string; enabled: boolean }>;
}

export interface BuildSituationOptions {
  caseName: string;
  caseDir: string;
  config: SituationConfig;
  sources: SourceEntry[];
  /** injectable clock/fs for tests */
  now?: number;
  fileExists?: (path: string) => boolean;
}

// Per-panel caps. `config.limit` maps to the wall tile cap (wall --limit
// semantics); the other panels have fixed sensible ceilings.
const DEFAULT_TILE_LIMIT = 12;
const FEED_CAP = 60;
const POINTS_CAP = 500;
const STILLS_CAP = 12;

const REMOTE_RE = /^https?:\/\//i;
const IMAGE_RE = /\.(avif|bmp|gif|jpe?g|png|webp)$/i;

// Source classes that drive panel auto-selection ("takes a guess based on the
// sources you've configured") — a configured source lights its panel even
// before the first hit lands, so the operator sees the empty panel filling in.
const MEDIA_SOURCE_TYPES = new Set([
  "youtube", "tiktok", "x", "twitter", "instagram", "telegram", "dl", "gdelttv",
  "lens", "yandeximg", "facesearch", "local", "folder", "fixture",
]);
const GPS_SOURCE_TYPES = new Set(["overpass", "firms", "flights"]);
const STILL_SOURCE_TYPES = new Set(["webcam", "browser"]);

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function mediaRefFor(ref: string | null | undefined, fileExists: (p: string) => boolean): SituationMediaRef | null {
  if (!ref) return null;
  if (REMOTE_RE.test(ref)) return { remote: ref };
  return fileExists(ref) ? { local: ref } : null;
}

export function buildSituationModel(records: OvercastRecord[], opts: BuildSituationOptions): SituationModel {
  const now = opts.now ?? Date.now();
  // Resolve every media ref against the CASE DIR (not the process CWD) before
  // checking presence, so a relative / case-relative ref is found regardless of
  // where the serve process was launched — matching SituationServer.toWire
  // (Bugbot #98/med). One wrapper feeds all media checks below (wall tile mode,
  // feed/map thumbs, stills); the injectable fileExists (tests) is wrapped, not
  // bypassed.
  const rawExists = opts.fileExists ?? existsSync;
  const fileExists = (p: string) => rawExists(resolve(opts.caseDir, p));
  const cfg = opts.config;
  const sinceCutoff = cfg.since ? parseSince(cfg.since) ?? undefined : undefined;
  const tileLimit = cfg.limit && cfg.limit > 0 ? Math.floor(cfg.limit) : DEFAULT_TILE_LIMIT;
  const sourceFilter = cfg.source ? cfg.source.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;

  // ref → originating post URL + author, lifted from provenance (watch/capture
  // carry payload.source_url/source_author) or the scan hit's own url. Lets a
  // wall tile link back to the tweet/video/article it came from.
  const sourceUrlByRef = new Map<string, string>();
  const sourceAuthorByRef = new Map<string, string>();
  for (const r of records) {
    const ref = r.media?.ref;
    if (!ref) continue;
    const p = payloadOf(r);
    const url = str(p.source_url) ?? (r.verb === "scan" ? str(p.url) : null);
    if (url && !sourceUrlByRef.has(ref)) sourceUrlByRef.set(ref, url);
    const author = str(p.source_author) ?? (r.verb === "scan" ? str(p.author) : null);
    if (author && !sourceAuthorByRef.has(ref)) sourceAuthorByRef.set(ref, author);
  }
  const recById = new Map(records.map((r) => [r.id, r] as const));
  // url → the scan hit's human title (e.g. a webcam's name), so a recapture's
  // still cell reads "Paris: Quartier de Chaillot" not the imgproxy URL.
  const titleByUrl = new Map<string, string>();
  for (const r of records) {
    if (r.verb !== "scan") continue;
    const p = payloadOf(r);
    const u = str(p.url);
    const t = str(p.title);
    if (u && t && !titleByUrl.has(u)) titleByUrl.set(u, t);
  }

  // The `--source` filter (types + registered ids) is applied UNIFORMLY across
  // every panel (Bugbot: it used to differ — wall took only the first entry, map
  // was unfiltered, stills ignored source ids). One predicate, fed the right
  // source-type + source-id for each panel's record kind.
  const matchesSourceFilter = (source: string | null, sourceId: string | null): boolean => {
    if (!sourceFilter?.length) return true;
    return sourceFilter.includes((source ?? "").toLowerCase()) || (sourceId != null && sourceFilter.includes(sourceId.toLowerCase()));
  };
  const withinSince = (r: OvercastRecord): boolean => {
    if (sinceCutoff == null) return true;
    const t = recordTimeMs(r);
    return Number.isNaN(t) || t >= sinceCutoff; // undated kept, matching wall/map
  };
  // ref → the registered source id that produced it. Captures don't carry
  // source_id, so trace capture.source_record → the scan hit's source_id; also
  // accept a direct source_id on any record referencing the ref.
  const scanById = new Map(records.filter((r) => r.verb === "scan").map((r) => [r.id, r] as const));
  const sourceIdByRef = new Map<string, string>();
  for (const r of records) {
    const ref = r.media?.ref;
    if (!ref || sourceIdByRef.has(ref)) continue;
    const p = payloadOf(r);
    const direct = str(p.source_id);
    const viaScan = str(p.source_record) ? str(payloadOf(scanById.get(str(p.source_record)!) ?? ({} as OvercastRecord)).source_id) : null;
    const sid = direct ?? viaScan;
    if (sid) sourceIdByRef.set(ref, sid);
  }
  const sourceIdOf = (rec: OvercastRecord | undefined): string | null => {
    if (!rec) return null;
    return str(payloadOf(rec).source_id) ?? (rec.media?.ref ? sourceIdByRef.get(rec.media.ref) ?? null : null);
  };

  // --- wall tiles (shared model with the static wall verb) --------------------
  // Build ALL tiles (no source cap in the shared model), then apply the full
  // source filter, THEN take the top `tileLimit` — so filtering picks the top-N
  // of the MATCHING set, not the first-N-then-filter.
  const wall = buildWallModel(records, {
    caseName: opts.caseName,
    caseDir: opts.caseDir,
    limit: Number.MAX_SAFE_INTEGER,
    sinceCutoff,
    now,
    fileExists,
  });
  // the source-matching wall universe (before the tileLimit slice) — its length
  // is the HUD's totalVideos so "X of Y feeds" reflects the FILTERED set, not the
  // unfiltered wall.hud counts (Bugbot #98/med).
  const wallMatching = wall.tiles.filter((t) => matchesSourceFilter(t.sourceType, sourceIdByRef.get(t.ref) ?? null));
  const tiles: SituationTileModel[] = wallMatching
    .slice(0, tileLimit)
    .map((t) => ({
      ref: t.ref,
      media: t.mode === "down" ? null : mediaRefFor(t.ref, fileExists),
      poster: null,
      mode: t.mode,
      title: t.title,
      duration: t.duration,
      anchor: t.anchor,
      coverage: t.coverage,
      faceCount: t.faceCount,
      openFindings: t.openFindings,
      summary: t.summary,
      sourceType: t.sourceType,
      sourceUrl: sourceUrlByRef.get(t.ref) ?? null,
      sourceAuthor: sourceAuthorByRef.get(t.ref) ?? null,
      lastRecordTime: t.lastRecordTime,
      ageSeconds: t.ageSeconds,
    }));

  // --- feed: scan hits newest-first (incl. error / cred-gap rows) -------------
  const feed: SituationFeedModel[] = records
    .filter((r) => r.verb === "scan" && payloadOf(r).op !== "pull_progress" && withinSince(r))
    .map((r) => {
      const p = payloadOf(r);
      const item: SituationFeedModel = {
        recordId: r.id,
        time: str(r.meta?.time),
        source: str(p.source),
        sourceId: str(p.source_id),
        title: str(p.title) ?? str(p.url) ?? str(p.query) ?? "(untitled hit)",
        url: str(p.url),
        snippet: str(p.snippet),
        published: str(p.published),
        author: str(p.author),
        thumb: mediaRefFor(str(p.thumb), fileExists),
        state: r.state ?? "ready",
        error: r.error ?? null,
      };
      return item;
    })
    .filter((i) => matchesSourceFilter(i.source, i.sourceId))
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))
    .slice(0, FEED_CAP);

  // --- map points (shared model with the map verb) + flight tracks ------------
  // Pre-filter the RECORDS by --source before buildMapModel, so its points AND
  // its bounds are computed over the same filtered set — otherwise bounds would
  // frame points the filter hid (Bugbot #98/med). No filter → all records.
  const mapRecords = sourceFilter?.length
    ? records.filter((r) => {
        const src = str(payloadOf(r).source) ?? (r.verb === "scan" ? null : r.verb);
        return matchesSourceFilter(src, sourceIdOf(r));
      })
    : records;
  const mapModel = buildMapModel(mapRecords, {
    caseName: opts.caseName,
    caseDir: opts.caseDir,
    limit: POINTS_CAP,
    sinceCutoff,
    now,
    thumbs: false,
  });
  // track key per record: flights hits carry icao24/callsign in the payload —
  // consecutive monitor passes then draw as a path instead of loose markers.
  const trackOf = new Map<string, string>();
  for (const r of records) {
    const p = payloadOf(r);
    const key = str(p.icao24) ?? str(p.callsign);
    if (key) trackOf.set(r.id, key.toLowerCase());
  }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const points: SituationPointModel[] = mapModel.points
    .map((p) => {
      const pl = payloadOf(recById.get(p.recordId) ?? ({} as OvercastRecord));
      return {
      recordId: p.recordId,
      verb: p.verb,
      source: str(pl.source) ?? (p.verb === "scan" ? null : p.verb),
      lat: p.lat,
      lng: p.lng,
      place: p.place,
      time: p.time,
      summary: p.summary,
      ref: p.ref,
      url: str(pl.url),
      thumb: p.ref && IMAGE_RE.test(stripUrlTail(p.ref)) ? mediaRefFor(p.ref, fileExists) : null,
      track: trackOf.get(p.recordId) ?? null,
      heading: num(pl.true_track),
      velocity: num(pl.velocity),
      onGround: typeof pl.on_ground === "boolean" ? pl.on_ground : null,
      label: str(pl.callsign) ?? str(pl.title),
    };
  });

  // --- stills: freshest capture per recapture-ish source ----------------------
  const stillCandidates = records.filter((r) => {
    if (!isReady(r) || !r.media?.ref || !withinSince(r)) return false;
    if (r.verb === "screenshot") return IMAGE_RE.test(stripUrlTail(r.media.ref));
    if (r.verb !== "capture") return false;
    const source = str(payloadOf(r).source);
    return source != null && STILL_SOURCE_TYPES.has(source);
  });
  const byKey = new Map<string, OvercastRecord>();
  for (const r of stillCandidates) {
    const p = payloadOf(r);
    const key = str(p.url) ?? str(p.source_ref) ?? r.media!.ref;
    const prev = byKey.get(key);
    const t = recordTimeMs(r);
    const prevT = prev ? recordTimeMs(prev) : NaN;
    if (!prev || Number.isNaN(prevT) || (!Number.isNaN(t) && t >= prevT)) byKey.set(key, r);
  }
  const stills: SituationStillModel[] = [...byKey.entries()]
    // apply the full --source filter (type + id) on the record, before mapping
    .filter(([, r]) => matchesSourceFilter(str(payloadOf(r).source), sourceIdOf(r)))
    .map(([key, r]) => {
      const p = payloadOf(r);
      const source = str(p.source) ?? (r.verb === "screenshot" ? "screenshot" : null);
      // click-through prefers the source PAGE (windy.com/webcams/…) over the raw
      // image; the scan hit that named this cam is keyed by that page url, so the
      // webcam's NAME ("Paris: Palais d'Iéna") joins off source_url, not the
      // imgproxy .jpg. Fall back to the capture url for non-webcam stills.
      const srcUrl = str(p.source_url);
      const capUrl = str(p.url);
      const url = srcUrl ?? capUrl;
      const scanTitle = (srcUrl ? titleByUrl.get(srcUrl) : undefined) ?? (capUrl ? titleByUrl.get(capUrl) : undefined);
      const title = scanTitle ?? str(p.title) ?? str(p.source_text) ?? url ?? key;
      return {
        key,
        recordId: r.id,
        title,
        source,
        url,
        media: mediaRefFor(r.media!.ref, fileExists),
        time: str(r.meta?.time),
      };
    })
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""))
    .slice(0, STILLS_CAP);

  // --- panels ------------------------------------------------------------------
  const enabledTypes = new Set(opts.sources.filter((s) => s.enabled).map((s) => s.type));
  const panels: SituationPanel[] = cfg.panels?.length
    ? [...cfg.panels]
    : resolvePanels({ tiles, points, stills, enabledTypes });

  return {
    generatedAt: new Date(now).toISOString(),
    panels,
    config: {
      panels: cfg.panels?.length ? [...cfg.panels] : null,
      source: cfg.source ?? null,
      since: cfg.since ?? null,
      limit: cfg.limit ?? null,
      theme: cfg.theme === "plain" ? "plain" : "csi",
      query: cfg.query ?? null,
    },
    hud: {
      caseName: wall.hud.caseName,
      caseDir: wall.hud.caseDir,
      generatedAt: wall.hud.generatedAt,
      records: wall.hud.records,
      counts: wall.hud.counts,
      openFindings: wall.hud.openFindings,
      suggestedFindings: wall.hud.suggestedFindings,
      lastScans: wall.hud.lastScans,
      monitor: wall.hud.monitor,
      briefAgeSeconds: wall.hud.briefAgeSeconds,
      // "X of Y feeds" reflects the FILTERED wall: shown = the sliced tiles,
      // total = the source-matching universe (Bugbot #98/med — not wall.hud's
      // unfiltered counts).
      tilesShown: tiles.length,
      totalVideos: wallMatching.length,
    },
    tiles,
    feed,
    points,
    bounds: mapModel.bounds,
    stills,
    sources: opts.sources.map((s) => ({ id: s.id, type: s.type, ref: s.ref, enabled: s.enabled })),
  };
}

/** Auto panel selection: a panel is shown when it has content OR when a
 *  configured source of its class will feed it. The feed is always on — every
 *  source produces hits, and it's the pulse of the case. */
function resolvePanels(input: {
  tiles: SituationTileModel[];
  points: SituationPointModel[];
  stills: SituationStillModel[];
  enabledTypes: Set<string>;
}): SituationPanel[] {
  const { tiles, points, stills, enabledTypes } = input;
  const has = (set: Set<string>) => [...enabledTypes].some((t) => set.has(t));
  const panels: SituationPanel[] = [];
  if (tiles.length || has(MEDIA_SOURCE_TYPES)) panels.push("wall");
  panels.push("feed");
  if (points.length || has(GPS_SOURCE_TYPES)) panels.push("map");
  if (stills.length || has(STILL_SOURCE_TYPES)) panels.push("stills");
  return panels;
}
