import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWallModel, renderWallHtml, type BuildWallOptions } from "../../src/report/wall.ts";
import { wallVerb } from "../../src/verbs/wall.ts";
import { FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord, memoryRecords, type OvercastRecord } from "../../src/record.ts";
import type { VerbContext } from "../../src/registry/types.ts";

// ---- pure model assembly (no fs; injectable clock + fileExists) --------------

const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const T = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function opts(over: Partial<BuildWallOptions> = {}): BuildWallOptions {
  return { caseName: "test", caseDir: "/case", limit: 12, now: NOW, fileExists: () => true, ...over };
}

const A = "/media/a.mp4";

function watchRec(ref: string, over: { at?: number | [number, number]; title?: string; duration?: number; time?: string } = {}): OvercastRecord {
  return makeRecord({
    verb: "watch",
    payload: { content: `what happens in ${ref}`, transcript: "", detailed: null },
    media: over.at != null ? { ref, at: over.at } : { ref },
    meta: { time: over.time ?? T(60), title: over.title, duration_seconds: over.duration },
  });
}

function faceRec(ref: string, moments: Array<Record<string, unknown>>, count = moments.length): OvercastRecord {
  return makeRecord({
    verb: "face",
    payload: { op: "detect", summary: `found ${count} face(s)`, count, moments, faces: [] },
    media: { ref },
    meta: { time: T(40) },
  });
}

function findingRec(ref: string, at: number | [number, number] | undefined, time = T(10)): OvercastRecord {
  return makeRecord({
    verb: "finding",
    payload: { text: "suspect visible", target: "", source_record: "manual", source_verb: "manual", trigger: "human", status: "open" },
    media: at != null ? { ref, at } : { ref },
    meta: { time },
  });
}

test("anchor precedence: finding > best face moment > record anchor > start", () => {
  const watch = watchRec(A, { at: 7, duration: 120 });
  const face = faceRec(A, [{ at: 12, similarity: 87 }, { at: 30, similarity: 91 }], 2);
  const finding = findingRec(A, 44);

  const withFinding = buildWallModel([watch, face, finding], opts()).tiles[0];
  assert.deepEqual(withFinding.anchor, { at: 44, start: 42, end: 50, source: "finding" });

  const withFace = buildWallModel([watch, face], opts()).tiles[0];
  assert.equal(withFace.anchor.source, "face");
  assert.equal(withFace.anchor.at, 30); // highest similarity wins, not first

  const withRecord = buildWallModel([watch], opts()).tiles[0];
  assert.deepEqual(withRecord.anchor, { at: 7, start: 5, end: 13, source: "record" });

  const detectOnly = faceRec(A, [{ at: 30 }]);
  const unscoredDetectFallsThrough = buildWallModel([watch, detectOnly], opts()).tiles[0];
  assert.deepEqual(unscoredDetectFallsThrough.anchor, { at: 7, start: 5, end: 13, source: "record" });

  const bare = buildWallModel([watchRec(A)], opts()).tiles[0];
  assert.deepEqual(bare.anchor, { at: 0, start: 0, end: 6, source: "start" });
});

test("record fallback prefers the NEWEST anchored sense; undated never shadows dated", () => {
  // an older listen anchor must not shadow the fresher watch anchor (Bugbot #37)
  const oldListen = makeRecord({ verb: "listen", payload: {}, media: { ref: A, at: 2 }, meta: { time: T(90) } });
  const newWatch = watchRec(A, { at: 7, time: T(20) });
  const newest = buildWallModel([oldListen, newWatch], opts()).tiles[0];
  assert.equal(newest.anchor.at, 7);

  // undated records sort LAST — the newest dated anchor still wins
  const undated = makeRecord({ verb: "capture", payload: { capture_id: "cap_u" }, media: { ref: A, at: 1 }, meta: { time: undefined } });
  const datedWins = buildWallModel([undated, newWatch], opts()).tiles[0];
  assert.equal(datedWins.anchor.at, 7);

  // same rule for findings: an undated finding never beats the newest dated one
  const datedFinding = findingRec(A, 44, T(10));
  const undatedFinding = makeRecord({
    verb: "finding",
    payload: { text: "undated", target: "", source_record: "manual", source_verb: "manual", trigger: "human", status: "open" },
    media: { ref: A, at: 20 },
    meta: { time: undefined },
  });
  const f = buildWallModel([newWatch, undatedFinding, datedFinding], opts()).tiles[0];
  assert.equal(f.anchor.at, 44);

  // a pending/failed sense never sets the loop, even when it's the newest
  const pendingNewer = makeRecord({ verb: "listen", payload: {}, media: { ref: A, at: 3 }, state: "pending", meta: { time: T(1) } });
  const readyWins = buildWallModel([newWatch, pendingNewer], opts()).tiles[0];
  assert.equal(readyWins.anchor.at, 7);
  const onlyPending = makeRecord({ verb: "watch", payload: {}, media: { ref: A, at: 3 }, state: "pending", meta: { time: T(1) } });
  const noReadyAnchor = buildWallModel([onlyPending], opts()).tiles[0];
  assert.equal(noReadyAnchor.anchor.source, "start");
});

