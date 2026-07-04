// enhance split ops (separate / segment): the multi-output fan-out contract.
// Covers the pure fanOutEnhance mapping AND the enhance verb end-to-end against
// offline fixture providers (no pyannote / SAM / fal / STT).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { hasFanOut, fanOutEnhance } from "../../src/verbs/enhance-fanout.ts";
import { renderEnhanceGallery } from "../../src/report/html.ts";
import { enhanceVerb, viewVerb } from "../../src/verbs/senses.ts";
import { FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import { makeRecord } from "../../src/record.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";
import type { Profile } from "../../src/profile.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-fanout-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(input: string, opts: VerbContext["opts"], enhanceRun: string, listenRun?: string): VerbContext {
  const c = openCase(dir);
  c.ensure();
  const p: Profile = defaultProfile();
  p.providers = { ...p.providers, enhance: { type: "exec", run: enhanceRun } };
  if (listenRun) p.providers.listen = { type: "exec", run: listenRun };
  return { input, rest: [], opts, case: c, profile: p };
}

// ---- pure fanOutEnhance -----------------------------------------------------

test("hasFanOut only matches a ready record with a well-formed outputs[] array", () => {
  const good = makeRecord({ verb: "enhance", format: "json", payload: { op: "separate", outputs: [{ kind: "track", ref: "/a.wav" }] }, state: "ready" });
  assert.equal(hasFanOut(good), true);
  // single-output (no outputs[]) — the legacy shape
  assert.equal(hasFanOut(makeRecord({ verb: "enhance", format: "json", payload: { output: "/x.png" }, state: "ready" })), false);
  // error state is never fanned out
  assert.equal(hasFanOut(makeRecord({ verb: "enhance", format: "json", payload: { outputs: [{ kind: "track", ref: "/a.wav" }] }, state: "error" })), false);
  // malformed items (missing ref / non-array) don't match
  assert.equal(hasFanOut(makeRecord({ verb: "enhance", format: "json", payload: { outputs: [{ kind: "track" }] }, state: "ready" })), false);
  assert.equal(hasFanOut(makeRecord({ verb: "enhance", format: "json", payload: { outputs: "nope" }, state: "ready" })), false);
});

test("fanOutEnhance yields [parent, ...children] with provenance + inherited meta", () => {
  const parent = makeRecord({
    verb: "enhance", format: "json",
    payload: { op: "separate", outputs: [
      { kind: "track", ref: "/m/a_S0.wav", speaker: "S0", speech_seconds: 3.2, segments: [{ at: [0, 3.2] }] },
      { kind: "track", ref: "/m/a_S1.wav", speaker: "S1", speech_seconds: 1.1, segments: [{ at: [3.2, 4.3] }] },
    ] },
    media: { ref: "/m/interview.mp4" }, meta: { provider: "local:pyannote" }, state: "ready",
  });
  const recs = fanOutEnhance(parent, { caseDir: "/case" });
  assert.equal(recs.length, 3);
  assert.equal(recs[0], parent);
  const [, c0, c1] = recs;
  assert.equal(c0.verb, "enhance");
  assert.equal(c0.media?.ref, "/m/a_S0.wav");
  const p0 = c0.payload as Record<string, unknown>;
  assert.equal(p0.kind, "track");
  assert.equal(p0.speaker, "S0");
  assert.equal(p0.source_record, parent.id);
  assert.equal(p0.source_media, "/m/interview.mp4");
  assert.equal(c0.meta?.provider, "local:pyannote");
  assert.equal(c0.meta?.case, "/case");
  assert.ok(typeof p0.summary === "string" && (p0.summary as string).includes("S0"));
  assert.equal((c1.payload as Record<string, unknown>).speaker, "S1");
});

test("fanOutEnhance passes a single-output record straight through", () => {
  const single = makeRecord({ verb: "enhance", format: "json", payload: { output: "/x.png", ops: ["fal"] }, media: { ref: "/x.png" }, state: "ready" });
  const recs = fanOutEnhance(single);
  assert.equal(recs.length, 1);
  assert.equal(recs[0], single);
});

