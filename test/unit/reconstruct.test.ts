// reconstruct (speculative camera reposition / novel-view synthesis): the
// multi-output fan-out contract, the non-negotiable caveat stamping, the
// evidence quarantine, and the verb + viewer paths end-to-end against the
// offline fixture provider (no fal).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasReconstructFanOut, fanOutReconstruct, RECONSTRUCT_CAVEAT } from "../../src/verbs/reconstruct-fanout.ts";
import { reconstructVerb } from "../../src/verbs/reconstruct.ts";
import { viewVerb } from "../../src/verbs/senses.ts";
import { renderReconstructGallery } from "../../src/report/html.ts";
import { buildOrbitViewerHtml, buildParallaxViewerHtml } from "../../src/report/reconstruct-viewers.ts";
import { FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import { makeRecord, isMemoryRecord, OPERATIONAL_VERBS } from "../../src/record.ts";
import { findVerb } from "../../src/registry/verbs.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile, type Profile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const FAKE = `bash ${join(FIX, "fake-reconstruct.sh")} --input {{input}}`;
let dir: string;
let img: string; // a REAL png so the sweep sheet/turntable ffmpeg passes run

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-reconstruct-"));
  img = join(dir, "scene.png");
  execFileSync(FFMPEG_PATH, ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x48", "-frames:v", "1", img], { stdio: "ignore" });
});
after(() => rmSync(dir, { recursive: true, force: true }));

function ctx(input: string, opts: VerbContext["opts"], run?: string): VerbContext {
  const c = openCase(dir);
  c.ensure();
  const p: Profile = defaultProfile();
  if (run) p.providers = { ...p.providers, reconstruct: { type: "exec", run } };
  return { input, rest: [], opts, case: c, profile: p };
}

// ---- registry + evidence posture ---------------------------------------------

test("reconstruct is registered with the camera flags and quarantined from evidence", () => {
  const v = findVerb("reconstruct");
  assert.ok(v, "verb registered");
  const flags = new Set(v!.flags.map((f) => f.name));
  for (const f of ["rotate", "elevate", "zoom", "ops", "count", "at", "seed", "view"]) {
    assert.ok(flags.has(f), `flag --${f} declared`);
  }
  assert.equal(v!.group, "sense");
  // the deliberate exception: a sense verb whose records are synthesized pixels
  // must never feed ask/brief evidence or findings triggers.
  assert.ok(OPERATIONAL_VERBS.has("reconstruct"), "reconstruct is quarantined");
  const rec = makeRecord({ verb: "reconstruct", format: "json", payload: { op: "view", caveat: RECONSTRUCT_CAVEAT }, state: "ready" });
  assert.equal(isMemoryRecord(rec), false, "ready reconstruct records are NOT memory/evidence");
});

// ---- pure fan-out --------------------------------------------------------------

test("hasReconstructFanOut only matches a ready record with well-formed outputs[]", () => {
  const good = makeRecord({ verb: "reconstruct", format: "json", payload: { op: "view", outputs: [{ kind: "view", ref: "/a.png" }] }, state: "ready" });
  assert.equal(hasReconstructFanOut(good), true);
  assert.equal(hasReconstructFanOut(makeRecord({ verb: "reconstruct", format: "json", payload: { output: "/x.png" }, state: "ready" })), false);
  assert.equal(hasReconstructFanOut(makeRecord({ verb: "reconstruct", format: "json", payload: { outputs: [{ kind: "view", ref: "/a.png" }] }, state: "error" })), false);
  assert.equal(hasReconstructFanOut(makeRecord({ verb: "reconstruct", format: "json", payload: { outputs: [{ kind: "view" }] }, state: "ready" })), false);
});

