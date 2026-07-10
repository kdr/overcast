// Self-contained solar-position math for chronolocation (the "SunCalc" technique
// from the OSINT At Home playlist). No runtime dependency — this is the standard
// low-precision astronomical-almanac solar model (the same core SunCalc uses),
// accurate to a few hundredths of a degree over 1950–2050, which is far tighter
// than any shadow an analyst can read off a frame.
//
// Everything here is PURE (no I/O, no Date.now) so it unit-tests offline. Angles
// are DEGREES at the boundary; azimuth is a compass bearing clockwise from North
// (0 = N, 90 = E, 180 = S, 270 = W) so it lines up with how a shadow is measured.

const RAD = Math.PI / 180;
const DAY_MS = 1000 * 60 * 60 * 24;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397; // obliquity of the ecliptic

function toDays(date: Date): number {
  return date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
}

function rightAscension(l: number, b: number): number {
  return Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
}
function declinationRad(l: number, b: number): number {
  return Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
}
function siderealTime(d: number, lw: number): number {
  return RAD * (280.16 + 360.9856235 * d) - lw;
}
function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}
function eclipticLongitude(M: number): number {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372; // perihelion of the Earth
  return M + C + P + Math.PI;
}
function sunCoords(d: number): { dec: number; ra: number } {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declinationRad(L, 0), ra: rightAscension(L, 0) };
}

/** Normalize any angle in degrees to [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed angular separation between two compass bearings, in [0, 180]. */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b)) % 360;
  return d > 180 ? 360 - d : d;
}

export interface SunPos {
  /** Compass bearing of the sun, degrees clockwise from North [0, 360). */
  azimuth: number;
  /** Angle of the sun above the horizon, degrees (negative = below horizon). */
  altitude: number;
  /** Local hour angle, degrees in (-180, 180]; 0 at (apparent) solar noon. */
  hourAngle: number;
}

/** Sun position for an instant (UTC) as seen from lat/lng (WGS84 degrees). */
export function sunPosition(date: Date, lat: number, lng: number): SunPos {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra; // hour angle, radians

  const altitude = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
  // SunCalc-style azimuth measured from South, clockwise toward West; convert to a
  // compass bearing from North so it matches a shadow reading.
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
  const azimuth = norm360(azSouth / RAD + 180);

  // hour angle normalized to (-180, 180], degrees
  let hDeg = ((H / RAD + 180) % 360) - 180;
  if (hDeg <= -180) hDeg += 360;
  return { azimuth, altitude: altitude / RAD, hourAngle: hDeg };
}

/** Solar declination for a date, degrees (+23.44 at N solstice, −23.44 at S). */
export function solarDeclination(date: Date): number {
  return declinationRad(eclipticLongitude(solarMeanAnomaly(toDays(date))), 0) / RAD;
}

// --- shadow geometry ---------------------------------------------------------

/** A shadow points directly away from the sun: sun bearing = shadow bearing ± 180. */
export function shadowToSunAzimuth(shadowAzimuthDeg: number): number {
  return norm360(shadowAzimuthDeg + 180);
}
export function sunToShadowAzimuth(sunAzimuthDeg: number): number {
  return norm360(sunAzimuthDeg + 180);
}

/** Object-height : shadow-length ratio for a given sun altitude (tan of altitude).
 *  null when the sun is at/below the horizon (an infinitely long / no shadow). */
export function altitudeToShadowRatio(altitudeDeg: number): number | null {
  if (altitudeDeg <= 0) return null;
  return Math.tan(altitudeDeg * RAD);
}

/** Sun altitude implied by an object-height : shadow-length ratio, degrees. */
export function shadowRatioToAltitude(ratio: number): number {
  return Math.atan(ratio) / RAD;
}

/** Apparent (true) solar time in hours [0, 24) from a position's hour angle —
 *  timezone- and longitude-independent, the meaningful chronolocation output.
 *  Noon (H = 0) = 12.0. */
export function solarTimeHours(hourAngleDeg: number): number {
  return norm360(hourAngleDeg + 180) / 15; // 12h at H=0
}

/** Format decimal hours as HH:MM (24h). */
export function formatSolarTime(hours: number): string {
  let h = Math.floor(hours) % 24;
  let m = Math.round((hours - Math.floor(hours)) * 60);
  if (m === 60) {
    m = 0;
    h = (h + 1) % 24;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface ShadowWindow {
  /** UTC instants bracketing the window (ISO strings). */
  startUtc: string;
  endUtc: string;
  /** apparent local solar time at the window edges, HH:MM. */
  startSolar: string;
  endSolar: string;
  /** representative sun position at the window midpoint. */
  azimuth: number;
  altitude: number;
}

export interface SolveOptions {
  /** date whose sun track to scan — chronolocation depends on it (declination). */
  date: Date;
  lat: number;
  lng: number;
  /** the sun bearing implied by the observed shadow (shadow ± 180). */
  sunAzimuth: number;
  /** optional sun altitude (from an object:shadow length ratio) to narrow further. */
  altitude?: number;
  /** azimuth match tolerance (deg); default 3°. */
  azTolDeg?: number;
  /** altitude match tolerance (deg); default 4°. */
  altTolDeg?: number;
  /** scan step in minutes; default 1. */
  stepMin?: number;
}

/** Scan a day's sun track and return the time window(s) when the sun sits at the
 *  requested bearing (and altitude, when given) — i.e. when it would cast the
 *  observed shadow. Empty when the sun never matches on that date. */
export function solveShadowWindows(opts: SolveOptions): ShadowWindow[] {
  const azTol = opts.azTolDeg ?? 3;
  const altTol = opts.altTolDeg ?? 4;
  const step = opts.stepMin ?? 1;
  const dayStart = Date.UTC(opts.date.getUTCFullYear(), opts.date.getUTCMonth(), opts.date.getUTCDate(), 0, 0, 0, 0);

  const hits: { t: number; pos: SunPos }[] = [];
  for (let min = 0; min < 24 * 60; min += step) {
    const t = dayStart + min * 60_000;
    const pos = sunPosition(new Date(t), opts.lat, opts.lng);
    if (pos.altitude <= 0) continue; // no sun, no shadow
    if (angularDistance(pos.azimuth, opts.sunAzimuth) > azTol) continue;
    if (opts.altitude != null && Math.abs(pos.altitude - opts.altitude) > altTol) continue;
    hits.push({ t, pos });
  }
  if (hits.length === 0) return [];

  // group consecutive samples (≤ 2 steps apart) into windows
  const windows: ShadowWindow[] = [];
  let run: { t: number; pos: SunPos }[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const mid = run[Math.floor(run.length / 2)];
    windows.push({
      startUtc: new Date(first.t).toISOString(),
      endUtc: new Date(last.t).toISOString(),
      startSolar: formatSolarTime(solarTimeHours(first.pos.hourAngle)),
      endSolar: formatSolarTime(solarTimeHours(last.pos.hourAngle)),
      azimuth: Number(mid.pos.azimuth.toFixed(1)),
      altitude: Number(mid.pos.altitude.toFixed(1)),
    });
    run = [];
  };
  for (const h of hits) {
    if (run.length && h.t - run[run.length - 1].t > step * 60_000 * 2) flush();
    run.push(h);
  }
  flush();
  return windows;
}