test("fanOutEnhance keeps box + box_normalized on segment children (crop interop)", () => {
  const parent = makeRecord({
    verb: "enhance", format: "json",
    payload: { op: "segment", outputs: [
      { kind: "cutout", ref: "/m/x_1.png", mask: "/m/x_1_mask.png", label: "car", score: 0.9, box: { xmin: 0.1, ymin: 0.2, xmax: 0.5, ymax: 0.6 }, box_normalized: true, instance: 1 },
    ] },
    media: { ref: "/m/photo.jpg" }, meta: { provider: "fal:sam-3" }, state: "ready",
  });
  const [, child] = fanOutEnhance(parent);
  const p = child.payload as Record<string, unknown>;
  assert.equal(p.box_normalized, true);
  assert.deepEqual(p.box, { xmin: 0.1, ymin: 0.2, xmax: 0.5, ymax: 0.6 });
  assert.equal(p.mask, "/m/x_1_mask.png");
  assert.equal(child.media?.ref, "/m/x_1.png");
});

// ---- enhance verb end-to-end (fixture providers) ----------------------------

test("enhance --ops separate fans out one record per track", async () => {
  const clip = join(dir, "clip.mp4");
  writeFileSync(clip, "x");
  const recs = await enhanceVerb.run(ctx(clip, { ops: "separate" }, `bash ${join(FIX, "fake-enhance-separate.sh")} --input {{input}}`));
  assert.equal(recs.length, 3, "parent + 2 track children");
  const tracks = recs.slice(1);
  assert.ok(tracks.every((r) => (r.payload as Record<string, unknown>).kind === "track"));
  assert.ok(tracks.every((r) => r.meta?.case === dir));
  assert.ok(tracks.every((r) => existsSync(r.media!.ref)), "track media files were written");
});

test("enhance --ops separate --summarize folds transcript onto each track", async () => {
  const clip = join(dir, "clip2.mp4");
  writeFileSync(clip, "x");
  const recs = await enhanceVerb.run(ctx(
    clip, { ops: "separate", summarize: true },
    `bash ${join(FIX, "fake-enhance-separate.sh")} --input {{input}}`,
    `bash ${join(FIX, "fake-listen-summary.sh")} --input {{input}}`,
  ));
  const tracks = recs.slice(1);
  for (const t of tracks) {
    const p = t.payload as Record<string, unknown>;
    assert.equal(p.transcript, "hello from the fixture");
    assert.ok(typeof p.summary === "string" && (p.summary as string).includes("a short greeting"));
    assert.equal(p.listen_provider, "fake:listen");
  }
});

test("enhance --ops segment fans out cutouts and keeps crop-compatible boxes", async () => {
  const img = join(dir, "photo.jpg");
  writeFileSync(img, "x");
  const recs = await enhanceVerb.run(ctx(img, { ops: "segment", prompt: "the red car" }, `bash ${join(FIX, "fake-enhance-segment.sh")} --input {{input}}`));
  assert.equal(recs.length, 2);
  const parent = recs[0].payload as Record<string, unknown>;
  assert.ok(Array.isArray(parent.detections), "parent mirrors detections for crop");
  const child = recs[1].payload as Record<string, unknown>;
  assert.equal(child.kind, "cutout");
  assert.equal(child.box_normalized, true);
  assert.equal(child.label, "the red car");
});

test("enhance single-output provider still returns exactly one record", async () => {
  const img = join(dir, "blurry.jpg");
  writeFileSync(img, "x");
  const recs = await enhanceVerb.run(ctx(img, {}, `bash ${join(FIX, "fake-enhance-single.sh")} --input {{input}}`));
  assert.equal(recs.length, 1);
  assert.equal((recs[0].payload as Record<string, unknown>).model, "fake");
});

test("renderEnhanceGallery (separate) emits audio players, overlaps, and transcripts", () => {
  const html = renderEnhanceGallery({
    op: "separate", title: "enhance separate", model: "pyannote/x",
    overlaps: [{ at: [11.4, 12.9], speakers: ["SPEAKER_00", "SPEAKER_01"] }],
    items: [
      { kind: "track", ref: "/nope/a.wav", label: "SPEAKER_00", speechSeconds: 35.2, segments: 5, transcript: "hello world" },
      { kind: "track", ref: "/nope/b.wav", label: "SPEAKER_01", speechSeconds: 3.8, segments: 3 },
    ],
  });
  assert.match(html, /SPEAKER_00/);
  assert.match(html, /Cross-talk/);
  assert.match(html, /11\.4–12\.9s/);
  assert.match(html, /hello world/);
  // a missing track file degrades to a note, never a broken player
  assert.match(html, /track file missing/);
  assert.doesNotMatch(html, /<script/i); // no injected script
});