test("tile title/summary/source come from the NEWEST records, matching the anchor rule", () => {
  const oldWatch = watchRec(A, { title: "Old title", time: T(90) });
  (oldWatch.payload as Record<string, unknown>).content = "old analysis";
  const newWatch = watchRec(A, { title: "New title", time: T(10) });
  (newWatch.payload as Record<string, unknown>).content = "new analysis";
  const oldCap = makeRecord({ verb: "capture", payload: { capture_id: "c1", source: "youtube" }, media: { ref: A }, meta: { time: T(80) } });
  const newCap = makeRecord({ verb: "capture", payload: { capture_id: "c2", source: "tiktok" }, media: { ref: A }, meta: { time: T(5) } });

  const tile = buildWallModel([oldWatch, oldCap, newWatch, newCap], opts()).tiles[0];
  assert.equal(tile.title, "New title");
  assert.match(tile.summary, /new analysis/);
  assert.equal(tile.sourceType, "tiktok");
});

test("duration comes from any ready sense, not just watch; player re-clamps at loadedmetadata", () => {
  // capture-only feed with a known duration still clamps the window
  const capture = makeRecord({
    verb: "capture",
    payload: { capture_id: "cap_a" },
    media: { ref: A, at: 30 },
    meta: { time: T(10), duration_seconds: 8 },
  });
  const tile = buildWallModel([capture], opts()).tiles[0];
  assert.equal(tile.duration, 8);
  assert.deepEqual({ start: tile.anchor.start, end: tile.anchor.end }, { start: 0, end: 8 });
  // and the inline player clamps against the browser-known real duration
  const html = renderWallHtml(buildWallModel([capture], opts()), "csi");
  assert.match(html, /Math\.min\(end, v\.duration\)/);
});

test("span anchors: short spans loop verbatim, long spans window, clamp falls back to the head", () => {
  const short = buildWallModel([watchRec(A, { at: [5, 9] })], opts()).tiles[0];
  assert.deepEqual(short.anchor, { at: 5, start: 5, end: 9, source: "record", span: true });

  const long = buildWallModel([watchRec(A, { at: [5, 60] })], opts()).tiles[0];
  assert.deepEqual(long.anchor, { at: 5, start: 3, end: 11, source: "record" });

  // anchor beyond the clip: end clamps under start → loop the head instead
  const clamped = buildWallModel([watchRec(A, { at: 30, duration: 8 })], opts()).tiles[0];
  assert.deepEqual(clamped.anchor, { at: 8, start: 0, end: 8, source: "record" });

  // a duration-truncated span is no longer verbatim — the marker drops and the
  // intel command falls back to the point form
  const truncated = buildWallModel([watchRec(A, { at: [4, 12], duration: 8 })], opts()).tiles[0];
  assert.deepEqual(truncated.anchor, { at: 4, start: 4, end: 8, source: "record" });
  const truncatedHtml = renderWallHtml(buildWallModel([watchRec(A, { at: [4, 12], duration: 8 })], opts()), "csi");
  assert.match(truncatedHtml, /--at 4</);
});

