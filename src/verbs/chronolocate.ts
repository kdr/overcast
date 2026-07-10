// ---- chronolocate (chronolocation from sun / shadow) ------------------------
// The playlist's marquee technique (OSINT At Home #8/#9/#25/#27 — SunCalc,
// ShadowMap): work out WHEN a photo was taken from the sun, or verify a claimed
// time against where the sun actually was. Pure offline astronomy (src/solar.ts)
// — no API, no key. Two modes:
//   verify  (--at-time)         given a location + claimed time, compute the sun
//                               position + the shadow it must cast, so an analyst
//                               can check it against the frame (mis-dated / faked).
//   solve   (--shadow-azimuth)  given a location + an OBSERVED shadow bearing (and
//                               optionally an object:shadow length ratio), return
//                               the time window(s) that cast it on a given date.
//
// The result carries payload.gps so it drops straight onto `overcast map`, and is
// evidence (not operational) so `ask`/`brief` can cite it. Chronolocation is a
// LEAD, not proof — every record carries payload.caveat (like `voice`).

import { makeRecord, errRecord, type OvercastRecord } from "../record.js";
import { validLat, validLng, validLatLng } from "../geo.js";
import {
  sunPosition,
  solarDeclination,
  shadowToSunAzimuth,
  sunToShadowAzimuth,
  altitudeToShadowRatio,
  shadowRatioToAltitude,
  solarTimeHours,
  formatSolarTime,
  norm360,
  solveShadowWindows,
} from "../solar.js";
import type { VerbSpec } from "../registry/types.js";

const err = (message: string): OvercastRecord => errRecord("chronolocate", message);

/** Parse an --at-time value. A bare datetime with no zone is read as UTC (with a
 *  note) rather than the host's local zone, so results are reproducible. */
