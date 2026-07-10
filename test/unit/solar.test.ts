import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sunPosition,
  solarDeclination,
  shadowToSunAzimuth,
  sunToShadowAzimuth,
  altitudeToShadowRatio,
  shadowRatioToAltitude,
  solarTimeHours,
  formatSolarTime,
  angularDistance,
  norm360,
  solveShadowWindows,
} from "../../src/solar.ts";

test("solarDeclination: ~+23.44 at N solstice, ~-23.44 at S solstice, ~0 at equinox", () => {
  assert.ok(Math.abs(solarDeclination(new Date("2023-06-21T12:00:00Z")) - 23.44) < 0.25);
  assert.ok(Math.abs(solarDeclination(new Date("2023-12-22T12:00:00Z")) + 23.44) < 0.25);
  assert.ok(Math.abs(solarDeclination(new Date("2023-09-23T06:50:00Z"))) < 0.5);
});

test("sunPosition: London summer-solstice noon is high and due south", () => {
  // London 51.5074, -0.1278; ~12:02 UTC apparent noon on the solstice.
  const pos = sunPosition(new Date("2023-06-21T12:00:00Z"), 51.5074, -0.1278);
  // noon altitude ≈ 90 - lat + dec ≈ 90 - 51.5 + 23.44 ≈ 61.9
  assert.ok(pos.altitude > 58 && pos.altitude < 64, `altitude ${pos.altitude}`);
  // near solar noon the sun is roughly south
  assert.ok(angularDistance(pos.azimuth, 180) < 12, `azimuth ${pos.azimuth}`);
});

test("sunPosition: sun is below the horizon at local midnight", () => {
  // Nairobi ~00:00 local (21:00 UTC): sun well below horizon.
  const pos = sunPosition(new Date("2023-03-21T21:00:00Z"), -1.286, 36.817);
  assert.ok(pos.altitude < 0, `altitude ${pos.altitude}`);
});

test("sunPosition: sun rises in the east, sets in the west", () => {
  const lat = 40.0;
  const lng = 0.0; // local solar time ≈ UTC here
  const morning = sunPosition(new Date("2023-03-21T07:00:00Z"), lat, lng);
  const evening = sunPosition(new Date("2023-03-21T17:00:00Z"), lat, lng);
  assert.ok(morning.altitude > 0 && angularDistance(morning.azimuth, 90) < 35, `morning az ${morning.azimuth}`);
  assert.ok(evening.altitude > 0 && angularDistance(evening.azimuth, 270) < 35, `evening az ${evening.azimuth}`);
});

test("shadow geometry: shadow points opposite the sun; ratio is tan(altitude)", () => {
  assert.equal(shadowToSunAzimuth(70), 250);
  assert.equal(shadowToSunAzimuth(250), 70);
  assert.equal(sunToShadowAzimuth(180), 0);
  // 45° sun → object:shadow ratio 1:1
  assert.ok(Math.abs((altitudeToShadowRatio(45) ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs(shadowRatioToAltitude(1) - 45) < 1e-9);
  assert.equal(altitudeToShadowRatio(0), null);
});

test("solarTimeHours: noon at hour angle 0", () => {
  assert.ok(Math.abs(solarTimeHours(0) - 12) < 1e-9);
  assert.ok(Math.abs(solarTimeHours(-15) - 11) < 1e-9); // one hour before noon
  assert.ok(Math.abs(solarTimeHours(15) - 13) < 1e-9);
  assert.equal(formatSolarTime(13.5), "13:30");
  assert.equal(formatSolarTime(9.99), "09:59");
});

test("norm360/angularDistance: wrap correctly", () => {
  assert.equal(norm360(-10), 350);
  assert.equal(norm360(370), 10);
  assert.equal(angularDistance(350, 10), 20);
  assert.equal(angularDistance(10, 190), 180);
});

test("solve↔verify round-trip: the observed shadow recovers the original time", () => {
  // Pick a real instant, compute the sun's bearing (verify direction), turn it
  // into the shadow it casts, then solve — one candidate window must bracket the
  // original apparent solar time.
  const when = new Date("2023-08-15T13:30:00Z");
  const lat = 35.7911;
  const lng = 43.6147; // the playlist's Ladakh/Iraq-style mid-latitude case
  const truth = sunPosition(when, lat, lng);
  assert.ok(truth.altitude > 0);
  const observedShadow = sunToShadowAzimuth(truth.azimuth);

  const windows = solveShadowWindows({
    date: when,
    lat,
    lng,
    sunAzimuth: shadowToSunAzimuth(observedShadow),
    altitude: truth.altitude,
  });
  assert.ok(windows.length >= 1, "expected at least one candidate window");
  const truthSolar = solarTimeHours(truth.hourAngle);
  const near = windows.some((w) => {
    const lo = Number(w.startSolar.slice(0, 2)) + Number(w.startSolar.slice(3)) / 60;
    const hi = Number(w.endSolar.slice(0, 2)) + Number(w.endSolar.slice(3)) / 60;
    return truthSolar >= lo - 0.25 && truthSolar <= hi + 0.25;
  });
  assert.ok(near, `no window brackets truth solar time ${truthSolar}`);
});

test("solveShadowWindows: no match when the sun is never at that bearing (polar night edge)", () => {
  // A due-north sun bearing at a mid-northern latitude never happens above the
  // horizon — expect zero windows.
  const windows = solveShadowWindows({
    date: new Date("2023-12-21T12:00:00Z"),
    lat: 51.5,
    lng: 0,
    sunAzimuth: 0, // due north
  });
  assert.equal(windows.length, 0);
});
