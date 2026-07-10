// The situation model: one pure pass over the case records that assembles every
// panel of the live page — wall tiles (reusing report/wall.ts's model so anchors
// / coverage / ranking can't drift from the static wall), the reverse-chron
// feed of scan hits, map points (reusing report/map.ts), and the freshest still
// per recapture source. No I/O beyond an injectable fileExists — offline
// unit-testable like the report models. The server (src/situation/server.ts)
// owns URL mapping (`/media/<id>`) and the remote-media policy; the model only
// says WHERE each piece of media lives (local path vs remote URL).

import { existsSync } from "node:fs";
import { isReady, recordTimeMs, type OvercastRecord } from "../record.js";
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
  lat: number;
  lng: number;
  place: string | null;
  time: string | null;
  summary: string;
  ref: string | null;
  thumb: SituationMediaRef | null;
  track: string | null;
}

export interface SituationStillModel {
  key: string;
  recordId: string;
  title: string;
  source: string | null;
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
const IMAGE_RE = /\.(avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;

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
  const fileExists = opts.fileExists ?? existsSync;
  const cfg = opts.config;
  const sinceCutoff = cfg.since ? parseSince(cfg.since) ?? undefined : undefined;
  const tileLimit = cfg.limit && cfg.limit > 0 ? Math.floor(cfg.limit) : DEFAULT_TILE_LIMIT;
  const sourceFilter = cfg.source ? cfg.source.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;

  // --- wall tiles (shared model with the static wall verb) --------------------
  const wall = buildWallModel(records, {
    caseName: opts.caseName,
    caseDir: opts.caseDir,
    limit: tileLimit,
    // wall's --source is a single type; apply the first entry there and the full
    // list to the feed/stills filters below.
    source: sourceFilter?.[0],
    sinceCutoff,
    now,
    fileExists,
  });
  const tiles: SituationTileModel[] = wall.tiles.map((t) => ({
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
    lastRecordTime: t.lastRecordTime,
    ageSeconds: t.ageSeconds,
  }));

  const matchesSourceFilter = (source: string | null, sourceId: string | null): boolean => {
    if (!sourceFilter?.length) return true;
    return sourceFilter.includes((source ?? "").toLowerCase()) || (sourceId != null && sourceFilter.includes(sourceId.toLowerCase()));
  };
  const withinSince = (r: OvercastRecord): boolean => {
    if (sinceCutoff == null) return true;
    const t = recordTimeMs(r);
    return Number.isNaN(t) || t >= sinceCutoff; // undated kept, matching wall/map
  };

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
  const mapModel = buildMapModel(records, {
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
  const points: SituationPointModel[] = mapModel.points.map((p) => ({
    recordId: p.recordId,
    verb: p.verb,
    lat: p.lat,
    lng: p.lng,
    place: p.place,
    time: p.time,
    summary: p.summary,
    ref: p.ref,
    thumb: p.ref && IMAGE_RE.test(p.ref) ? mediaRefFor(p.ref, fileExists) : null,
    track: trackOf.get(p.recordId) ?? null,
  }));

  // --- stills: freshest capture per recapture-ish source ----------------------
  const stillCandidates = records.filter((r) => {
    if (!isReady(r) || !r.media?.ref || !withinSince(r)) return false;
    if (r.verb === "screenshot") return IMAGE_RE.test(r.media.ref);
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
    .map(([key, r]) => {
      const p = payloadOf(r);
      const source = str(p.source) ?? (r.verb === "screenshot" ? "screenshot" : null);
      return {
        key,
        recordId: r.id,
        title: str(p.title) ?? str(p.url) ?? key,
        source,
        media: mediaRefFor(r.media!.ref, fileExists),
        time: str(r.meta?.time),
      };
    })
    .filter((s) => matchesSourceFilter(s.source, null))
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
      tilesShown: wall.hud.tilesShown,
      totalVideos: wall.hud.totalVideos,
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
