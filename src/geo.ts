// Shared WGS84 coordinate validation. Used by BOTH the map (which point-filters
// records) and `exif --geocode` (which must not egress a coordinate the map would
// drop) so the two never diverge — a lat/lng is either valid for both or neither.

export function finiteNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A finite latitude in [-90, 90], else undefined (rejects NaN/Infinity/out-of-range). */
export function validLat(v: unknown): number | undefined {
  const n = finiteNum(v);
  return n !== undefined && Math.abs(n) <= 90 ? n : undefined;
}

/** A finite longitude in [-180, 180], else undefined. */
export function validLng(v: unknown): number | undefined {
  const n = finiteNum(v);
  return n !== undefined && Math.abs(n) <= 180 ? n : undefined;
}

/** A valid {lat,lng} pair from a gps-ish object, or undefined when either
 *  coordinate is missing/NaN/Infinity/out of WGS84 range. */
export function validLatLng(gps: unknown): { lat: number; lng: number } | undefined {
  if (!gps || typeof gps !== "object") return undefined;
  const g = gps as Record<string, unknown>;
  const lat = validLat(g.lat);
  const lng = validLng(g.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

/** Why a gps value isn't usable — for accurate user-facing feedback. `undefined`
 *  means it IS usable. "out-of-range" is reserved for the case where both axes are
 *  finite numbers but at least one falls outside WGS84; missing/non-numeric axes
 *  are "malformed", and a null/absent value is "absent". */
export type GpsIssue = "absent" | "out-of-range" | "malformed";
export function gpsIssue(gps: unknown): GpsIssue | undefined {
  if (gps == null) return "absent";
  if (validLatLng(gps) !== undefined) return undefined;
  const g = typeof gps === "object" ? (gps as Record<string, unknown>) : {};
  const bothNumeric = finiteNum(g.lat) !== undefined && finiteNum(g.lng) !== undefined;
  return bothNumeric ? "out-of-range" : "malformed";
}

// --- spatial primitives (geofence / map --near / --bbox) ----------------------
// Pure WGS84 math over validated points — shared by the `geofence` verb and the
// map's spatial pre-filter so "inside the fence" means the same thing everywhere.

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Inclusive lat/lng box. v1 is NON-WRAPPING: minLng <= maxLng is required, so a
 *  box cannot straddle the antimeridian (map.ts's lngBounds handles display-side
 *  antimeridian clusters; the QUERY box deliberately stays simple). */
export interface GeoBbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const EARTH_RADIUS_M = 6371000; // mean earth radius (meters)

/** Great-circle distance in meters between two points (haversine, R=6371000 m).
 *  NaN when either point fails WGS84 validation — NaN compares false everywhere,
 *  so a malformed point can never pass a radius test. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const pa = validLatLng(a);
  const pb = validLatLng(b);
  if (!pa || !pb) return NaN;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(pb.lat - pa.lat);
  const dLng = rad(pb.lng - pa.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(pa.lat)) * Math.cos(rad(pb.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether `pt` lies within `radiusMeters` of `center` (inclusive boundary).
 *  False for malformed points/centers or a non-finite/negative radius. */
export function inRadius(pt: GeoPoint, center: GeoPoint, radiusMeters: number): boolean {
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) return false;
  const d = distanceMeters(pt, center);
  return Number.isFinite(d) && d <= radiusMeters;
}

/** Whether `pt` lies inside `bbox` (edges inclusive). Non-wrapping: a box with
 *  minLng > maxLng matches nothing (see GeoBbox). False for malformed points. */
export function inBbox(pt: GeoPoint, bbox: GeoBbox): boolean {
  const p = validLatLng(pt);
  if (!p) return false;
  return p.lat >= bbox.minLat && p.lat <= bbox.maxLat && p.lng >= bbox.minLng && p.lng <= bbox.maxLng;
}

/** Parse a "lat,lng" CLI arg into a validated point, or undefined on malformed /
 *  out-of-WGS84-range input (tolerates whitespace around the comma). */
export function parseLatLngArg(s: string): GeoPoint | undefined {
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length !== 2 || parts.some((p) => !p)) return undefined;
  return validLatLng({ lat: Number(parts[0]), lng: Number(parts[1]) });
}

/** Parse a "minLat,minLng,maxLat,maxLng" CLI arg into a validated, non-wrapping
 *  inclusive box, or undefined when malformed, out of range, or min > max on
 *  either axis (antimeridian-straddling boxes are rejected, not misread). */
export function parseBboxArg(s: string): GeoBbox | undefined {
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length !== 4 || parts.some((p) => !p)) return undefined;
  const minLat = validLat(Number(parts[0]));
  const minLng = validLng(Number(parts[1]));
  const maxLat = validLat(Number(parts[2]));
  const maxLng = validLng(Number(parts[3]));
  if (minLat === undefined || minLng === undefined || maxLat === undefined || maxLng === undefined) return undefined;
  if (minLat > maxLat || minLng > maxLng) return undefined;
  return { minLat, minLng, maxLat, maxLng };
}
