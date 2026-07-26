// ---- geofence (spatial + time query) ----------------------------------------
// The geofence-warrant trope: every case record whose payload.gps falls inside a
// radius or box AND whose capture time sits in a window. A pure read over
// ctx.case.records() — no network, no provider — modeled on map/devices. Any
// gps-bearing record qualifies (`exif`, and the geo sources dispatch/firms/
// flights/overpass). The result is a rollup VIEWER record (OPERATIONAL_VERBS,
// record.ts): it restates evidence and must never be re-cited as evidence.

import { errRecord, isReady, makeRecord, recordCaptureTimeMs, recordStub, type OvercastRecord } from "../record.js";
import { parseBboxArg, parseLatLngArg, validLatLng, inBbox, inRadius, type GeoBbox, type GeoPoint } from "../geo.js";
import { parseSince } from "../providers/memory/local.js";
import type { VerbSpec } from "../registry/types.js";

const DEFAULT_RADIUS_M = 500;

export interface SpatialQuery {
  center?: GeoPoint;
  radiusMeters?: number;
  bbox?: GeoBbox;
}

/** Resolve the shared --near/--radius/--bbox flag trio (geofence + map) into ONE
 *  spatial query, or a user-facing error. --near and --bbox are mutually
 *  exclusive; --radius rides --near (default 500 m). Neither given → {} (the
 *  map treats spatial as optional; geofence requires it at the call site). */
export function resolveSpatialFlags(opts: Record<string, string | number | boolean | undefined>): { spatial?: SpatialQuery; error?: string } {
  const nearRaw = opts.near != null ? String(opts.near) : "";
  const bboxRaw = opts.bbox != null ? String(opts.bbox) : "";
  if (nearRaw && bboxRaw) return { error: "--near and --bbox are mutually exclusive (pick one)" };
  if (opts.radius != null && !nearRaw) return { error: "--radius requires --near <lat,lng>" };
  if (bboxRaw) {
    const bbox = parseBboxArg(bboxRaw);
    if (!bbox) return { error: `invalid --bbox '${bboxRaw}' (expected minLat,minLng,maxLat,maxLng — WGS84, min <= max per axis, non-wrapping)` };
    return { spatial: { bbox } };
  }
  if (nearRaw) {
    const center = parseLatLngArg(nearRaw);
    if (!center) return { error: `invalid --near '${nearRaw}' (expected lat,lng in WGS84 range)` };
    let radiusMeters = DEFAULT_RADIUS_M;
    if (opts.radius != null) {
      const r = Number(opts.radius);
      if (!Number.isFinite(r) || r <= 0) return { error: `invalid --radius: ${opts.radius} (expected meters > 0)` };
      radiusMeters = r;
    }
    return { spatial: { center, radiusMeters } };
  }
  return {};
}

const err = (message: string): OvercastRecord => errRecord("geofence", message);

