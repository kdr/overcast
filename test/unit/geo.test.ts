import { test } from "node:test";
import assert from "node:assert/strict";
import { finiteNum, validLat, validLng, validLatLng } from "../../src/geo.ts";

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
