import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finiteNum,
  validLat,
  validLng,
  validLatLng,
  gpsIssue,
  distanceMeters,
  inRadius,
  inBbox,
  parseLatLngArg,
  parseBboxArg,
} from "../../src/geo.ts";

test("finiteNum: rejects NaN/Infinity/non-numbers", () => {
  assert.equal(finiteNum(1.5), 1.5);
  assert.equal(finiteNum(0), 0);
  assert.equal(finiteNum(NaN), undefined);
  assert.equal(finiteNum(Infinity), undefined);
  assert.equal(finiteNum("3"), undefined);
  assert.equal(finiteNum(null), undefined);
});

test("validLat: accepts [-90,90], rejects out-of-range + NaN", () => {
  assert.equal(validLat(37.77), 37.77);
  assert.equal(validLat(-90), -90);
  assert.equal(validLat(90), 90);
  assert.equal(validLat(90.1), undefined);
  assert.equal(validLat(200), undefined);
  assert.equal(validLat(NaN), undefined);
});

test("validLng: accepts [-180,180], rejects out-of-range", () => {
  assert.equal(validLng(-122.4), -122.4);
  assert.equal(validLng(180), 180);
  assert.equal(validLng(-180), -180);
  assert.equal(validLng(180.5), undefined);
  assert.equal(validLng(400), undefined);
  assert.equal(validLng(Infinity), undefined);
});

test("validLatLng: returns a pair only when BOTH coords are valid", () => {
  assert.deepEqual(validLatLng({ lat: 37.77, lng: -122.4 }), { lat: 37.77, lng: -122.4 });
  assert.equal(validLatLng({ lat: 999, lng: 1 }), undefined); // bad lat
  assert.equal(validLatLng({ lat: 1, lng: 999 }), undefined); // bad lng
  assert.equal(validLatLng({ lat: NaN, lng: 1 }), undefined);
  assert.equal(validLatLng({ lat: 1 }), undefined); // missing lng
  assert.equal(validLatLng(null), undefined);
  assert.equal(validLatLng("37,-122"), undefined);
});

test("gpsIssue: classifies absent / out-of-range / malformed precisely", () => {
  assert.equal(gpsIssue({ lat: 37.77, lng: -122.4 }), undefined); // usable
  assert.equal(gpsIssue(null), "absent");
  assert.equal(gpsIssue(undefined), "absent");
  // both axes finite numbers, one outside WGS84 → out-of-range
  assert.equal(gpsIssue({ lat: 999, lng: 1 }), "out-of-range");
  assert.equal(gpsIssue({ lat: 1, lng: 999 }), "out-of-range");
  // missing axis / non-numeric / empty → malformed, NOT "out of range"
  assert.equal(gpsIssue({ lat: 1 }), "malformed");
  assert.equal(gpsIssue({}), "malformed");
  assert.equal(gpsIssue({ lat: "x", lng: "y" }), "malformed");
  assert.equal(gpsIssue({ lat: NaN, lng: 1 }), "malformed");
});

// --- spatial primitives (geofence / map --near / --bbox) ----------------------