test("fanOutReconstruct stamps the caveat on parent AND children even when the provider omits it", () => {
  const parent = makeRecord({
    verb: "reconstruct", format: "json",
    payload: { op: "sweep", outputs: [
      { kind: "view", ref: "/m/a_az0.png", azimuth: 0 },
      { kind: "view", ref: "/m/a_az180.png", azimuth: 180, elevate: 30 },
      { kind: "mesh", ref: "/m/a_mesh.glb", format: "glb" },
    ] },
    media: { ref: "/m/scene.png" }, meta: { provider: "fal:qwen" }, state: "ready",
  });
  const recs = fanOutReconstruct(parent, { caseDir: "/case" });
  assert.equal(recs.length, 4);
  assert.equal((recs[0].payload as Record<string, unknown>).caveat, RECONSTRUCT_CAVEAT, "parent caveat injected");
  const [, v0, v1, mesh] = recs;
  for (const r of [v0, v1, mesh]) {
    const p = r.payload as Record<string, unknown>;
    assert.equal(r.verb, "reconstruct");
    assert.equal(p.caveat, RECONSTRUCT_CAVEAT, "child caveat injected");
    assert.equal(p.source_record, parent.id);
    assert.equal(p.source_media, "/m/scene.png");
    assert.equal(r.meta?.provider, "fal:qwen");
    assert.equal(r.meta?.case, "/case");
  }
  assert.match((v1.payload as Record<string, unknown>).summary as string, /az 180°/);
  assert.match((v1.payload as Record<string, unknown>).summary as string, /not evidence/);
  assert.match((mesh.payload as Record<string, unknown>).summary as string, /3D reconstruction \(glb\)/);
});

// ---- verb gating ----------------------------------------------------------------

test("reconstruct without a bound provider errors with bind guidance", async () => {
  const recs = await reconstructVerb.run(ctx(img, { rotate: 45 }));
  assert.equal(recs[0].state, "error");
  assert.match(recs[0].error ?? "", /provider setup apply --verb reconstruct --choice fal/);
});

test("reconstruct without a camera move or op errors with usage guidance", async () => {
  const recs = await reconstructVerb.run(ctx(img, {}, FAKE));
  assert.equal(recs[0].state, "error");
  assert.match(recs[0].error ?? "", /--rotate <deg>/);
});

test("reconstruct on a video without --at errors (frame must be pinned)", async () => {
  const clip = join(dir, "clip.mp4");
  writeFileSync(clip, "x"); // junk: probe fails → extension fallback → video
  const recs = await reconstructVerb.run(ctx(clip, { rotate: 45 }, FAKE));
  assert.equal(recs[0].state, "error");
  assert.match(recs[0].error ?? "", /--at/);
});

test("reconstruct rejects out-of-range camera values before calling the provider", async () => {
  const badElevate = await reconstructVerb.run(ctx(img, { rotate: 10, elevate: 120 }, FAKE));
  assert.match(badElevate[0].error ?? "", /--elevate 120 out of range/);
  const badZoom = await reconstructVerb.run(ctx(img, { zoom: 42 }, FAKE));
  assert.match(badZoom[0].error ?? "", /--zoom 42 out of range/);
  const badCount = await reconstructVerb.run(ctx(img, { ops: "sweep", count: 99 }, FAKE));
  assert.match(badCount[0].error ?? "", /--count 99 out of range/);
});

// ---- verb end-to-end (fixture provider) ----------------------------------------

test("reconstruct --rotate fans out a synthesized view with the caveat stamped", async () => {
  const recs = await reconstructVerb.run(ctx(img, { rotate: 45 }, FAKE));
  assert.equal(recs.length, 2, "parent + 1 view child");
  const [parent, child] = recs;
  assert.equal(parent.state ?? "ready", "ready");
  const pp = parent.payload as Record<string, unknown>;
  const cp = child.payload as Record<string, unknown>;
  assert.equal(pp.op, "view");
  assert.equal(pp.caveat, RECONSTRUCT_CAVEAT, "fixture omits caveat; verb must stamp it");
  assert.equal(cp.kind, "view");
  assert.equal(cp.azimuth, 45);
  assert.equal(cp.caveat, RECONSTRUCT_CAVEAT);
  assert.ok(existsSync(child.media!.ref), "synthesized view written");
  assert.equal(child.meta?.case, dir);
});