test("coverage, face count, see frame-stem join; dismissed findings don't count", () => {
  const watch = watchRec(A, { title: "Pier Cam 4", duration: 120 });
  const pendingListen = makeRecord({ verb: "listen", payload: {}, media: { ref: A }, state: "pending", meta: { time: T(50) } });
  const face = faceRec(A, [{ at: 12, similarity: 87 }], 3);
  // see persists the extracted frame path, not the video ref — joined by stem
  const see = makeRecord({ verb: "see", payload: { caption: "a pier" }, media: { ref: "/case/.overcast/media/a_t12.jpg" }, meta: { time: T(45) } });
  const open = findingRec(A, 44);
  const dismissedRoot = findingRec(A, 20, T(25));
  const review = makeRecord({
    verb: "finding",
    payload: { finding_id: dismissedRoot.id, status: "dismissed", reviewed_at: T(5) },
    meta: { time: T(5) },
  });

  const tile = buildWallModel([watch, pendingListen, face, see, open, dismissedRoot, review], opts()).tiles[0];
  assert.equal(tile.title, "Pier Cam 4");
  assert.equal(tile.duration, 120);
  assert.deepEqual(tile.coverage, { watch: true, listen: false, see: true, face: true });
  assert.equal(tile.faceCount, 3);
  assert.equal(tile.openFindings, 1); // the dismissed root is excluded
  assert.match(tile.summary, /what happens in/); // watch content wins the intel summary
  // the dismissed finding's anchor (20) must not win over the open one (44)
  assert.equal(tile.anchor.at, 44);
});

test("ranking (findings > coverage > faces), limit, and --source/--since filters", () => {
  const a = [watchRec(A, { duration: 120 }), findingRec(A, 44)];
  const B = "/media/b.mp4";
  const b = [
    makeRecord({ verb: "capture", payload: { capture_id: "cap_b", source: "youtube", url: "https://y/b" }, media: { ref: B }, meta: { time: T(30) } }),
    watchRec(B, { time: T(20) }),
  ];
  const C = "/media/c.mp4";
  const c = [makeRecord({ verb: "capture", payload: { capture_id: "cap_c" }, media: { ref: C }, meta: { time: T(200) } })];
  const records = [...a, ...b, ...c];

  const full = buildWallModel(records, opts());
  assert.deepEqual(full.tiles.map((t) => t.ref), [A, B, C]);
  assert.equal(full.hud.totalVideos, 3);

  const limited = buildWallModel(records, opts({ limit: 2 }));
  assert.equal(limited.tiles.length, 2);
  assert.equal(limited.hud.tilesShown, 2);
  assert.equal(limited.hud.totalVideos, 3);

  const youtube = buildWallModel(records, opts({ source: "youtube" }));
  assert.deepEqual(youtube.tiles.map((t) => t.ref), [B]);
  // unattributed media matches "local"
  const local = buildWallModel(records, opts({ source: "local" }));
  assert.deepEqual(local.tiles.map((t) => t.ref).sort(), [A, C]);

  const recent = buildWallModel(records, opts({ sinceCutoff: NOW - 100 * 60_000 }));
  assert.ok(!recent.tiles.some((t) => t.ref === C)); // C's last record is 200m old
});

test("HUD: last scan per source, monitor freshness, brief age, counts", () => {
  const records = [
    watchRec(A),
    makeRecord({ verb: "scan", payload: { title: "hit", source: "youtube" }, meta: { time: T(12) } }),
    makeRecord({ verb: "scan", payload: { title: "old hit", source: "youtube" }, meta: { time: T(90) } }),
    makeRecord({ verb: "scan", payload: { title: "tt hit", source: "tiktok" }, meta: { time: T(180) } }),
    makeRecord({ verb: "scan", payload: { op: "pull_progress", source: "youtube" }, meta: { time: T(1) } }), // ignored
    // a failed sweep must not make youtube look freshly scanned, and a source
    // with ONLY failed sweeps must not appear at all
    makeRecord({ verb: "scan", payload: { title: "boom", source: "youtube" }, state: "error", error: "x", meta: { time: T(2) } }),
    makeRecord({ verb: "scan", payload: { title: "blocked", source: "web" }, state: "needs_credentials", meta: { time: T(4) } }),
    makeRecord({ verb: "monitor", payload: { new_items: 2, total_hits: 5 }, meta: { time: T(3) } }),
    makeRecord({ verb: "brief", payload: { report: "x" }, meta: { time: T(120) } }),
    findingRec(A, 44),
  ];
  const hud = buildWallModel(records, opts()).hud;
  assert.deepEqual(
    hud.lastScans.map((s) => ({ source: s.source, ageSeconds: s.ageSeconds })),
    [{ source: "youtube", ageSeconds: 12 * 60 }, { source: "tiktok", ageSeconds: 180 * 60 }],
  );
  assert.equal(hud.lastScanAgeSeconds, 12 * 60);
  assert.equal(hud.monitor?.newItems, 2);
  assert.equal(hud.monitor?.ageSeconds, 3 * 60);
  assert.equal(hud.briefAgeSeconds, 120 * 60);
  assert.equal(hud.openFindings, 1);
  assert.equal(hud.counts.scan, 6);
  assert.ok(!hud.lastScans.some((s) => s.source === "web"), "failed-only source leaked into the HUD");
});

