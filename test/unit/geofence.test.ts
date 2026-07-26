// The geofence verb: spatial + time query over case records (pure local read).
// Synthetic gps-bearing records with varied capture times; asserts the radius /
// bbox / time-window subsets, the error surface, the empty-state guidance, the
// evidence quarantine (OPERATIONAL_VERBS), and the map model's spatial pre-filter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRecord, isMemoryRecord, OPERATIONAL_VERBS, type OvercastRecord } from "../../src/record.ts";
import { buildMapModel } from "../../src/report/map.ts";
import { openCase, type Case } from "../../src/case.ts";
import { geofenceVerb, resolveSpatialFlags } from "../../src/verbs/geofence.ts";
import type { VerbContext } from "../../src/registry/types.ts";

// SF city-center anchor; sfNear is ≈1000.75 m due north (0.009° lat).
const SF = { lat: 37.7749, lng: -122.4194 };
const SF_NEAR = { lat: 37.7839, lng: -122.4194 };
const NY = { lat: 40.7128, lng: -74.006 };

function geo(opts: { verb?: string; gps?: unknown; time?: string; created?: string; ref?: string; state?: string }): OvercastRecord {
  const rec = makeRecord({
    verb: opts.verb ?? "exif",
    format: "json",
    payload: {
      summary: `evidence at ${opts.ref ?? "x"}`,
      ...(opts.gps !== undefined ? { gps: opts.gps } : {}),
      ...(opts.created ? { created: opts.created } : {}),
    },
    media: { ref: opts.ref ?? "a.jpg" },
    ...(opts.time ? { meta: { time: opts.time } } : {}),
    ...(opts.state ? { state: opts.state } : {}),
  });
  if (!opts.time) delete (rec.meta as Record<string, unknown>).time; // genuinely undated
  return rec;
}

function ctx(c: Case, opts: Record<string, unknown>): VerbContext {
  return { input: undefined, rest: [], opts, case: c, profile: { name: "t", providers: {} } } as unknown as VerbContext;
}

async function run(c: Case, opts: Record<string, unknown>): Promise<Record<string, any>> {
  const [rec] = await geofenceVerb.run(ctx(c, opts));
  return rec as Record<string, any>;
}

function seedCase(dir: string): Case {
  const c = openCase(dir);
  c.ensure();
  c.writeRecord(geo({ verb: "exif", gps: SF, time: "2021-01-01T00:00:00Z", ref: "sf_new.jpg" }));
  c.writeRecord(geo({ verb: "capture", gps: SF_NEAR, time: "2020-01-01T00:00:00Z", ref: "sf_near.jpg" }));
  c.writeRecord(geo({ verb: "scan", gps: NY, time: "2021-01-01T00:00:00Z", ref: "ny.jpg" }));
  c.writeRecord(geo({ verb: "note", ref: "no_gps.txt", time: "2021-01-01T00:00:00Z" })); // no gps → never matches
  c.writeRecord(geo({ verb: "exif", gps: SF, ref: "sf_undated.jpg" })); // no meta.time → undated
  c.writeRecord(geo({ verb: "exif", gps: SF, ref: "sf_error.jpg", state: "error" })); // skipped entirely
  return c;
}

