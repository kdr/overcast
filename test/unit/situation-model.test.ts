import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { buildSituationModel } from "../../src/situation/model.ts";
import type { SourceEntry } from "../../src/state/source.ts";

const NOW = Date.parse("2026-07-10T12:00:00Z");

function src(type: string, ref = "x", enabled = true): SourceEntry {
  return { id: `src_${type}`, type, ref, enabled, created: "2026-07-01T00:00:00Z" };
}

function opts(over: Partial<Parameters<typeof buildSituationModel>[1]> = {}) {
  return {
    caseName: "tc",
    caseDir: "/tmp/tc",
    config: {},
    sources: [] as SourceEntry[],
    now: NOW,
    fileExists: () => true,
    ...over,
  };
}

function scanHit(over: Partial<{ payload: Record<string, unknown>; time: string; state: string; error: string }> = {}): OvercastRecord {
  const rec = makeRecord({
    verb: "scan",
    format: "json",
    payload: {
      title: "clip on the topic",
      url: "https://example.com/post/1",
      source: "web",
      source_id: "src_web",
      published: "2026-07-10T10:00:00Z",
      snippet: "something happened",
      ...(over.payload ?? {}),
    },
    meta: { time: over.time ?? "2026-07-10T11:00:00Z" },
    ...(over.state ? { state: over.state } : {}),
    ...(over.error ? { error: over.error } : {}),
  });
  return rec;
}

test("situation model: feed = scan hits newest-first, pull_progress excluded, errors surfaced", () => {
  const records = [
    scanHit({ payload: { url: "https://e.com/old" }, time: "2026-07-09T00:00:00Z" }),
    scanHit({ payload: { url: "https://e.com/new" }, time: "2026-07-10T11:30:00Z" }),
    scanHit({ payload: { op: "pull_progress", url: "https://e.com/progress" } }),
    scanHit({ payload: { url: "https://e.com/broken", title: "" }, state: "needs_credentials", error: "APIFY_TOKEN missing" }),
  ];
  const m = buildSituationModel(records, opts());
  assert.equal(m.feed.length, 3, "pull_progress rows stay out of the feed");
  assert.equal(m.feed[0].url, "https://e.com/new");
  const cred = m.feed.find((f) => f.state === "needs_credentials");
  assert.ok(cred, "cred-gap hits surface as feed cards");
  assert.equal(cred!.error, "APIFY_TOKEN missing");
});

test("situation model: feed honors --source and --since (undated kept)", () => {
  const records = [
    scanHit({ payload: { source: "web", url: "https://e.com/a" }, time: "2026-07-10T11:00:00Z" }),
    scanHit({ payload: { source: "dork", source_id: "src_dork", url: "https://e.com/b" }, time: "2026-07-10T11:00:00Z" }),
    scanHit({ payload: { source: "web", url: "https://e.com/stale" }, time: "2026-06-01T00:00:00Z" }),
  ];
  const bySource = buildSituationModel(records, opts({ config: { source: "dork" } }));
  assert.deepEqual(bySource.feed.map((f) => f.url), ["https://e.com/b"]);
  const since = buildSituationModel(records, opts({ config: { since: "48h" } }));
  assert.ok(!since.feed.some((f) => f.url === "https://e.com/stale"), "--since drops stale hits");
});

test("situation model: panels auto-pick from sources and records; explicit config pins", () => {
  // nothing but a web source → wall off, feed on, map/stills off
  let m = buildSituationModel([], opts({ sources: [src("web")] }));
  assert.deepEqual(m.panels, ["feed"]);
  // a youtube source lights the wall before any media lands
  m = buildSituationModel([], opts({ sources: [src("youtube"), src("webcam"), src("flights")] }));
  assert.deepEqual(m.panels, ["wall", "feed", "map", "stills"]);
  // gps-bearing records light the map without a gps source
  const gpsRec = makeRecord({ verb: "exif", format: "json", payload: { gps: { lat: 48.85, lng: 2.35 } }, meta: { time: "2026-07-10T09:00:00Z" } });
  m = buildSituationModel([gpsRec], opts());
  assert.ok(m.panels.includes("map"));
  // explicit panels override everything
  m = buildSituationModel([gpsRec], opts({ config: { panels: ["map"] } }));
  assert.deepEqual(m.panels, ["map"]);
  assert.deepEqual(m.config.panels, ["map"]);
});

test("situation model: wall tiles carry local/remote media refs", () => {
  const local = makeRecord({
    verb: "capture",
    format: "json",
    payload: { capture_id: "cap_a", path: "/tmp/tc/a.mp4", source: "youtube" },
    media: { ref: "/tmp/tc/a.mp4" },
    meta: { time: "2026-07-10T10:00:00Z" },
  });
  const remote = makeRecord({
    verb: "watch",
    format: "json",
    payload: { content: "seen" },
    media: { ref: "https://cdn.example.com/b.mp4" },
    meta: { time: "2026-07-10T10:30:00Z" },
  });
  const m = buildSituationModel([local, remote], opts());
  const localTile = m.tiles.find((t) => t.ref === "/tmp/tc/a.mp4");
  const remoteTile = m.tiles.find((t) => t.ref === "https://cdn.example.com/b.mp4");
  assert.deepEqual(localTile?.media, { local: "/tmp/tc/a.mp4" });
  assert.equal(localTile?.mode, "video");
  assert.deepEqual(remoteTile?.media, { remote: "https://cdn.example.com/b.mp4" });
});