test("scan page URLs never tile; missing files and remote media classify correctly", () => {
  const records = [
    makeRecord({ verb: "scan", payload: { title: "hit", source: "youtube" }, media: { ref: "https://youtube.com/watch?v=x" }, meta: { time: T(5) } }),
    watchRec(A),
    watchRec("/media/gone.mp4", { time: T(10) }),
    makeRecord({ verb: "capture", payload: { capture_id: "cap_d", source: "tiktok" }, media: { ref: "https://cdn.example.com/d.mp4?sig=1" }, meta: { time: T(5) } }),
  ];
  const model = buildWallModel(records, opts({ fileExists: (p) => p !== "/media/gone.mp4" }));
  assert.equal(model.hud.totalVideos, 3); // the scan hit is not a tile
  const byRef = new Map(model.tiles.map((t) => [t.ref, t]));
  assert.equal(byRef.get(A)?.mode, "video");
  assert.equal(byRef.get("/media/gone.mp4")?.mode, "down");
  assert.equal(byRef.get("/media/gone.mp4")?.fileUrl, null);
  const remote = byRef.get("https://cdn.example.com/d.mp4?sig=1");
  assert.equal(remote?.mode, "video"); // extension test ignores the query string
  assert.equal(remote?.fileUrl, "https://cdn.example.com/d.mp4?sig=1");
});

test("remote browser-hostile media is STILL (exists, unplayable), not DOWN", () => {
  const records = [watchRec("https://cdn.example.com/feed.mkv", { time: T(5) })];
  const tile = buildWallModel(records, opts()).tiles[0];
  assert.equal(tile.mode, "still");
  assert.equal(tile.fileUrl, "https://cdn.example.com/feed.mkv");
});

// ---- rendering ----------------------------------------------------------------