test("view on a separate PARENT record renders a gallery of its tracks", async () => {
  const c = openCase(dir);
  c.ensure();
  const clip = join(dir, "gallery.mp4");
  writeFileSync(clip, "x");
  const p: Profile = defaultProfile();
  p.providers = { ...p.providers, enhance: { type: "exec", run: `bash ${join(FIX, "fake-enhance-separate.sh")} --input {{input}}` } };
  const recs = await enhanceVerb.run({ input: clip, rest: [], opts: { ops: "separate" }, case: c, profile: p });
  for (const r of recs) c.writeRecord(r);
  const parentId = recs[0].id;
  const [view] = await viewVerb.run({ input: parentId, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal(view.verb, "view");
  assert.equal((view.payload as Record<string, unknown>).mode, "separation");
  assert.equal((view.payload as Record<string, unknown>).items, 2);
  const gallery = readFileSync(view.media!.ref, "utf8");
  assert.match(gallery, /<audio/); // per-speaker track players
  assert.match(gallery, /<video/); // the ORIGINAL is a .mp4 → a video element, not audio
  assert.match(gallery, /SPEAKER_00/);
});

test("separation gallery uses <audio> for the original when the source is not a video", () => {
  const existing = join(FIX, "fake-enhance-separate.sh"); // a real file, non-video ext
  const html = renderEnhanceGallery({
    op: "separate", title: "t", sourceRef: existing,
    items: [{ kind: "track", ref: existing, label: "S0" }],
  });
  // non-video source → the original card must be an <audio>, never <video>
  assert.match(html, /ORIGINAL[\s\S]*?<audio/);
  assert.doesNotMatch(html, /<video/);
});

test("view on a segment PARENT record renders a cutout gallery (no audio)", async () => {
  const c = openCase(dir);
  c.ensure();
  const img = join(dir, "gallery.jpg");
  writeFileSync(img, "x");
  const p: Profile = defaultProfile();
  p.providers = { ...p.providers, enhance: { type: "exec", run: `bash ${join(FIX, "fake-enhance-segment.sh")} --input {{input}}` } };
  const recs = await enhanceVerb.run({ input: img, rest: [], opts: { ops: "segment", prompt: "car" }, case: c, profile: p });
  for (const r of recs) c.writeRecord(r);
  const [view] = await viewVerb.run({ input: recs[0].id, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal((view.payload as Record<string, unknown>).mode, "segmentation");
  const gallery = readFileSync(view.media!.ref, "utf8");
  assert.doesNotMatch(gallery, /<audio/);
  assert.match(gallery, /INSTANCES/);
});

test("enhance --ops separate WITHOUT a bound provider errors helpfully", async () => {
  const clip = join(dir, "clip3.mp4");
  writeFileSync(clip, "x");
  const c = openCase(dir);
  c.ensure();
  // default profile: no custom enhance binding → ffmpeg path → gate rejects.
  const recs = await enhanceVerb.run({ input: clip, rest: [], opts: { ops: "separate" }, case: c, profile: defaultProfile() });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].state, "error");
  assert.match(String(recs[0].error), /bound enhance provider/);
});

test("a split op combined with another op is rejected (no silent drop)", async () => {
  const clip = join(dir, "clip4.mp4");
  writeFileSync(clip, "x");
  // two split ops
  let recs = await enhanceVerb.run(ctx(clip, { ops: "segment,separate" }, `bash ${join(FIX, "fake-enhance-separate.sh")} --input {{input}}`));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].state, "error");
  assert.match(String(recs[0].error), /only --ops value/);
  // split op mixed with an ffmpeg op
  recs = await enhanceVerb.run(ctx(clip, { ops: "separate,denoise" }, `bash ${join(FIX, "fake-enhance-separate.sh")} --input {{input}}`));
  assert.equal(recs[0].state, "error");
  assert.match(String(recs[0].error), /only --ops value/);
});

