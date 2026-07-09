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