test("reconstruct --ops sweep assembles a contact sheet + turntable as children", async () => {
  const recs = await reconstructVerb.run(ctx(img, { ops: "sweep", count: 3 }, FAKE));
  const kinds = recs.slice(1).map((r) => (r.payload as Record<string, unknown>).kind);
  assert.deepEqual(kinds.filter((k) => k === "view").length, 3, "3 synthesized stops");
  assert.ok(kinds.includes("sheet"), "contact sheet child");
  assert.ok(kinds.includes("turntable"), "turntable child");
  const pp = recs[0].payload as Record<string, unknown>;
  assert.ok(typeof pp.sheet === "string" && existsSync(pp.sheet as string), "sheet on disk");
  assert.ok(typeof pp.turntable === "string" && existsSync(pp.turntable as string), "turntable on disk");
  // parent count must include the appended sheet+turntable, matching outputs[]
  // and the fan-out child count (3 views + sheet + turntable = 5).
  assert.equal(pp.count, (pp.outputs as unknown[]).length, "count tracks outputs[] after assembly");
  assert.equal(pp.count, recs.length - 1, "count matches the fanned-out children");
  assert.equal(pp.count, 5);
  for (const r of recs.slice(1)) {
    assert.equal((r.payload as Record<string, unknown>).caveat, RECONSTRUCT_CAVEAT);
    assert.equal((r.payload as Record<string, unknown>).source_record, recs[0].id);
  }
});

test("reconstruct rejects a fan-out whose op doesn't match the request (mis-bound provider)", async () => {
  const WRONG = `bash ${join(FIX, "fake-reconstruct-wrongop.sh")} --input {{input}}`;
  const recs = await reconstructVerb.run(ctx(img, { rotate: 45 }, WRONG)); // requests op "view"
  assert.equal(recs.length, 1, "no fan-out on a rejected mismatch");
  assert.equal(recs[0].state, "error");
  assert.match(recs[0].error ?? "", /did not perform '--ops view'/);
  assert.match(recs[0].error ?? "", /op="depth"/);
});

test("reconstruct rejects a ready result with no artifacts (failed provider, not an empty success)", async () => {
  const EMPTY = `bash ${join(FIX, "fake-reconstruct-empty.sh")} --input {{input}}`;
  const recs = await reconstructVerb.run(ctx(img, { rotate: 45 }, EMPTY));
  assert.equal(recs.length, 1, "no parent-only 'success' record");
  assert.equal(recs[0].state, "error");
  assert.match(recs[0].error ?? "", /empty outputs\[\]/);
  assert.match(recs[0].error ?? "", /provider failure/);
});

test("reconstruct extracts the --at frame from a real video before synthesis", async () => {
  const clip = join(dir, "real.mp4");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5:duration=2", "-pix_fmt", "yuv420p", clip],
    { stdio: "ignore" },
  );
  const recs = await reconstructVerb.run(ctx(clip, { rotate: 90, at: "1" }, FAKE));
  assert.equal(recs.length, 2);
  assert.match(recs[0].media?.ref ?? "", /\.jpg$/, "provider received the extracted frame");
});

// ---- viewers --------------------------------------------------------------------