test("geofence --near: radius subset, newest-first with undated last, per-verb counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const c = seedCase(dir);
    const rec = await run(c, { near: `${SF.lat},${SF.lng}`, radius: 1200 });
    assert.equal(rec.verb, "geofence");
    assert.equal(rec.state, "ready");
    const p = rec.payload;
    // sf_new + sf_near inside 1200 m; NY, the gps-less note, and the error record are out
    assert.deepEqual(
      p.matches.map((m: any) => m.ref),
      ["sf_new.jpg", "sf_near.jpg", "sf_undated.jpg"], // newest-first, undated last
    );
    assert.equal(p.count, 3);
    assert.equal(p.total, 3);
    assert.equal(p.gps_total, 4); // sf_new, sf_near, ny, sf_undated (error record never counted)
    assert.deepEqual(p.counts, { exif: 2, capture: 1 });
    assert.deepEqual(p.query.near, SF);
    assert.equal(p.query.radius_m, 1200);
    // dated matches carry an ISO capture_time; the undated one carries null
    assert.equal(p.matches[0].capture_time, "2021-01-01T00:00:00.000Z");
    assert.equal(p.matches[2].capture_time, null);
    assert.equal(p.matches[0].record_id.startsWith("rec_"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence --near: tightening the radius drops the ~1 km point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const rec = await run(seedCase(dir), { near: `${SF.lat},${SF.lng}`, radius: 900 });
    assert.deepEqual(rec.payload.matches.map((m: any) => m.ref), ["sf_new.jpg", "sf_undated.jpg"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence --bbox: box subset (SF in, NY out)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const rec = await run(seedCase(dir), { bbox: "37.7,-122.5,37.8,-122.3" });
    assert.deepEqual(rec.payload.matches.map((m: any) => m.ref), ["sf_new.jpg", "sf_near.jpg", "sf_undated.jpg"]);
    assert.deepEqual(rec.payload.query.bbox, { minLat: 37.7, minLng: -122.5, maxLat: 37.8, maxLng: -122.3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence --since/--until: time window excludes dated out-of-window points, keeps undated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const c = seedCase(dir);
    // since: 2020-06-01 → sf_near (2020-01) is out, sf_new (2021) in, undated kept
    const since = await run(c, { near: `${SF.lat},${SF.lng}`, radius: 1200, since: "2020-06-01" });
    assert.deepEqual(since.payload.matches.map((m: any) => m.ref), ["sf_new.jpg", "sf_undated.jpg"]);
    // until: 2020-06-01 → sf_new (2021) is out, sf_near (2020-01) in, undated kept
    const until = await run(c, { near: `${SF.lat},${SF.lng}`, radius: 1200, until: "2020-06-01" });
    assert.deepEqual(until.payload.matches.map((m: any) => m.ref), ["sf_near.jpg", "sf_undated.jpg"]);
    // both: an empty window
    const both = await run(c, { near: `${SF.lat},${SF.lng}`, radius: 1200, since: "2020-02-01", until: "2020-06-01" });
    assert.deepEqual(both.payload.matches.map((m: any) => m.ref), ["sf_undated.jpg"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence: exif capture time (payload.created) drives the window, not ingest time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const c = openCase(dir);
    c.ensure();
    // an OLD geotagged photo ingested recently must NOT pass a recent --since
    c.writeRecord(geo({ verb: "exif", gps: SF, created: "2019:01:01 00:00:00", time: "2021-06-01T00:00:00Z", ref: "old_capture.jpg" }));
    const rec = await run(c, { near: `${SF.lat},${SF.lng}`, radius: 100, since: "2020-06-01" });
    assert.equal(rec.payload.count, 0);
    // spatially inside the fence but excluded by the time window — the note must
    // point at the window, not claim a spatial miss (Bugbot #134).
    assert.match(rec.payload.note, /inside the area but outside the --since\/--until window/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence: flag validation errors (missing fence, both fences, malformed values)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const c = openCase(dir);
    c.ensure();
    assert.match((await run(c, {})).error!, /requires a fence/);
    assert.match((await run(c, { near: "1,2", bbox: "0,0,1,1" })).error!, /mutually exclusive/);
    assert.match((await run(c, { near: "91,0" })).error!, /invalid --near/);
    assert.match((await run(c, { near: "not-a-point" })).error!, /invalid --near/);
    assert.match((await run(c, { bbox: "1,2,3" })).error!, /invalid --bbox/);
    assert.match((await run(c, { bbox: "-1,170,1,-170" })).error!, /invalid --bbox/); // wrapping box
    assert.match((await run(c, { near: "1,2", radius: -5 })).error!, /invalid --radius/);
    assert.match((await run(c, { radius: 100 })).error!, /--radius requires --near/);
    // a stray --radius alongside a valid --bbox is IGNORED, not a hard error (Bugbot #134)
    assert.equal((await run(c, { bbox: "0,0,1,1", radius: 100 })).error, undefined);
    assert.match((await run(c, { near: "1,2", since: "not-a-date" })).error!, /invalid --since/);
    assert.match((await run(c, { near: "1,2", until: "nope" })).error!, /invalid --until/);
    assert.match((await run(c, { near: "1,2", limit: 0 })).error!, /invalid --limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence: empty intersection is a clean ready record with targeted guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const c = openCase(dir);
    c.ensure();
    // no gps-bearing records at all
    const noGps = await run(c, { near: "10,10", radius: 500 });
    assert.equal(noGps.state, "ready");
    assert.equal(noGps.payload.count, 0);
    assert.match(noGps.payload.note, /no GPS-bearing records/);
    // gps records exist but the fence misses them
    c.writeRecord(geo({ verb: "exif", gps: SF, time: "2021-01-01T00:00:00Z", ref: "sf.jpg" }));
    const missed = await run(c, { near: "10,10", radius: 500 });
    assert.equal(missed.state, "ready");
    assert.equal(missed.payload.gps_total, 1);
    assert.match(missed.payload.note, /none fall inside the area/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence: --limit pages newest-first, total reflects the full intersection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geofence-"));
  try {
    const rec = await run(seedCase(dir), { near: `${SF.lat},${SF.lng}`, radius: 1200, limit: 1 });
    assert.equal(rec.payload.count, 1);
    assert.equal(rec.payload.total, 3);
    assert.equal(rec.payload.matches[0].ref, "sf_new.jpg"); // newest
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geofence records are operational — quarantined from ask/brief evidence", () => {
  assert.ok(OPERATIONAL_VERBS.has("geofence"));
  const rec = makeRecord({ verb: "geofence", format: "json", payload: { mode: "geofence" }, state: "ready" });
  assert.equal(isMemoryRecord(rec), false);
});

test("resolveSpatialFlags: no flags → neither spatial nor error (map's optional use)", () => {
  assert.deepEqual(resolveSpatialFlags({}), {});
  const near = resolveSpatialFlags({ near: "1,2" });
  assert.equal(near.error, undefined);
  assert.deepEqual(near.spatial, { center: { lat: 1, lng: 2 }, radiusMeters: 500 }); // default radius
});

test("buildMapModel spatial pre-filter: --near drops out-of-radius points, gpsTotal stays pre-filter", () => {
  const recs = [
    geo({ verb: "exif", gps: SF, time: "2021-01-01T00:00:00Z", ref: "sf.jpg" }),
    geo({ verb: "scan", gps: NY, time: "2021-01-01T00:00:00Z", ref: "ny.jpg" }),
  ];
  const opts = { caseName: "case", caseDir: "/tmp/case", now: 1_700_000_000_000 };
  const near = buildMapModel(recs, { ...opts, spatial: { center: SF, radiusMeters: 1000 } });
  assert.deepEqual(near.points.map((p) => p.ref), ["sf.jpg"]);
  assert.equal(near.gpsTotal, 2); // pre-filter: distinguishes "filtered out" from "no gps"
  const box = buildMapModel(recs, { ...opts, spatial: { bbox: { minLat: 40, minLng: -75, maxLat: 41, maxLng: -73 } } });
  assert.deepEqual(box.points.map((p) => p.ref), ["ny.jpg"]);
  const none = buildMapModel(recs, opts); // no spatial → unchanged behavior
  assert.equal(none.points.length, 2);
});