test("situation model: stills keep the freshest capture per source url; screenshots included", () => {
  const older = makeRecord({
    verb: "capture",
    format: "json",
    payload: { url: "https://cam.example/1", source: "webcam", title: "harbor cam" },
    media: { ref: "/tmp/tc/cam_old.jpg" },
    meta: { time: "2026-07-10T09:00:00Z" },
  });
  const newer = makeRecord({
    verb: "capture",
    format: "json",
    payload: { url: "https://cam.example/1", source: "webcam", title: "harbor cam" },
    media: { ref: "/tmp/tc/cam_new.jpg" },
    meta: { time: "2026-07-10T11:00:00Z" },
  });
  const shot = makeRecord({
    verb: "screenshot",
    format: "json",
    payload: { url: "https://page.example/" },
    media: { ref: "/tmp/tc/page.png" },
    meta: { time: "2026-07-10T10:00:00Z" },
  });
  const m = buildSituationModel([older, newer, shot], opts());
  assert.equal(m.stills.length, 2);
  const cam = m.stills.find((s) => s.key === "https://cam.example/1");
  assert.deepEqual(cam?.media, { local: "/tmp/tc/cam_new.jpg" }, "newest capture wins the cell");
  assert.equal(m.stills.find((s) => s.key === "https://page.example/")?.source, "screenshot");
});

test("situation model: map points inherit flight track keys", () => {
  const a = makeRecord({
    verb: "scan",
    format: "json",
    payload: { title: "AF447", url: "https://sky.example/af447/1", source: "flights", icao24: "ABC123", gps: { lat: 48.0, lng: 2.0 } },
    meta: { time: "2026-07-10T10:00:00Z" },
  });
  const b = makeRecord({
    verb: "scan",
    format: "json",
    payload: { title: "AF447", url: "https://sky.example/af447/2", source: "flights", icao24: "ABC123", gps: { lat: 48.2, lng: 2.4 } },
    meta: { time: "2026-07-10T10:05:00Z" },
  });
  const m = buildSituationModel([a, b], opts());
  assert.equal(m.points.length, 2);
  assert.ok(m.points.every((p) => p.track === "abc123"), "shared icao24 groups a track");
  assert.ok(m.bounds, "bounds derived for the fit");
});

test("situation model: --source filters ALL panels consistently (type + id)", () => {
  const ytCap = makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_y", path: "/tmp/tc/y.mp4", source: "youtube", source_id: "src_yt" }, media: { ref: "/tmp/tc/y.mp4" }, meta: { time: "2026-07-10T10:00:00Z" } });
  const ytWatch = makeRecord({ verb: "watch", format: "json", payload: { content: "x" }, media: { ref: "/tmp/tc/y.mp4", at: 2 }, meta: { time: "2026-07-10T10:01:00Z" } });
  const flight = makeRecord({ verb: "scan", format: "json", payload: { title: "AF", url: "https://sky/1", source: "flights", source_id: "src_fl", gps: { lat: 48, lng: 2 } }, meta: { time: "2026-07-10T10:02:00Z" } });
  const webHit = makeRecord({ verb: "scan", format: "json", payload: { title: "art", url: "https://e.com/a", source: "web", source_id: "src_web" }, meta: { time: "2026-07-10T10:03:00Z" } });
  const camCap = makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_c", source: "webcam", url: "https://cam/1", source_url: "https://cam/1" }, media: { ref: "/tmp/tc/cam.jpg" }, meta: { time: "2026-07-10T10:04:00Z" } });
  const recs = [ytCap, ytWatch, flight, webHit, camCap];

  // filter to youtube (by type): only the wall tile survives; feed/map/stills empty
  let m = buildSituationModel(recs, opts({ config: { source: "youtube" }, sources: [src("youtube"), src("flights"), src("web"), src("webcam")] }));
  assert.deepEqual(m.tiles.map((t) => t.ref), ["/tmp/tc/y.mp4"], "wall keeps only youtube");
  assert.equal(m.feed.length, 0, "feed excludes non-youtube");
  assert.equal(m.points.length, 0, "map excludes non-youtube");
  assert.equal(m.stills.length, 0, "stills exclude non-youtube");

  // filter to flights: only the map point; nothing else
  m = buildSituationModel(recs, opts({ config: { source: "flights" } }));
  assert.equal(m.tiles.length, 0);
  assert.equal(m.points.length, 1);
  assert.equal(m.stills.length, 0);

  // filter by a registered SOURCE ID (src_web) — feed keeps it, others empty
  m = buildSituationModel(recs, opts({ config: { source: "src_web" } }));
  assert.deepEqual(m.feed.map((f) => f.source), ["web"]);
  assert.equal(m.tiles.length, 0);
  assert.equal(m.stills.length, 0);
});

test("situation model: theme defaults to csi on the wire; plain honored", () => {
  assert.equal(buildSituationModel([], opts()).config.theme, "csi");
  assert.equal(buildSituationModel([], opts({ config: { theme: "plain" } })).config.theme, "plain");
});
