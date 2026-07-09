import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { buildMapModel, renderMapHtml } from "../../src/report/map.ts";

function geo(opts: { lat?: number; lng?: number; verb?: string; ref?: string; time?: string; place?: string; state?: string; gps?: unknown }): OvercastRecord {
  return makeRecord({
    verb: opts.verb ?? "exif",
    format: "json",
    payload: {
      summary: "meta",
      gps: opts.gps !== undefined ? opts.gps : opts.lat != null ? { lat: opts.lat, lng: opts.lng } : null,
      ...(opts.place ? { place: opts.place } : {}),
    },
    media: { ref: opts.ref ?? "a.jpg" },
    meta: opts.time ? { time: opts.time } : undefined,
    state: opts.state,
  });
}

const OPTS = { caseName: "case", caseDir: "/tmp/case", now: 1_700_000_000_000 };

test("buildMapModel: keeps only records with numeric gps; computes bounds + counts", () => {
  const m = buildMapModel(
    [
      geo({ lat: 37.7, lng: -122.4, ref: "sf.jpg" }),
      geo({ lat: 40.7, lng: -74.0, ref: "ny.jpg", verb: "capture" }),
      geo({ gps: null, ref: "nogps.jpg" }),
      geo({ gps: { lat: "x", lng: 1 }, ref: "bad.jpg" }),
    ],
    OPTS,
  );
  assert.equal(m.points.length, 2);
  assert.equal(m.total, 2);
  assert.deepEqual(m.bounds, { minLat: 37.7, minLng: -122.4, maxLat: 40.7, maxLng: -74.0 });
  assert.deepEqual(m.counts, { exif: 1, capture: 1 });
});

test("buildMapModel: skips error records", () => {
  const m = buildMapModel([geo({ lat: 1, lng: 2, state: "error" }), geo({ lat: 3, lng: 4 })], OPTS);
  assert.equal(m.points.length, 1);
  assert.equal(m.points[0].lat, 3);
});

test("buildMapModel: --since drops older dated points but keeps undated ones", () => {
  const m = buildMapModel(
    [
      geo({ lat: 1, lng: 1, ref: "old.jpg", time: "2020-01-01T00:00:00Z" }),
      geo({ lat: 2, lng: 2, ref: "new.jpg", time: "2026-07-01T00:00:00Z" }),
      geo({ lat: 3, lng: 3, ref: "undated.jpg" }),
    ],
    { ...OPTS, sinceCutoff: Date.parse("2026-01-01T00:00:00Z") },
  );
  const refs = m.points.map((p) => p.ref).sort();
  assert.deepEqual(refs, ["new.jpg", "undated.jpg"]);
});

test("buildMapModel: --limit pages most-recent first, total reflects the full set", () => {
  const m = buildMapModel(
    [
      geo({ lat: 1, lng: 1, ref: "a.jpg", time: "2026-01-01T00:00:00Z" }),
      geo({ lat: 2, lng: 2, ref: "b.jpg", time: "2026-02-01T00:00:00Z" }),
      geo({ lat: 3, lng: 3, ref: "c.jpg", time: "2026-03-01T00:00:00Z" }),
    ],
    { ...OPTS, limit: 1 },
  );
  assert.equal(m.total, 3);
  assert.equal(m.points.length, 1);
  assert.equal(m.points[0].ref, "c.jpg"); // newest
});

test("renderMapHtml online: self-contained, OSM tile template, per-point markers, tile-scoped CSP", () => {
  const m = buildMapModel([geo({ lat: 37.7, lng: -122.4, place: "San Francisco" })], OPTS);
  const html = renderMapHtml(m, "plain", { offline: false });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /tile\.openstreetmap\.org/);
  assert.match(html, /img-src data: file: https:\/\/\*\.tile\.openstreetmap\.org/);
  assert.match(html, /const POINTS=/);
  assert.match(html, /San Francisco/);
  // no un-inlined external asset (script/link src)
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
});

test("renderMapHtml offline: no tiles, openstreetmap.org deep links, default-src none CSP", () => {
  const m = buildMapModel([geo({ lat: 37.7, lng: -122.4 })], OPTS);
  const html = renderMapHtml(m, "plain", { offline: true });
  assert.doesNotMatch(html, /tile\.openstreetmap\.org/);
  assert.match(html, /openstreetmap\.org\/\?mlat=37\.7&amp;mlon=-122\.4/); // & escaped in href
  assert.match(html, /default-src 'none'/);
});
