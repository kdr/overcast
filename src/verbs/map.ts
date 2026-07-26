// ---- map (evidence map) -----------------------------------------------------
// One HTML page plotting every case record that carries GPS coordinates
// (primarily `exif`). Model/rendering live in src/report/map.ts; this verb owns
// validation, the file write, and launching — mirroring `wall` (verbs/wall.ts).

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeRecord, errRecord, type OvercastRecord } from "../record.js";
import { openHtmlPlayer } from "../media/view.js";
import { normalizeHtmlTheme } from "../report/html.js";
import { buildMapModel, renderMapHtml } from "../report/map.js";
import { parseSince } from "../providers/memory/local.js";
import { resolveSpatialFlags } from "./geofence.js";
import type { VerbSpec } from "../registry/types.js";

// Sentinel default: an unset --export resolves against the case's mediaDir (like
// wall.html / view.html), NOT the cwd.
const MAP_DEFAULT_EXPORT = ".overcast/media/map.html";

const err = (message: string): OvercastRecord => errRecord("map", message);

export const mapVerb: VerbSpec = {
  name: "map",
  group: "inspect",
  summary: "Plot every case record carrying GPS coordinates on a self-contained HTML map.",
  description:
    "Gathers all case records with payload.gps{lat,lng} (primarily `exif`; any record qualifies) and renders a " +
    "self-contained HTML map — one marker per point with its record id, media thumbnail, geocoded place (when " +
    "`exif --geocode` set it), and capture time, linking back to the source. Online mode fetches OSM raster tiles " +
    "in the browser at view time (no CDN dependency; the map JS is inlined); --offline degrades to a coordinate " +
    "scatter with per-point openstreetmap.org links and no network egress. --near <lat,lng> (--radius meters, " +
    "default 500) or --bbox <minLat,minLng,maxLat,maxLng> spatially filter the plotted points — the same fence " +
    "semantics as `geofence`. --no-open writes the map and emits its " +
    "path instead of launching. Live tiles reveal the viewer's IP + the investigated location to OpenStreetMap.",
  args: [],
  flags: [
    { name: "limit", summary: "Max points, most-recent first", type: "number", default: 500 },
    { name: "since", summary: "Only records since (e.g. 24h, 7d, 2026-06-01)", type: "string" },
    { name: "near", summary: "Only points within --radius meters of 'lat,lng'", type: "string" },
    { name: "radius", summary: "Radius in meters around --near (default 500)", type: "number" },
    { name: "bbox", summary: "Only points inside 'minLat,minLng,maxLat,maxLng' (inclusive, non-wrapping)", type: "string" },
    { name: "offline", summary: "No tile fetch: coordinate scatter + openstreetmap.org links only", type: "boolean" },
    { name: "export", summary: "Map HTML path", type: "string", default: MAP_DEFAULT_EXPORT },
    { name: "no-open", summary: "Write the map but don't launch it", type: "boolean" },
    { name: "theme", summary: "HTML theme: plain | csi", type: "string", choices: ["plain", "csi"], default: "plain" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.map",
  providerKey: "map",
  run: async (ctx) => {
    const theme = normalizeHtmlTheme(ctx.opts.theme);
    if (!theme) return [err(`invalid --theme '${ctx.opts.theme}' (expected plain or csi)`)];
    let limit = 500;
    if (ctx.opts.limit != null) {
      const n = Number(ctx.opts.limit);
      if (!Number.isFinite(n) || n <= 0) return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
      limit = Math.floor(n);
    }
    let sinceCutoff: number | undefined;
    if (ctx.opts.since != null) {
      const cutoff = parseSince(String(ctx.opts.since));
      if (cutoff == null) return [err(`invalid --since: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
      sinceCutoff = cutoff;
    }
    // --near/--radius/--bbox: the shared spatial-flag trio (geofence.ts owns the
    // resolution so the two verbs' fence semantics can't drift). Optional here.
    const spatialResolved = resolveSpatialFlags(ctx.opts);
    if (spatialResolved.error) return [err(spatialResolved.error)];
    const spatial = spatialResolved.spatial;
    const offline = ctx.opts.offline === true;
    const rawExport = ctx.opts.export != null ? String(ctx.opts.export) : MAP_DEFAULT_EXPORT;
    const htmlPath = rawExport === MAP_DEFAULT_EXPORT ? join(ctx.case.mediaDir, "map.html") : resolve(rawExport);

    const info = ctx.case.exists() ? ctx.case.info() : { name: "case" };
    const model = buildMapModel(ctx.case.records(), {
      caseName: info.name,
      caseDir: ctx.case.dir,
      limit,
      sinceCutoff,
      spatial,
    });

    // nothing to map → transient pending guidance, no artifact (wall precedent)
    if (model.points.length === 0) {
      // distinguish "no GPS at all" from "GPS records exist but were filtered out"
      // so the guidance points at the actual problem (like wall's empty-case note).
      // Distinguish three empty cases so the guidance points at the ACTUAL filter:
      // no gps at all; gps records excluded by the spatial fence (widen --near/--bbox);
      // or gps records inside the fence but excluded by the time window (widen/drop
      // --since/--until — widening the fence can't recover those). Mirrors geofence.
      const plural = model.gpsTotal === 1 ? "" : "s";
      const note =
        model.gpsTotal === 0
          ? "no GPS-bearing records — run `exif <media>` on media with embedded GPS (a phone photo, a geotagged clip)"
          : spatial && model.spatialPassing === 0
            ? `${model.gpsTotal} GPS-bearing record${plural} in the case, but none fall inside --near/--bbox — widen (or drop) the fence`
            : spatial
              ? `${model.spatialPassing} record${model.spatialPassing === 1 ? "" : "s"} fall inside the fence but outside the --since/--until window — widen (or drop) the time window`
              : `${model.gpsTotal} GPS-bearing record${plural} in the case, but all fall outside the --since/--until window — widen (or drop) it`;
      return [
        makeRecord({
          verb: "map",
          format: "json",
          payload: { mode: "map", viewer: null, points: 0, gps_total: model.gpsTotal, note },
          meta: { transient: true },
          state: "pending",
        }),
      ];
    }

    const noOpen = ctx.opts["no-open"] === true;
    writeFileSync(htmlPath, renderMapHtml(model, theme, { offline }), "utf8");
    if (!noOpen) openHtmlPlayer(htmlPath);

    return [
      makeRecord({
        verb: "map",
        format: "json",
        payload: {
          mode: "map",
          viewer: htmlPath,
          theme,
          offline,
          opened: !noOpen,
          points: model.points.length,
          total: model.total,
          bounds: model.bounds,
          point_refs: model.points.map((p) => ({
            record_id: p.recordId,
            verb: p.verb,
            lat: p.lat,
            lng: p.lng,
            place: p.place,
            at: p.at,
            ref: p.ref,
          })),
        },
        // no record-level media: a map spans many refs (point_refs carries them)
        meta: { provider: "map", case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};