test("distanceMeters: haversine against known distances (R=6371000)", () => {
  // 1° of latitude on the R=6371000 sphere = 2πR/360 ≈ 111194.93 m
  const oneDeg = distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(oneDeg - 111194.93) < 1, `1° lat ≈ 111194.93 m, got ${oneDeg}`);
  // ~1 km pair: 0.009° of latitude ≈ 1000.75 m
  const km = distanceMeters({ lat: 37.7749, lng: -122.4194 }, { lat: 37.7839, lng: -122.4194 });
  assert.ok(Math.abs(km - 1000.75) < 1, `0.009° lat ≈ 1000.75 m, got ${km}`);
  // antipodal sanity: half the sphere's circumference = πR
  const anti = distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
  assert.ok(Math.abs(anti - Math.PI * 6371000) < 1, `antipodal ≈ πR, got ${anti}`);
  // longitude shrinks with latitude: 1° lng at 60°N ≈ cos(60°) × 1° at the equator
  const lng60 = distanceMeters({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
  assert.ok(Math.abs(lng60 - 111194.93 / 2) < 30, `1° lng @60°N ≈ 55597 m, got ${lng60}`);
  // identity + symmetry
  assert.equal(distanceMeters({ lat: 12.3, lng: 45.6 }, { lat: 12.3, lng: 45.6 }), 0);
  assert.equal(
    distanceMeters({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }),
    distanceMeters({ lat: 3, lng: 4 }, { lat: 1, lng: 2 }),
  );
  // malformed input → NaN, never a plausible-looking number
  assert.ok(Number.isNaN(distanceMeters({ lat: 999, lng: 0 }, { lat: 0, lng: 0 })));
  assert.ok(Number.isNaN(distanceMeters({ lat: 0, lng: 0 }, { lat: NaN, lng: 0 })));
});

test("inRadius: inclusive boundary, malformed points and bad radii rejected", () => {
  const center = { lat: 0, lng: 0 };
  const pt = { lat: 0.009, lng: 0 }; // ≈ 1000.75 m north
  const d = distanceMeters(pt, center);
  assert.equal(inRadius(pt, center, d), true); // exactly at the boundary → in (<=)
  assert.equal(inRadius(pt, center, d - 1), false); // one meter tighter → out
  assert.equal(inRadius(pt, center, d + 1), true);
  assert.equal(inRadius(center, center, 0), true); // zero radius keeps the exact point
  assert.equal(inRadius({ lat: 999, lng: 0 }, center, 1e9), false); // malformed point never matches
  assert.equal(inRadius(pt, { lat: NaN, lng: 0 }, 1e9), false); // malformed center never matches
  assert.equal(inRadius(pt, center, NaN), false);
  assert.equal(inRadius(pt, center, -5), false);
});

test("inBbox: inclusive edges, outside points and malformed input rejected", () => {
  const box = { minLat: 10, minLng: 20, maxLat: 30, maxLng: 40 };
  assert.equal(inBbox({ lat: 20, lng: 30 }, box), true); // interior
  assert.equal(inBbox({ lat: 10, lng: 20 }, box), true); // min corner (inclusive)
  assert.equal(inBbox({ lat: 30, lng: 40 }, box), true); // max corner (inclusive)
  assert.equal(inBbox({ lat: 10, lng: 35 }, box), true); // on the minLat edge
  assert.equal(inBbox({ lat: 9.999, lng: 30 }, box), false); // just south
  assert.equal(inBbox({ lat: 20, lng: 40.001 }, box), false); // just east
  assert.equal(inBbox({ lat: -20, lng: 30 }, box), false);
  assert.equal(inBbox({ lat: NaN, lng: 30 }, box), false); // malformed point
  // non-wrapping: minLng > maxLng matches nothing (documented v1 limitation)
  assert.equal(inBbox({ lat: 0, lng: 179 }, { minLat: -1, minLng: 170, maxLat: 1, maxLng: -170 }), false);
});

test("parseLatLngArg: 'lat,lng' with validation; malformed/out-of-range → undefined", () => {
  assert.deepEqual(parseLatLngArg("37.7749,-122.4194"), { lat: 37.7749, lng: -122.4194 });
  assert.deepEqual(parseLatLngArg(" 37.7749 , -122.4194 "), { lat: 37.7749, lng: -122.4194 }); // whitespace ok
  assert.equal(parseLatLngArg("91,0"), undefined); // out-of-range lat
  assert.equal(parseLatLngArg("0,181"), undefined); // out-of-range lng
  assert.equal(parseLatLngArg("37.7749"), undefined); // missing lng
  assert.equal(parseLatLngArg("a,b"), undefined);
  assert.equal(parseLatLngArg("1,2,3"), undefined);
  assert.equal(parseLatLngArg(",-122"), undefined); // empty component (Number('')===0 must not pass)
});

test("parseBboxArg: 'minLat,minLng,maxLat,maxLng' with validation + non-wrapping ordering", () => {
  assert.deepEqual(parseBboxArg("37.7,-122.5,37.8,-122.3"), { minLat: 37.7, minLng: -122.5, maxLat: 37.8, maxLng: -122.3 });
  assert.equal(parseBboxArg("37.8,-122.5,37.7,-122.3"), undefined); // minLat > maxLat
  assert.equal(parseBboxArg("-1,170,1,-170"), undefined); // wrapping box rejected (v1 non-wrapping)
  assert.equal(parseBboxArg("0,0,91,0"), undefined); // out-of-range corner
  assert.equal(parseBboxArg("1,2,3"), undefined); // wrong arity
  assert.equal(parseBboxArg("a,b,c,d"), undefined);
  assert.equal(parseBboxArg("1,,3,4"), undefined); // empty component
});