test("csi render: theme markers, tiles with loop windows, NO SIGNAL, refresh meta, escaping", () => {
  const records = [
    watchRec(A, { at: 7, title: '<script>alert(1)</script> cam', duration: 120 }),
    watchRec("/media/gone.mp4", { time: T(10) }),
  ];
  const model = buildWallModel(records, opts({ fileExists: (p) => p !== "/media/gone.mp4", refreshSeconds: 45 }));
  const html = renderWallHtml(model, "csi");

  assert.match(html, /data-overcast-theme="csi"/);
  assert.match(html, /data-csi-wall="true"/);
  assert.equal(html.match(/<figure class="tile/g)?.length, 2);
  assert.match(html, /data-start="5" data-end="13"/);
  assert.match(html, /NO SIGNAL/);
  assert.match(html, /● DOWN/);
  assert.match(html, /<meta http-equiv="refresh" content="45">/);
  // the hostile title is escaped, never markup
  assert.ok(!html.includes("<script>alert"), "raw <script> leaked into HTML");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; cam/);

  const noRefresh = renderWallHtml(buildWallModel(records, opts({ fileExists: () => true })), "csi");
  assert.ok(!noRefresh.includes("http-equiv"), "refresh meta present without --refresh");
});

test("--infinite: hud flag, data-infinite marker, and the 3-col floor for tiny walls", () => {
  const on = buildWallModel([watchRec(A)], opts({ infinite: true }));
  assert.equal(on.hud.infinite, true);
  const html = renderWallHtml(on, "csi");
  assert.match(html, /data-infinite="true"/);
  // one real feed still lays out as a monitor bank, not a full-width billboard
  assert.match(html, /--cols:3/);
  // the page script carries the repeat/extend machinery + manual scroll
  // compensation (native anchoring is disabled so it can't double-apply)
  assert.match(html, /appendChunk/);
  assert.match(html, /overflow-anchor:none/);

  const off = buildWallModel([watchRec(A)], opts());
  assert.equal(off.hud.infinite, false);
  const offHtml = renderWallHtml(off, "plain");
  // the attribute form specifically — the shared player script always mentions
  // the data-infinite name, but only --infinite sets it on the grid
  assert.ok(!offHtml.includes('data-infinite="true"'), "default wall must not carry the infinite marker");
  assert.match(offHtml, /--cols:1/); // sqrt grid unchanged when off

  // the floor never shrinks a wall the sqrt rule already made wider
  const many = Array.from({ length: 12 }, (_, i) => watchRec(`/media/m${i}.mp4`));
  assert.match(renderWallHtml(buildWallModel(many, opts({ infinite: true })), "plain"), /--cols:4/);
});

test("plain render: same grid + player script, no csi marker", () => {
  const model = buildWallModel([watchRec(A)], opts());
  const html = renderWallHtml(model, "plain");
  assert.ok(!html.includes('data-overcast-theme="csi"'), "plain must not carry the csi marker");
  assert.ok(!html.includes("data-csi-wall"));
  assert.equal(html.match(/<figure class="tile/g)?.length, 1);
  assert.match(html, /IntersectionObserver/); // the shared wall JS is present
});

// ---- the verb (real fs; tiny lavfi clips) --------------------------------------

let dir: string;
let clip: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-wall-"));
  clip = join(dir, "tiny.mp4");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "testsrc=size=128x96:rate=10:duration=1", "-pix_fmt", "yuv420p", clip],
    { stdio: "ignore" },
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

function ctx(caseDir: string, o: VerbContext["opts"] = {}): VerbContext {
  const c = openCase(caseDir);
  c.ensure();
  return { input: undefined, rest: [], opts: o, case: c, profile: defaultProfile() };
}

test("wall --no-open writes mediaDir/wall.html referencing the clip by file:// URL", async () => {
  const vc = ctx(dir, { "no-open": true, theme: "csi" });
  vc.case.writeRecord(watchRec(clip, { title: "Tiny", duration: 1 }));

  const [rec] = await wallVerb.run(vc);
  assert.equal(rec.state, "ready");
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.mode, "wall");
  assert.equal(p.opened, false);
  assert.equal(p.tiles, 1);
  const viewer = p.viewer as string;
  assert.equal(viewer, join(vc.case.mediaDir, "wall.html"));
  assert.ok(existsSync(viewer));
  const html = readFileSync(viewer, "utf8");
  assert.ok(html.includes(pathToFileURL(clip).href), "clip file:// URL missing from the wall");
  assert.match(html, /data-overcast-theme="csi"/);
  const refs = p.tile_refs as Array<Record<string, unknown>>;
  assert.equal(refs[0].ref, clip);
});

test("wall escapes a media path with quotes/specials (no HTML/attr breakage)", async () => {
  const nastyDir = mkdtempSync(join(tmpdir(), "oc-wall-nasty-"));
  try {
    const nasty = join(nastyDir, 'a"<b> .mp4');
    execFileSync(
      FFMPEG_PATH,
      ["-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-pix_fmt", "yuv420p", nasty],
      { stdio: "ignore" },
    );
    const vc = ctx(nastyDir, { "no-open": true });
    vc.case.writeRecord(watchRec(nasty));
    const [rec] = await wallVerb.run(vc);
    const html = readFileSync((rec.payload as Record<string, unknown>).viewer as string, "utf8");
    const srcMatch = html.match(/data-src="([^"]*)"/);
    assert.ok(srcMatch, "video data-src attribute present and quote-balanced");
    assert.match(srcMatch![1], /%22%3Cb%3E/); // quote + <b> percent-encoded in the URL
    assert.ok(!html.includes("<b>"), "raw <b> leaked into HTML body");
  } finally {
    rmSync(nastyDir, { recursive: true, force: true });
  }
});

test("wall --infinite threads to the record payload and the page", async () => {
  const vc = ctx(dir, { "no-open": true, infinite: true });
  const [rec] = await wallVerb.run(vc);
  assert.equal(rec.state, "ready");
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.infinite, true);
  assert.match(readFileSync(p.viewer as string, "utf8"), /data-infinite="true"/);

  const [plain] = await wallVerb.run(ctx(dir, { "no-open": true }));
  assert.equal((plain.payload as Record<string, unknown>).infinite, false);
});