test("view on a sweep PARENT renders the speculative gallery (caveat banner, no script)", async () => {
  const c = openCase(dir);
  c.ensure();
  const recs = await reconstructVerb.run(ctx(img, { ops: "sweep", count: 2 }, FAKE));
  for (const r of recs) c.writeRecord(r);
  const [view] = await viewVerb.run({ input: recs[0].id, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal(view.verb, "view");
  assert.equal((view.payload as Record<string, unknown>).mode, "reconstruction");
  const html = readFileSync(view.media!.ref, "utf8");
  assert.match(html, /SYNTHESIZED/);
  assert.match(html, /NOT photographic evidence/);
  assert.doesNotMatch(html, /<script/i, "the gallery stays scriptless (csi shell CSP)");
});

test("view on a model PARENT opens the embedded 3D orbit viewer", async () => {
  const c = openCase(dir);
  c.ensure();
  const recs = await reconstructVerb.run(ctx(img, { ops: "model" }, FAKE));
  for (const r of recs) c.writeRecord(r);
  const [view] = await viewVerb.run({ input: recs[0].id, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal((view.payload as Record<string, unknown>).mode, "orbit");
  const html = readFileSync(view.media!.ref, "utf8");
  assert.match(html, /GLB_B64/, "mesh embedded");
  assert.match(html, /NOT photographic evidence/);
});

test("view on a depth PARENT opens the parallax viewer with both images inlined", async () => {
  const c = openCase(dir);
  c.ensure();
  const recs = await reconstructVerb.run(ctx(img, { ops: "depth" }, FAKE));
  for (const r of recs) c.writeRecord(r);
  const [view] = await viewVerb.run({ input: recs[0].id, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal((view.payload as Record<string, unknown>).mode, "parallax");
  const html = readFileSync(view.media!.ref, "utf8");
  assert.match(html, /COLOR_URI/);
  assert.match(html, /DEPTH_URI/);
});

test("view on a mesh CHILD record opens the orbit viewer directly", async () => {
  const c = openCase(dir);
  c.ensure();
  const recs = await reconstructVerb.run(ctx(img, { ops: "model" }, FAKE));
  for (const r of recs) c.writeRecord(r);
  const meshChild = recs.find((r) => (r.payload as Record<string, unknown>).kind === "mesh")!;
  const [view] = await viewVerb.run({ input: meshChild.id, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal((view.payload as Record<string, unknown>).mode, "orbit");
});

test("view on a synthesized view/sheet/turntable CHILD wraps it in the caveat banner (never a bare OS-open)", async () => {
  const c = openCase(dir);
  c.ensure();
  const recs = await reconstructVerb.run(ctx(img, { ops: "sweep", count: 3 }, FAKE));
  for (const r of recs) c.writeRecord(r);
  const byKind = (k: string) => recs.find((r) => (r.payload as Record<string, unknown>).kind === k)!;
  // a synthesized still view child
  const [vv] = await viewVerb.run({ input: byKind("view").id, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal((vv.payload as Record<string, unknown>).mode, "still", "view child → bannered still viewer, not OS-open");
  const vhtml = readFileSync(vv.media!.ref, "utf8");
  assert.match(vhtml, /class="banner"/);
  assert.match(vhtml, /not photographic evidence/i);
  // the sweep turntable child → a bannered video viewer
  const [tv] = await viewVerb.run({ input: byKind("turntable").id, rest: [], opts: { "no-open": true }, case: c, profile: defaultProfile() });
  assert.equal((tv.payload as Record<string, unknown>).mode, "clip");
  assert.match(readFileSync(tv.media!.ref, "utf8"), /<video/);
});

test("sweep sheet + turntable are scoped to the producing record id (re-runs don't clobber)", async () => {
  const c = openCase(dir);
  c.ensure();
  const a = await reconstructVerb.run(ctx(img, { ops: "sweep", count: 3 }, FAKE));
  const b = await reconstructVerb.run(ctx(img, { ops: "sweep", count: 3 }, FAKE));
  const artifactRef = (recs: typeof a, kind: string) =>
    recs.find((r) => (r.payload as Record<string, unknown>).kind === kind)?.media?.ref;
  // distinct parent ids → distinct sheet/turntable paths, so B never overwrites A
  assert.notEqual(a[0].id, b[0].id);
  assert.notEqual(artifactRef(a, "sheet"), artifactRef(b, "sheet"));
  assert.notEqual(artifactRef(a, "turntable"), artifactRef(b, "turntable"));
  assert.ok(artifactRef(a, "sheet")!.includes(a[0].id), "sheet path carries the record id");
  assert.ok(existsSync(artifactRef(a, "turntable")!) && existsSync(artifactRef(b, "turntable")!), "both runs' turntables survive");
});

test("renderReconstructGallery degrades honestly (empty stops, missing files)", () => {
  const html = renderReconstructGallery({
    op: "view", title: "reconstruct view", caveat: RECONSTRUCT_CAVEAT,
    views: [{ ref: "/nope/az45.png", rotate: 45 }],
  });
  assert.match(html, /image missing/);
  const empty = renderReconstructGallery({ op: "sweep", title: "t", caveat: RECONSTRUCT_CAVEAT, views: [] });
  assert.match(empty, /No synthesized views/);
});

test("orbit viewer degrades to an explicit message when the mesh is missing", () => {
  const html = buildOrbitViewerHtml("/nope/mesh.glb", { title: "t", caveat: RECONSTRUCT_CAVEAT });
  assert.match(html, /mesh file missing/);
});

test("parallax viewer returns undefined when an image can't be inlined", () => {
  assert.equal(buildParallaxViewerHtml("/nope/a.png", "/nope/b.png", { title: "t", caveat: RECONSTRUCT_CAVEAT }), undefined);
});