test("a split op against a single-output provider fails loudly (not a silent no-op)", async () => {
  const clip = join(dir, "clip5.mp4");
  writeFileSync(clip, "x");
  // fake-enhance-single ignores --ops and returns one enhanced file (no payload.op)
  const recs = await enhanceVerb.run(ctx(clip, { ops: "separate" }, `bash ${join(FIX, "fake-enhance-single.sh")} --input {{input}}`));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].state, "error");
  assert.match(String(recs[0].error), /did not perform '--ops separate'/);
});

test("a split op with malformed outputs[] errors instead of silently dropping artifacts", async () => {
  const img = join(dir, "photo2.jpg");
  writeFileSync(img, "x");
  // provider echoes op:segment but its output item is missing `ref` → hasFanOut
  // fails; without the guard the artifacts would vanish and only a parent return.
  const recs = await enhanceVerb.run(ctx(img, { ops: "segment", prompt: "x" }, `bash ${join(FIX, "fake-enhance-malformed.sh")} --input {{input}}`));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].state, "error");
  assert.match(String(recs[0].error), /malformed outputs/);
});

test("frame:// enhance inherits capture provenance from the ORIGINAL clip, not the still", async () => {
  const c = openCase(dir);
  c.ensure();
  // a real clip that a `capture` record points at (carrying source provenance)
  const clip = join(dir, "captured.mp4");
  execFileSync(FFMPEG_PATH, ["-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-pix_fmt", "yuv420p", clip], { stdio: "ignore" });
  const cap = makeRecord({
    verb: "capture", format: "json",
    payload: { path: clip, source_url: "https://x.com/p/1", source_author: "@src", capture_id: "cap1" },
    media: { ref: clip }, state: "ready",
  });
  c.writeRecord(cap);
  const p: Profile = defaultProfile();
  p.providers = { ...p.providers, enhance: { type: "exec", run: `bash ${join(FIX, "fake-enhance-segment.sh")} --input {{input}}` } };
  const recs = await enhanceVerb.run({ input: `frame://${cap.id}@0`, rest: [], opts: { ops: "segment", prompt: "x" }, case: c, profile: p });
  const child = recs[1].payload as Record<string, unknown>;
  assert.equal(child.source_url, "https://x.com/p/1", "provenance came from the source clip's capture record");
  assert.equal(child.source_author, "@src");
  // the internal ffmpeg path (no bound provider) inherits it too — same input,
  // same provenance regardless of which op path handles it.
  const [ff] = await enhanceVerb.run({ input: `frame://${cap.id}@0`, rest: [], opts: { ops: "grayscale" }, case: c, profile: defaultProfile() });
  assert.equal(ff.meta?.provider, "ffmpeg");
  assert.equal((ff.payload as Record<string, unknown>).source_url, "https://x.com/p/1");
});

test("a split op that matched nothing (op set, empty outputs) is a ready parent, not an error", async () => {
  const img = join(dir, "photo3.jpg");
  writeFileSync(img, "x");
  const recs = await enhanceVerb.run(ctx(img, { ops: "segment", prompt: "nothing" }, `bash ${join(FIX, "fake-enhance-empty.sh")} --input {{input}}`));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].state, "ready");
  assert.equal((recs[0].payload as Record<string, unknown>).count, 0);
});

test("split ops are recognized case-insensitively (Segment fans out; Separate hits the guard)", async () => {
  const img = join(dir, "photo6.jpg");
  writeFileSync(img, "x");
  // `Segment` normalizes → fixture matches → fans out
  let recs = await enhanceVerb.run(ctx(img, { ops: "Segment", prompt: "x" }, `bash ${join(FIX, "fake-enhance-segment.sh")} --input {{input}}`));
  assert.equal(recs.length, 2);
  assert.equal((recs[1].payload as Record<string, unknown>).kind, "cutout");
  // `SEPARATE` against a single-output provider still triggers the no-op guard
  recs = await enhanceVerb.run(ctx(img, { ops: "SEPARATE" }, `bash ${join(FIX, "fake-enhance-single.sh")} --input {{input}}`));
  assert.equal(recs[0].state, "error");
  assert.match(String(recs[0].error), /did not perform '--ops separate'/);
});