test("empty case → transient pending record, no wall.html written", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "oc-wall-empty-"));
  try {
    const vc = ctx(emptyDir, { "no-open": true });
    const [rec] = await wallVerb.run(vc);
    assert.equal(rec.state, "pending");
    assert.equal(rec.meta?.transient, true);
    assert.match((rec.payload as Record<string, unknown>).note as string, /no case videos/);
    assert.ok(!existsSync(join(vc.case.mediaDir, "wall.html")));
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("filters that match nothing → transient pending, no artifact", async () => {
  const vc = ctx(dir, { "no-open": true, source: "tiktok" });
  const [rec] = await wallVerb.run(vc);
  assert.equal(rec.state, "pending");
  assert.match((rec.payload as Record<string, unknown>).note as string, /filters matched no case videos/);
});

test("browser-hostile container gets a poster still; garbage media degrades to static", async () => {
  const mkvDir = mkdtempSync(join(tmpdir(), "oc-wall-mkv-"));
  try {
    const mkv = join(mkvDir, "feed.mkv");
    execFileSync(
      FFMPEG_PATH,
      ["-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-pix_fmt", "yuv420p", mkv],
      { stdio: "ignore" },
    );
    const garbage = join(mkvDir, "broken.avi");
    writeFileSync(garbage, "not a real video");

    const vc = ctx(mkvDir, { "no-open": true });
    vc.case.writeRecord(watchRec(mkv));
    vc.case.writeRecord(watchRec(garbage, { time: T(10) }));
    vc.case.writeRecord(watchRec("https://cdn.example.com/remote.mkv", { time: T(20) }));
    const [rec] = await wallVerb.run(vc);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.stills, 3); // local mkv + garbage avi + remote mkv — none browser-safe
    const html = readFileSync(p.viewer as string, "utf8");
    assert.match(html, /class="tile still"/);
    assert.match(html, /STILL/);
    // the real mkv produced an extracted poster frame; the garbage one didn't,
    // and the remote one is never handed to ffmpeg (no network from the poster pass)
    assert.match(html, /img class="poster"[^>]*feed_t0\.jpg/);
    assert.ok(!html.match(/broken_t\d+\.jpg/), "garbage media must not claim a poster");
    assert.ok(!html.match(/remote_t\d+\.jpg/), "remote media must not claim a poster");
  } finally {
    rmSync(mkvDir, { recursive: true, force: true });
  }
});

test("see coverage joins only exact extractFrame stills, not prefix cousins", () => {
  const seeFor = (frame: string) =>
    makeRecord({ verb: "see", payload: { caption: "x" }, media: { ref: `/case/.overcast/media/${frame}` }, meta: { time: T(5) } });
  // a_tool_t12.jpg must never light a.mp4's S badge ("a_tool_t" starts with "a_t")
  const cousin = buildWallModel([watchRec(A), seeFor("a_tool_t12.jpg")], opts()).tiles[0];
  assert.equal(cousin.coverage.see, false);
  const exact = buildWallModel([watchRec(A), seeFor("a_t12.jpg")], opts()).tiles[0];
  assert.equal(exact.coverage.see, true);
  // and only the real .jpg frame shape counts
  const noise = buildWallModel([watchRec(A), seeFor("a_t12_extra.png")], opts()).tiles[0];
  assert.equal(noise.coverage.see, false);
});

test("intel card command reopens verbatim spans (--at 4-9), points stay points", () => {
  const spanHtml = renderWallHtml(buildWallModel([watchRec(A), findingRec(A, [4, 9])], opts()), "csi");
  assert.match(spanHtml, /--at 4-9</);
  const pointHtml = renderWallHtml(buildWallModel([watchRec(A), findingRec(A, 44)], opts()), "csi");
  assert.match(pointHtml, /--at 44</);
});

test("wall records are operational — excluded from case memory and briefs", () => {
  const wall = makeRecord({ verb: "wall", payload: { mode: "wall", viewer: "/x/wall.html", tiles: 3 } });
  const watch = watchRec(A);
  const kept = memoryRecords([watch, wall]);
  assert.deepEqual(kept.map((r) => r.verb), ["watch"]);
});

test("invalid flags are user errors, not silent defaults", async () => {
  for (const bad of [{ theme: "neon" }, { limit: -1 }, { since: "yesterdayish" }, { refresh: 0 }, { source: "  " }] as const) {
    const [rec] = await wallVerb.run(ctx(dir, bad as VerbContext["opts"]));
    assert.equal(rec.state, "error", `expected error for ${JSON.stringify(bad)}`);
  }
});