function parseInstant(raw: string): { date: Date; assumedUtc: boolean } | undefined {
  const s = raw.trim();
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(s);
  const hasTime = /[T ]\d\d:\d\d/.test(s);
  let iso = s;
  let assumedUtc = false;
  if (!hasZone && hasTime) {
    iso = s.replace(" ", "T") + "Z";
    assumedUtc = true;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return undefined;
  return { date, assumedUtc };
}

/** Parse a --date (YYYY-MM-DD) reference date for solve mode; defaults to today (UTC). */
function parseRefDate(raw: string | undefined): Date | undefined {
  if (raw == null || String(raw).trim() === "") return new Date();
  const s = String(raw).trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

const round1 = (n: number) => Number(n.toFixed(1));

export const chronolocateVerb: VerbSpec = {
  name: "chronolocate",
  group: "sense",
  summary: "Chronolocation from the sun/shadows: solve WHEN a photo was taken, or verify a claimed time.",
  description:
    "Pure offline solar-position math (no API/key). VERIFY mode (--at-time <ISO>): given a location and a claimed " +
    "capture time, computes the sun's azimuth/altitude and the shadow it must cast, so you can check it against the " +
    "frame (a mismatch flags a mis-dated or staged image). SOLVE mode (--shadow-azimuth <deg>): given a location and " +
    "an OBSERVED shadow bearing (0=N,90=E,180=S,270=W), returns the time window(s) on a date (--date, default today) " +
    "when the sun would cast it; add --height-ratio <object:shadow> to also use shadow LENGTH and narrow the window. " +
    "Location comes from --lat/--lng or, when the positional input is a case record carrying payload.gps (e.g. an " +
    "`exif` hit), from that record. The result carries payload.gps (plots on `map`) and payload.caveat — " +
    "chronolocation is a lead, not proof (a clone/edit can fake shadows).",
  args: [{ name: "input", summary: "Optional: a case record id (pulls its GPS + links its media) or an image/frame ref", required: false }],
  flags: [
    { name: "lat", summary: "Latitude (WGS84) — overrides a record's GPS", type: "number" },
    { name: "lng", summary: "Longitude (WGS84) — overrides a record's GPS", type: "number" },
    { name: "at-time", summary: "VERIFY: claimed capture time (ISO 8601; bare datetime read as UTC)", type: "string" },
    { name: "shadow-azimuth", summary: "SOLVE: observed shadow bearing in degrees from North (0=N,90=E,180=S,270=W)", type: "number" },
    { name: "height-ratio", summary: "SOLVE: object-height ÷ shadow-length, to also constrain by shadow length", type: "number" },
    { name: "date", summary: "SOLVE: reference date YYYY-MM-DD (declination varies by date); default today", type: "string" },
    { name: "az-tol", summary: "SOLVE: azimuth match tolerance in degrees (default 3)", type: "number", default: 3 },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "chrono.estimate",
  run: async (ctx) => {
    // --- resolve location (explicit flags win per-axis; else the record's GPS) --
    let lat: number | undefined;
    let lng: number | undefined;
    let latFrom: "flags" | "record" | undefined;
    let lngFrom: "flags" | "record" | undefined;
    let mediaRef: string | undefined;
    let mediaAt: number | [number, number] | undefined;
    let sourceRecord: string | undefined;

    const latOpt = ctx.opts.lat != null ? validLat(Number(ctx.opts.lat)) : undefined;
    const lngOpt = ctx.opts.lng != null ? validLng(Number(ctx.opts.lng)) : undefined;
    if (ctx.opts.lat != null && latOpt === undefined) return [err(`invalid --lat ${ctx.opts.lat} (expected -90..90)`)];
    if (ctx.opts.lng != null && lngOpt === undefined) return [err(`invalid --lng ${ctx.opts.lng} (expected -180..180)`)];

    if (ctx.input) {
      const rec = ctx.case.recordById(ctx.input);
      if (rec) {
        sourceRecord = rec.id;
        if (rec.media?.ref) {
          mediaRef = rec.media.ref;
          // carry the evidence moment forward — a timed watch/see frame keeps its
          // second/span so `map` markers and citations still anchor to the moment.
          if (rec.media.at !== undefined) mediaAt = rec.media.at;
        }
        const gps = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>).gps : undefined;
        const valid = validLatLng(gps);
        if (valid) {
          lat = valid.lat;
          lng = valid.lng;
          latFrom = "record";
          lngFrom = "record";
        }
      } else {
        // not a record id — treat as a media path/URL/frame ref for evidence linking
        mediaRef = ctx.input;
      }
    }
    // an explicit --lat/--lng overrides that axis AND re-attributes its source.
    if (latOpt !== undefined) {
      lat = latOpt;
      latFrom = "flags";
    }
    if (lngOpt !== undefined) {
      lng = lngOpt;
      lngFrom = "flags";
    }

    if (lat === undefined || lng === undefined) {
      const why = ctx.input && sourceRecord ? ` (record ${sourceRecord} has no usable GPS)` : "";
      return [err(`chronolocate needs a location${why}: pass --lat/--lng, or a case record carrying payload.gps`)];
    }

    // attribute coordinates honestly for the audit trail: flags, the linked
    // record, or a mix when only one axis was overridden (both axes are set here).
    const gpsSource =
      latFrom === "flags" && lngFrom === "flags"
        ? "flags"
        : latFrom === "record" && lngFrom === "record"
          ? `record ${sourceRecord}`
          : `flags + record ${sourceRecord}`;

    const wantVerify = ctx.opts["at-time"] != null && String(ctx.opts["at-time"]).trim() !== "";
    const wantSolve = ctx.opts["shadow-azimuth"] != null;
    if (wantVerify && wantSolve) return [err("pass either --at-time (verify) or --shadow-azimuth (solve), not both")];
    if (!wantVerify && !wantSolve) return [err("chronolocate needs a mode: --at-time <ISO> (verify) or --shadow-azimuth <deg> (solve)")];

    const stampMedia = (rec: OvercastRecord): OvercastRecord => {
      if (mediaRef) rec.media = { ref: mediaRef, ...(mediaAt !== undefined ? { at: mediaAt } : {}) };
      rec.meta = { ...rec.meta, case: ctx.case.dir, ...(sourceRecord ? { source_record: sourceRecord } : {}) };
      return rec;
    };

    // --- VERIFY -------------------------------------------------------------
    if (wantVerify) {
      const parsed = parseInstant(String(ctx.opts["at-time"]));
      if (!parsed) return [err(`invalid --at-time '${ctx.opts["at-time"]}' (expected an ISO 8601 time)`)];
      const { date, assumedUtc } = parsed;
      const pos = sunPosition(date, lat, lng);
      const daylight = pos.altitude > 0;
      const ratio = altitudeToShadowRatio(pos.altitude);
      const shadowBearing = daylight ? sunToShadowAzimuth(pos.azimuth) : null;
      const solar = formatSolarTime(solarTimeHours(pos.hourAngle));

      const caveat =
        (daylight
          ? "Compare the frame's shadows to expected_shadow. A mismatch in bearing or length flags a mis-dated or staged image. "
          : "The sun was BELOW the horizon at this instant — a daylight photo here contradicts the claimed time. ") +
        "Chronolocation is a lead, not proof: overcast trusts the location you supplied and the claimed time; a clone/edit can fabricate shadows.";

      const summary = daylight
        ? `At ${date.toISOString()} the sun was ${round1(pos.altitude)}° up, bearing ${round1(pos.azimuth)}° — shadows point ${round1(shadowBearing!)}° at ${ratio ? `${round1(ratio)}:1 (object:shadow)` : "grazing"} length (solar time ${solar}).`
        : `At ${date.toISOString()} the sun was ${round1(pos.altitude)}° BELOW the horizon (night) — no daylight shadow.`;

      return [
        stampMedia(
          makeRecord({
            verb: "chronolocate",
            format: "json",
            payload: {
              mode: "verify",
              gps: { lat, lng },
              gps_source: gpsSource,
              at: date.toISOString(),
              assumed_utc: assumedUtc,
              daylight,
              sun: { azimuth: round1(pos.azimuth), altitude: round1(pos.altitude) },
              expected_shadow: { bearing: shadowBearing == null ? null : round1(shadowBearing), length_ratio: ratio == null ? null : round1(ratio) },
              solar_time: solar,
              summary,
              caveat,
            },
            meta: { provider: "solar" },
            state: "ready",
          }),
        ),
      ];
    }

    // --- SOLVE --------------------------------------------------------------
    const shadowAz = norm360(Number(ctx.opts["shadow-azimuth"]));
    if (!Number.isFinite(Number(ctx.opts["shadow-azimuth"]))) return [err(`invalid --shadow-azimuth ${ctx.opts["shadow-azimuth"]}`)];
    const refDate = parseRefDate(ctx.opts.date as string | undefined);
    if (!refDate) return [err(`invalid --date '${ctx.opts.date}' (expected YYYY-MM-DD)`)];

    let heightRatio: number | undefined;
    let targetAlt: number | undefined;
    if (ctx.opts["height-ratio"] != null) {
      heightRatio = Number(ctx.opts["height-ratio"]);
      if (!Number.isFinite(heightRatio) || heightRatio <= 0) return [err(`invalid --height-ratio ${ctx.opts["height-ratio"]} (expected a positive object:shadow ratio)`)];
      targetAlt = shadowRatioToAltitude(heightRatio);
    }
    const azTol = ctx.opts["az-tol"] != null ? Number(ctx.opts["az-tol"]) : 3;
    if (!Number.isFinite(azTol) || azTol <= 0) return [err(`invalid --az-tol ${ctx.opts["az-tol"]} (expected a positive number of degrees)`)];

    const sunAz = shadowToSunAzimuth(shadowAz);
    const windows = solveShadowWindows({ date: refDate, lat, lng, sunAzimuth: sunAz, altitude: targetAlt, azTolDeg: azTol });
    const dateStr = refDate.toISOString().slice(0, 10);

    const candidates = windows.map((w) => ({
      solar_time: { start: w.startSolar, end: w.endSolar },
      utc: { start: w.startUtc, end: w.endUtc },
      azimuth: w.azimuth,
      altitude: w.altitude,
    }));

    const caveat =
      "Times are APPARENT LOCAL SOLAR time on " +
      dateStr +
      " — the sun's track shifts with the date (declination), so a wrong date shifts the answer; solar time differs from clock time by the equation of time + timezone. " +
      (targetAlt == null ? "Without --height-ratio only the shadow DIRECTION is used, so a window can be wide. " : "") +
      "Chronolocation is a lead, not proof.";

    const summary =
      candidates.length === 0
        ? `On ${dateStr} at (${round1(lat)}, ${round1(lng)}) the sun is never at bearing ${round1(sunAz)}° above the horizon — no shadow like that on this date.`
        : `On ${dateStr} a shadow bearing ${round1(shadowAz)}° (sun at ${round1(sunAz)}°${targetAlt != null ? `, ${round1(targetAlt)}° up` : ""}) happens ${candidates.length === 1 ? "around" : "in"} ${candidates.map((c) => (c.solar_time.start === c.solar_time.end ? c.solar_time.start : `${c.solar_time.start}–${c.solar_time.end}`)).join(", ")} solar time.`;

    return [
      stampMedia(
        makeRecord({
          verb: "chronolocate",
          format: "json",
          payload: {
            mode: "solve",
            gps: { lat, lng },
            gps_source: gpsSource,
            date: dateStr,
            declination: round1(solarDeclination(refDate)),
            observed_shadow_azimuth: round1(shadowAz),
            sun_azimuth: round1(sunAz),
            ...(heightRatio != null ? { height_ratio: heightRatio, target_altitude: round1(targetAlt!) } : {}),
            az_tolerance_deg: azTol,
            candidates,
            summary,
            caveat,
          },
          meta: { provider: "solar" },
          state: "ready",
        }),
      ),
    ];
  },
};
