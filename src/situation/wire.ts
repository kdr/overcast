// The situation wire protocol — the stable JSON contract between the situation
// server (src/situation/server.ts) and the live web console (web/situation).
// The console imports these types (type-only, erased at build), so this file is
// the single source of truth for both sides — the same discipline as
// src/chair/wire.ts. Keep it additive: the console may lag the desk binary.
//
// Design note: unlike the chair's incremental transcript stream, the situation
// wire is deliberately SNAPSHOT-shaped — the server publishes a tiny `refresh`
// event when the case store changes and the console refetches `GET /api/state`
// whole, diffing by record id client-side for animations. No incremental state
// machine to drift (the chair's fallback page taught that lesson).

export type SituationPanel = "wall" | "feed" | "map" | "stills";

export const SITUATION_PANELS: readonly SituationPanel[] = ["wall", "feed", "map", "stills"];

/** One SSE event on `GET /events`. `seq` is monotonic and doubles as the SSE
 *  `id:` — reconnecting clients replay everything after their `Last-Event-ID`. */
export type SituationWireEvent =
  | { type: "hello"; seq: number; caseName: string; version: string; clients: number }
  /** The case store (or the active config) changed — refetch `GET /api/state`. */
  | { type: "refresh"; seq: number; generatedAt: string; records: number }
  /** A monitor pass ran inside the serving process (`situation --every`). */
  | { type: "monitor"; seq: number; phase: "start" | "end"; pass: number; newItems?: number; error?: string }
  | { type: "notice"; seq: number; level: "info" | "warning" | "error"; text: string }
  /** The server is shutting down (control stop / Ctrl-C) — the console shows
   *  OFF AIR instead of endlessly reconnecting. */
  | { type: "stopping"; seq: number; reason: string }
  /** The client asked to replay from a seq that fell out of the ring buffer —
   *  it should refetch `GET /api/state` and continue from the stream. */
  | { type: "gap"; seq: number };

// --- snapshot (`GET /api/state`) ----------------------------------------------

/** A wall tile — the live twin of report/wall.ts's WallTile, with media served
 *  over the situation server's authenticated `/media/<id>` route instead of
 *  file:// (a page served from http:// cannot load file:// subresources). */
export interface SituationTile {
  /** the case media ref (stable tile identity; local path or remote URL) */
  ref: string;
  /** `/media/<id>/<name>` for local media; a remote URL only when the desk
   *  opted into remote embeds; null → render the REMOTE OFF / NO SIGNAL cover */
  mediaUrl: string | null;
  mode: "video" | "still" | "down";
  title: string;
  duration: number | null;
  anchor: { at: number; start: number; end: number; source: string; span?: boolean };
  coverage: { watch: boolean; listen: boolean; see: boolean; face: boolean };
  faceCount: number;
  openFindings: number;
  summary: string;
  sourceType: string | null;
  /** the originating post/page URL (tweet / video / article) — click-to-source */
  sourceUrl: string | null;
  /** author/handle of the source post, when known (e.g. an X handle) */
  sourceAuthor: string | null;
  lastRecordTime: string | null;
  ageSeconds: number | null;
  posterUrl: string | null;
}

/** One reverse-chron feed card — a scan/monitor hit (the "latest results /
 *  latest posts on the topic" panel for metadata-only sources). */
export interface SituationFeedItem {
  recordId: string;
  time: string | null;
  /** source type (youtube | web | dork | overpass | …) */
  source: string | null;
  sourceId: string | null;
  title: string;
  url: string | null;
  snippet: string | null;
  published: string | null;
  author: string | null;
  thumbUrl: string | null;
  /** ready | error | needs_credentials — cred gaps surface as feed cards too */
  state: string;
  error: string | null;
}

/** A live map point (any record carrying payload.gps — overpass/firms/flights
 *  scan hits, exif records, chronolocate leads). */
export interface SituationPoint {
  recordId: string;
  verb: string;
  /** source type (flights | overpass | firms | exif …) for color + icon + filter */
  source: string | null;
  lat: number;
  lng: number;
  place: string | null;
  time: string | null;
  summary: string;
  ref: string | null;
  url: string | null;
  thumbUrl: string | null;
  /** track grouping key (flights icao24/callsign) — points sharing a track are
   *  drawn as a polyline, oldest→newest, so `monitor --every` builds a path */
  track: string | null;
  /** heading in degrees (0=N, 90=E) for flight markers — from ADS-B true_track */
  heading: number | null;
  /** ground speed (m/s) and on-ground flag, for the flight marker/tooltip */
  velocity: number | null;
  onGround: boolean | null;
  /** callsign / label (flights) */
  label: string | null;
}

/** The freshest still per recapture-ish source (webcam / browser / screenshot)
 *  — a grid of "current view" cells that swap on every monitor pass. */
export interface SituationStill {
  /** group key (the source URL/ref) — the cell identity across recaptures */
  key: string;
  recordId: string;
  title: string;
  source: string | null;
  /** the source page URL (e.g. the windy.com webcam page) — click-to-source */
  url: string | null;
  mediaUrl: string | null;
  time: string | null;
}

/** Case-state strip — mirrors the wall HUD (built by the same signals/pulse
 *  primitives, so the live page and `wall`/`case status` can't drift). */
export interface SituationHud {
  caseName: string;
  caseDir: string;
  generatedAt: string;
  records: number;
  counts: Record<string, number>;
  openFindings: number;
  suggestedFindings: number;
  lastScans: Array<{ source: string; time: string; ageSeconds: number }>;
  monitor: { time: string; ageSeconds: number; newItems: number } | null;
  briefAgeSeconds: number | null;
  tilesShown: number;
  totalVideos: number;
}

/** The active view config (CLI flags at start, then `situation set` at runtime). */
export interface SituationConfigWire {
  /** explicit panel override; null → panels auto-picked from sources + records */
  panels: SituationPanel[] | null;
  source: string | null;
  since: string | null;
  limit: number | null;
  theme: "plain" | "csi";
  query: string | null;
}

export interface SituationBounds {
  minLat: number;
  minLng: number;
  /** maxLng may exceed 180 for a cluster straddling the antimeridian — unwrap a
   *  point lng < minLng by +360 (same convention as report/map.ts). */
  maxLat: number;
  maxLng: number;
}

/** `GET /api/state` — everything the console needs to render, whole. */
export interface SituationSnapshot {
  seq: number;
  version: string;
  caseName: string;
  caseDir: string;
  generatedAt: string;
  /** resolved active panels, in render order */
  panels: SituationPanel[];
  config: SituationConfigWire;
  hud: SituationHud;
  tiles: SituationTile[];
  feed: SituationFeedItem[];
  points: SituationPoint[];
  bounds: SituationBounds | null;
  stills: SituationStill[];
  /** monitor cadence owned by the serving process; null → pure viewer (the
   *  store is fed by a separate `monitor --every` / the agent) */
  monitor: { every: string | null; passes: number; lastPassAt: string | null; running: boolean } | null;
  sources: Array<{ id: string; type: string; ref: string; enabled: boolean }>;
  /** server store/control poll cadence (seconds) — shown in the HUD sync chip */
  pollSeconds: number;
}