export const geofenceVerb: VerbSpec = {
  name: "geofence",
  group: "inspect",
  summary: "List every case record whose GPS falls inside a radius/box within a time window.",
  description:
    "The geofence query: gathers all case records carrying payload.gps{lat,lng} (`exif`, and geo sources like " +
    "dispatch/firms/flights/overpass) and returns the ones intersecting a location fence — a --near <lat,lng> circle " +
    "(--radius meters, default 500) or a --bbox <minLat,minLng,maxLat,maxLng> box (inclusive edges, non-wrapping) — " +
    "captured within [--since, --until]. Recency uses the CAPTURE time (exif payload.created) when present, falling " +
    "back to ingest time; undated records that intersect spatially are KEPT (they can't be excluded by time — the " +
    "map/wall convention) with capture_time null. Pure local read, no network. Emits ONE operational rollup record " +
    "(matches newest-first, per-verb counts, the query echoed back) — a viewer over evidence, never ask/brief " +
    "evidence itself. An empty intersection is a clean ready record with guidance, not an error.",
  args: [],
  flags: [
    { name: "near", summary: "Fence center 'lat,lng' (circle mode; pairs with --radius)", type: "string" },
    // no spec-level default: the CLI parser would inject radius=500 into every
    // invocation and trip the "--radius requires --near" guard under --bbox;
    // resolveSpatialFlags applies the 500 m default when --near is given.
    { name: "radius", summary: "Circle radius in meters around --near (default 500)", type: "number" },
    { name: "bbox", summary: "Fence box 'minLat,minLng,maxLat,maxLng' (inclusive, non-wrapping)", type: "string" },
    { name: "since", summary: "Window start (e.g. 24h, 7d, 2026-06-01) — capture-time-aware", type: "string" },
    { name: "until", summary: "Window end (same grammar as --since)", type: "string" },
    { name: "limit", summary: "Max matches returned, most-recent first", type: "number", default: 500 },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "geofence.result",
  providerKey: "geofence",
  run: async (ctx) => {
    const resolved = resolveSpatialFlags(ctx.opts);
    if (resolved.error) return [err(resolved.error)];
    const spatial = resolved.spatial;
    if (!spatial) return [err("geofence requires a fence: --near <lat,lng> (optional --radius <m>) or --bbox <minLat,minLng,maxLat,maxLng>")];

    let sinceCutoff: number | undefined;
    if (ctx.opts.since != null) {
      const cutoff = parseSince(String(ctx.opts.since));
      if (cutoff == null) return [err(`invalid --since: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
      sinceCutoff = cutoff;
    }
    let untilCutoff: number | undefined;
    if (ctx.opts.until != null) {
      const cutoff = parseSince(String(ctx.opts.until));
      if (cutoff == null) return [err(`invalid --until: ${ctx.opts.until} (try 24h, 7d, or 2026-06-01)`)];
      untilCutoff = cutoff;
    }
    let limit = 500;
    if (ctx.opts.limit != null) {
      const n = Number(ctx.opts.limit);
      if (!Number.isFinite(n) || n <= 0) return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
      limit = Math.floor(n);
    }

    interface Match {
      record_id: string;
      verb: string;
      gps: GeoPoint;
      at: number | [number, number] | null;
      capture_time: string | null;
      ref: string | null;
      summary: string;
    }
    const hits: Array<{ match: Match; t: number }> = [];
    let gpsTotal = 0;
    // records that passed the spatial fence but were dropped by the time window —
    // lets the empty-state note tell a spatial miss from a temporal one.
    let spaceMatchOutsideWindow = 0;
    for (const rec of ctx.case.records()) {
      if (!isReady(rec)) continue;
      const payload = rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload) ? (rec.payload as Record<string, unknown>) : undefined;
      const gps = validLatLng(payload?.gps);
      if (!gps) continue;
      gpsTotal++;
      if (spatial.center && spatial.radiusMeters != null && !inRadius(gps, spatial.center, spatial.radiusMeters)) continue;
      if (spatial.bbox && !inBbox(gps, spatial.bbox)) continue;
      // capture-time window: drop dated records outside [since, until]; KEEP
      // undated ones (NaN — they can't be excluded by time), like map/wall.
      const t = recordCaptureTimeMs(rec);
      if (!Number.isNaN(t)) {
        if (sinceCutoff != null && t < sinceCutoff) { spaceMatchOutsideWindow++; continue; }
        if (untilCutoff != null && t > untilCutoff) { spaceMatchOutsideWindow++; continue; }
      }
      const at = rec.media?.at;
      hits.push({
        match: {
          record_id: rec.id,
          verb: rec.verb,
          gps,
          at: typeof at === "number" || Array.isArray(at) ? at : null,
          capture_time: Number.isNaN(t) ? null : new Date(t).toISOString(),
          ref: rec.media?.ref ?? null,
          summary: recordStub(rec),
        },
        t,
      });
    }

    // newest-first; undated (NaN) matches sort to the end (map.ts convention).
    const sortKey = (t: number) => (Number.isNaN(t) ? -Infinity : t);
    hits.sort((a, b) => sortKey(b.t) - sortKey(a.t));
    const total = hits.length;
    const matches = hits.slice(0, limit).map((h) => h.match);
    const counts: Record<string, number> = {};
    for (const m of matches) counts[m.verb] = (counts[m.verb] ?? 0) + 1;

    const hasWindow = sinceCutoff != null || untilCutoff != null;
    const note =
      total > 0
        ? undefined
        : gpsTotal === 0
          ? "no GPS-bearing records — run `exif <media>` on media with embedded GPS, or scan a geo source (dispatch/firms/flights/overpass)"
          : spaceMatchOutsideWindow > 0
            ? `${gpsTotal} GPS-bearing record${gpsTotal === 1 ? "" : "s"} in the case; ${spaceMatchOutsideWindow} fall inside the area but outside the --since/--until window — widen (or drop) the time window, or widen --radius/--bbox`
            : `${gpsTotal} GPS-bearing record${gpsTotal === 1 ? "" : "s"} in the case, but none fall inside the area — widen --radius/--bbox${hasWindow ? " (the --since/--until window excluded nothing spatially in range)" : ""}`;

    return [
      makeRecord({
        verb: "geofence",
        format: "json",
        payload: {
          mode: "geofence",
          query: {
            ...(spatial.center ? { near: spatial.center, radius_m: spatial.radiusMeters } : {}),
            ...(spatial.bbox ? { bbox: spatial.bbox } : {}),
            ...(ctx.opts.since != null ? { since: String(ctx.opts.since) } : {}),
            ...(ctx.opts.until != null ? { until: String(ctx.opts.until) } : {}),
          },
          matches,
          count: matches.length,
          total,
          gps_total: gpsTotal,
          counts,
          ...(note ? { note } : {}),
        },
        meta: { provider: "geofence", case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};
