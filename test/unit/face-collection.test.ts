// Face + collection coverage. The external tinycloud process is faked
// (test/fixtures/fake-tinycloud.sh) so the REAL envelope→record mapping +
// verb/op-resolution code runs offline. Uses plain dummy files (no ffmpeg).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import type { VerbContext } from "../../src/registry/types.ts";

import {
  mapTinycloudState,
  tinycloudError,
  envelopeData,
  tinycloudBase,
  tinycloudBaseFromRun,
  TINYCLOUD_TIMEOUT_MS,
} from "../../src/providers/tinycloud/envelope.ts";
import { runFace, faceArgv } from "../../src/providers/tinycloud/face.ts";
import {
  normalizeCollectionType,
  addCollection,
  listCollections,
  findCollection,
  resolveCollectionRef,
  removeCollection,
  addMember,
  removeMember,
  collectionsByType,
} from "../../src/state/collection.ts";
import { faceVerb } from "../../src/verbs/face.ts";
import { collectionVerb } from "../../src/verbs/collection.ts";
import { askVerb, briefVerb } from "../../src/verbs/read.ts";
import { doctorVerb } from "../../src/verbs/setup.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import { pageCommand } from "../../src/render.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "..", "fixtures", "fake-tinycloud.sh");
const BASE = `bash ${FAKE}`;

let dir: string;
let clip: string;
let face: string;
let savedTcCmd: string | undefined;

before(() => {
  chmodSync(FAKE, 0o755);
  dir = mkdtempSync(join(tmpdir(), "oc-face-"));
  // dummy files — the fake tinycloud ignores their content; we just need the
  // verb's existence check to pass without depending on ffmpeg.
  clip = join(dir, "clip.mp4");
  face = join(dir, "suspect.jpg");
  writeFileSync(clip, "x");
  writeFileSync(face, "x");
  // route every default-path tinycloud invocation (the verbs don't pass an
  // explicit base) at the fake binary for the whole suite.
  savedTcCmd = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = BASE;
});
after(() => {
  if (savedTcCmd === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
  else process.env.OVERCAST_TINYCLOUD_CMD = savedTcCmd;
  rmSync(dir, { recursive: true, force: true });
});

function ctx(input: string | undefined, opts: VerbContext["opts"] = {}, rest: string[] = []): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: defaultProfile() };
}

// ---- envelope helper -------------------------------------------------------

test("mapTinycloudState: status wins, else exit code (2/13 = cred, 3 = pending)", () => {
  assert.equal(mapTinycloudState({ status: "ready" }, {}, 0), "ready");
  assert.equal(mapTinycloudState({ status: "completed" }, {}, 0), "ready");
  assert.equal(mapTinycloudState({ status: "pending" }, {}, 0), "pending");
  assert.equal(mapTinycloudState({ status: "needs_upload" }, {}, 3), "pending");
  assert.equal(mapTinycloudState({ status: "needs_credentials" }, {}, 2), "needs_credentials");
  assert.equal(mapTinycloudState({ status: "error" }, {}, 1), "error");
  // nested under data, and exit-code fallbacks when no explicit status
  assert.equal(mapTinycloudState({}, { status: "pending" }, 0), "pending");
  assert.equal(mapTinycloudState({}, {}, 0), "ready");
  assert.equal(mapTinycloudState({}, {}, 2), "needs_credentials");
  assert.equal(mapTinycloudState({}, {}, 13), "needs_credentials");
  assert.equal(mapTinycloudState({}, {}, 1), "error");
});

test("tinycloudError extracts a message from string or {code,message}; envelopeData unwraps data", () => {
  assert.equal(tinycloudError({ error: "boom" }, {}), "boom");
  assert.equal(tinycloudError({ error: { code: "x", message: "broke" } }, {}), "broke");
  assert.equal(tinycloudError({}, {}), undefined);
  assert.deepEqual(envelopeData({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(envelopeData({ a: 1 }), { a: 1 }); // bare-data tolerated
});

test("tinycloudBase honors OVERCAST_TINYCLOUD_CMD; defaults to tinycloud", () => {
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    delete process.env.OVERCAST_TINYCLOUD_CMD; // the suite sets it globally
    assert.deepEqual(tinycloudBase(), ["tinycloud"]);
    assert.deepEqual(tinycloudBase("bash /x/tc.sh"), ["bash", "/x/tc.sh"]); // explicit wins
    process.env.OVERCAST_TINYCLOUD_CMD = "my-tc --flag";
    assert.deepEqual(tinycloudBase(), ["my-tc", "--flag"]);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
  }
});

// ---- face mapper (provider) ------------------------------------------------

test("runFace detect → face.analysis with normalized faces (at, box) + media.ref", async () => {
  const rec = await runFace({ op: "detect", source: "clip.mp4" }, { base: BASE });
  assert.equal(rec.verb, "face");
  assert.equal(rec.state, "ready");
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.op, "detect");
  const faces = p.faces as Array<Record<string, unknown>>;
  assert.equal(faces.length, 2);
  assert.equal(faces[0].at, 1.5); // timestamp → at
  assert.ok(faces[0].box); // bounding_box → box
  assert.equal(p.count, 2);
  assert.equal(rec.media?.ref, "clip.mp4");
  assert.equal(rec.media?.at, 1.5); // seek anchor = first face
  assert.ok((p.detailed as Record<string, unknown>).faces); // raw kept
});

test("runFace match → similarity-ranked matches; reference image recorded", async () => {
  const rec = await runFace({ op: "match", image: "suspect.jpg", source: "clip.mp4", maxFaces: 10 }, { base: BASE });
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.op, "match");
  assert.equal(p.reference, "suspect.jpg");
  const faces = p.faces as Array<Record<string, unknown>>;
  assert.equal(faces[0].similarity, 92.5); // tinycloud's 0–100 percent scale
  assert.equal(faces[0].thumbnail, "data:image/jpeg;base64,AAAA");
  assert.equal(rec.media?.ref, "clip.mp4");
});

test("runFace search → media.ref is the query image, no seek anchor; collection recorded", async () => {
  const rec = await runFace({ op: "search", image: "suspect.jpg", collections: ["col_x"] }, { base: BASE });
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.op, "search");
  assert.equal(p.collection, "col_x");
  const faces = p.faces as Array<Record<string, unknown>>;
  assert.equal(faces.length, 2);
  assert.equal(faces[0].file, "vid1.mp4");
  assert.equal(faces[0].similarity, 88); // score → similarity (0–100 scale)
  assert.equal(rec.media?.ref, "suspect.jpg");
  assert.equal(rec.media?.at, undefined); // search spans videos → no single anchor
});

test("runFace maps a cred gap (exit 2) to needs_credentials", async () => {
  const saved = process.env.OVERCAST_FAKE_TC_MODE;
  process.env.OVERCAST_FAKE_TC_MODE = "cred";
  try {
    const rec = await runFace({ op: "detect", source: "clip.mp4" }, { base: BASE });
    assert.equal(rec.state, "needs_credentials");
    assert.match(rec.error ?? "", /CLOUDGLUE_API_KEY/);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
    else process.env.OVERCAST_FAKE_TC_MODE = saved;
  }
});

// ---- face verb (op resolution) ---------------------------------------------

test("face verb: video only → detect; --match + video → match", async () => {
  const [det] = await faceVerb.run(ctx(clip));
  assert.equal((det.payload as Record<string, unknown>).op, "detect");

  const [m] = await faceVerb.run(ctx(clip, { match: face }));
  assert.equal((m.payload as Record<string, unknown>).op, "match");
});

test("face verb: --match + a single case face collection → search (no video)", async () => {
  const c = openCase(dir);
  c.ensure();
  addCollection(c, { id: "col_faceA", type: "face-analysis", name: "faces" });
  try {
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: face }, case: c, profile: defaultProfile() });
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.op, "search");
    assert.equal(p.collection, "col_faceA");
  } finally {
    removeCollection(c, "col_faceA");
  }
});

test("face verb: no video and no match → usage error", async () => {
  const [rec] = await faceVerb.run(ctx(undefined));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /face requires a video/);
});

// ---- collection state mirror -----------------------------------------------

test("normalizeCollectionType maps aliases; rejects unknown", () => {
  assert.equal(normalizeCollectionType("face"), "face-analysis");
  assert.equal(normalizeCollectionType("faces"), "face-analysis");
  assert.equal(normalizeCollectionType("media"), "media-descriptions");
  assert.equal(normalizeCollectionType("entities"), "entities");
  assert.equal(normalizeCollectionType("transcripts"), "rich-transcripts");
  assert.equal(normalizeCollectionType("nope"), undefined);
});

test("collection mirror: add/find/members/remove round-trip", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-colstate-")));
  c.ensure();
  addCollection(c, { id: "col_1", type: "media-descriptions", name: "calls" });
  addCollection(c, { id: "col_2", type: "face-analysis", name: "faces" });
  assert.equal(listCollections(c).length, 2);
  assert.equal(findCollection(c, "col_1")?.name, "calls");
  assert.equal(findCollection(c, "faces")?.id, "col_2"); // resolve by name
  assert.equal(collectionsByType(c, "face-analysis").length, 1);

  assert.equal(addMember(c, "col_1", { ref: "a.mp4" }), true);
  addMember(c, "col_1", { ref: "a.mp4" }); // dedupe by ref
  addMember(c, "col_1", { ref: "b.mp4" });
  assert.equal(findCollection(c, "col_1")?.members.length, 2);
  assert.equal(addMember(c, "missing", { ref: "x" }), false);
  assert.equal(removeMember(c, "col_1", "a.mp4"), true);
  assert.equal(findCollection(c, "col_1")?.members.length, 1);

  assert.equal(removeCollection(c, "col_1"), true);
  assert.equal(listCollections(c).length, 1);
});

// ---- collection verb (lifecycle via the fake tinycloud) --------------------

test("collection verb: create → add → list → show → delete, mirroring locally", async () => {
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = BASE;
  const cdir = mkdtempSync(join(tmpdir(), "oc-colverb-"));
  const video = join(cdir, "v.mp4");
  writeFileSync(video, "x");
  const mk = (input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext => {
    const c = openCase(cdir);
    c.ensure();
    return { input, rest, opts, case: c, profile: defaultProfile() };
  };
  try {
    const [created] = await collectionVerb.run(mk("create", ["calls"], { type: "media" }));
    assert.equal(created.state, "ready");
    assert.equal((created.payload as Record<string, unknown>).id, "col_fake123");
    assert.equal(listCollections(openCase(cdir)).length, 1);

    const [added] = await collectionVerb.run(mk("add", [video], { to: "col_fake123" }));
    assert.equal(added.state, "pending"); // async ingest
    assert.equal(findCollection(openCase(cdir), "col_fake123")?.members.length, 1);

    const [listed] = await collectionVerb.run(mk("list"));
    const lp = listed.payload as Record<string, unknown>;
    assert.equal((lp.collections as unknown[]).length, 1);

    const [shown] = await collectionVerb.run(mk("show", ["col_fake123"]));
    assert.equal((shown.payload as Record<string, unknown>).file_count, 2);

    const [deleted] = await collectionVerb.run(mk("delete", ["col_fake123"]));
    assert.equal(deleted.state, "ready");
    assert.equal(listCollections(openCase(cdir)).length, 0); // mirror pruned
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("collection verb: entities collection needs --prompt/--schema; bogus action errors", async () => {
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = BASE;
  try {
    const [needsPrompt] = await collectionVerb.run(ctx("create", { type: "entities" }, ["people"]));
    assert.equal(needsPrompt.state, "error");
    assert.match(needsPrompt.error ?? "", /--prompt|--schema/);

    const [ok] = await collectionVerb.run(ctx("create", { type: "entities", prompt: "extract people" }, ["people"]));
    assert.equal(ok.state, "ready");

    const [bad] = await collectionVerb.run(ctx("frobnicate"));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /unknown collection action/);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
  }
});

// ---- ask --collection ------------------------------------------------------

test("ask --collection routes to tinycloud collection ask (answer + citations)", async () => {
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = BASE;
  try {
    const [rec] = await askVerb.run(ctx("What did they object to?", { collection: "col_x" }));
    assert.equal(rec.verb, "ask");
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    assert.match(p.text as string, /objected to the price/);
    assert.equal((p.citations as unknown[]).length, 1);
    assert.equal(p.collection, "col_x");
    assert.equal(rec.meta?.provider, "cloudglue");
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
  }
});

// ---- Bugbot round-1 regressions --------------------------------------------

test("runTinycloud: a 'ready' envelope with a non-zero exit is an error, not success (#4)", async () => {
  const saved = process.env.OVERCAST_FAKE_TC_MODE;
  process.env.OVERCAST_FAKE_TC_MODE = "ready_exit1";
  try {
    const rec = await runFace({ op: "detect", source: "clip.mp4" }, { base: BASE });
    assert.equal(rec.state, "error");
    assert.ok(rec.error);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
    else process.env.OVERCAST_FAKE_TC_MODE = saved;
  }
});

test("ask --collection rejects an invalid --limit instead of dropping it (#6)", async () => {
  const [rec] = await askVerb.run(ctx("q?", { collection: "col_x", limit: 0 }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /--limit/);
});

test("collection add to an UNMIRRORED id records a stub + tracks the member (#2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-colmir-"));
  const video = join(cdir, "v.mp4");
  writeFileSync(video, "x");
  const mkc = (input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext =>
    ({ input, rest, opts, case: openCase(cdir), profile: defaultProfile() });
  try {
    const c = openCase(cdir); c.ensure();
    assert.equal(findCollection(c, "col_remote"), undefined); // not created via this case
    const [rec] = await collectionVerb.run(mkc("add", [video], { to: "col_remote" }));
    assert.notEqual(rec.state, "error");
    const col = findCollection(openCase(cdir), "col_remote");
    assert.ok(col, "stub mirror entry created for the remote-only collection");
    assert.equal(col!.members.length, 1);
    assert.equal(col!.members[0].ref, video);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("collection add --all registers captured/watched videos but NOT scan page URLs (#1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-colall-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_a", type: "media-descriptions", name: "a" });
    c.writeRecord(makeRecord({ verb: "capture", payload: { kind: "media" }, media: { ref: "/tmp/clipA.mp4" }, state: "ready" }));
    c.writeRecord(makeRecord({ verb: "scan", payload: { url: "https://news.example/post" }, media: { ref: "https://news.example/post" }, state: "ready" }));
    const recs = await collectionVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_a" }, case: openCase(cdir), profile: defaultProfile() });
    const members = findCollection(openCase(cdir), "col_a")!.members.map((m) => m.ref);
    assert.deepEqual(members, ["/tmp/clipA.mp4"]); // the .mp4 only; the scan page URL is excluded
    assert.equal(recs.length, 1); // exactly one tinycloud add (the video)
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("custom face provider receives --match for a collection-wide search (#3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-faceprov-"));
  const prov = join(cdir, "face-prov.sh");
  writeFileSync(prov, '#!/usr/bin/env bash\nif printf "%s " "$@" | grep -q -- --match; then m=true; else m=false; fi\necho "{\\"verb\\":\\"face\\",\\"payload\\":{\\"got_match\\":$m},\\"state\\":\\"ready\\"}"\n');
  chmodSync(prov, 0o755);
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    const p = defaultProfile();
    p.providers = { ...p.providers, face: { type: "exec", run: `bash ${prov} {{input}}` } };
    // search: --match image + --collection, no video → the custom branch must forward --match
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img, collection: "col_face" }, case: c, profile: p });
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).got_match, true);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("tinycloudBaseFromRun extracts the leading command of a bound tinycloud run (#5)", () => {
  assert.equal(tinycloudBaseFromRun(undefined), undefined);
  assert.equal(tinycloudBaseFromRun("tinycloud face {{input}} --json"), "tinycloud");
  assert.equal(tinycloudBaseFromRun("tinycloud-beta face detect {{input}}"), "tinycloud-beta");
  assert.equal(tinycloudBaseFromRun("/opt/tc/tinycloud library collections list --json"), "/opt/tc/tinycloud");
});

// ---- Bugbot round-2 regressions --------------------------------------------

test("mapTinycloudState: an UNRECOGNIZED status never maps to ready (#R2-6)", () => {
  assert.equal(mapTinycloudState({ status: "analyzing" }, {}, 0), "pending");
  assert.equal(mapTinycloudState({ status: "analyzing" }, {}, null), "pending");
  assert.equal(mapTinycloudState({ status: "weird" }, {}, 1), "error");
  assert.equal(mapTinycloudState({ status: "weird" }, {}, 2), "needs_credentials");
});

test("faceArgv repeats --in per collection, not one --in with many values (#R2-4)", () => {
  const a = faceArgv({ op: "search", image: "q.jpg", collections: ["col_a", "col_b"] });
  assert.equal(a.filter((t) => t === "--in").length, 2);
  assert.ok(a.join(" ").includes("--in collection:col_a --in collection:col_b"));
});

test("ask --collection rejects --since (no time filter on a collection query) (#R2-5)", async () => {
  const [rec] = await askVerb.run(ctx("q?", { collection: "col_x", since: "24h" }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /--since/);
});

test("face --collection that resolves to no id is a usage error, not an unscoped run (#R2-1)", async () => {
  const [rec] = await faceVerb.run(ctx(clip, { collection: " , " }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /no valid collection id/);
});

test("face --match + a video + --collection errors instead of ignoring --collection (#R2-3)", async () => {
  const [rec] = await faceVerb.run(ctx(clip, { match: face, collection: "col_x" }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /can't combine with a video/);
});

test("collection add --type face types the stub so face --match auto-resolves it (#R2-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stubtype-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    await collectionVerb.run({ input: "add", rest: [video], opts: { to: "col_face", type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(findCollection(openCase(cdir), "col_face")?.type, "face-analysis");
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal((rec.payload as Record<string, unknown>).op, "search");
    assert.equal((rec.payload as Record<string, unknown>).collection, "col_face");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face --match does NOT auto-pick an unknown-typed stub (must be classified/explicit) (#R7-3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stubunk-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_u", type: "unknown", name: "col_u" }); // an untyped stub
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /face-analysis collection/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("collection add --all includes listen-sensed media (#R2-7)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-listenall-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_l", type: "media-descriptions", name: "l" });
    c.writeRecord(makeRecord({ verb: "listen", payload: { transcript: "hi" }, media: { ref: "/tmp/call.m4a" }, state: "ready" }));
    await collectionVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_l" }, case: openCase(cdir), profile: defaultProfile() });
    const members = findCollection(openCase(cdir), "col_l")!.members.map((m) => m.ref);
    assert.deepEqual(members, ["/tmp/call.m4a"]);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- Bugbot round-3 regressions --------------------------------------------

test("ask --collection rejects local-memory flags --deep/--memory/--verb (#R3-1)", async () => {
  for (const opt of [{ deep: true }, { memory: "local" }, { verb: "watch" }] as const) {
    const [rec] = await askVerb.run(ctx("q?", { collection: "col_x", ...opt }));
    assert.equal(rec.state, "error", `expected error for ${JSON.stringify(opt)}`);
    assert.match(rec.error ?? "", /supported with --collection/);
  }
});

test("removeCollection matches by id only, never display name (#R3-2)", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-rmcol-")));
  c.ensure();
  // col_b's NAME collides with col_a's id — deleting col_a must not drop col_b.
  addCollection(c, { id: "col_a", type: "media-descriptions", name: "a" });
  addCollection(c, { id: "col_b", type: "media-descriptions", name: "col_a" });
  assert.equal(removeCollection(c, "col_a"), true);
  const left = listCollections(c).map((x) => x.id);
  assert.deepEqual(left, ["col_b"]); // only the id match removed
});

test("faceArgv forwards --limit for detect/list/search but never match (#R3-3)", () => {
  assert.ok(faceArgv({ op: "detect", source: "v.mp4", limit: 5 }).includes("--limit"));
  assert.ok(faceArgv({ op: "search", image: "q.jpg", collections: ["c"], limit: 5 }).includes("--limit"));
  assert.ok(!faceArgv({ op: "match", image: "q.jpg", source: "v.mp4", limit: 5 }).includes("--limit"));
});

test("collection remove updates the mirror on an accepted op (#R3-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-rmmem-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_r", type: "media-descriptions", name: "r" });
    addMember(c, "col_r", { ref: video });
    assert.equal(findCollection(openCase(cdir), "col_r")!.members.length, 1);
    await collectionVerb.run({ input: "remove", rest: [video], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(findCollection(openCase(cdir), "col_r")!.members.length, 0);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- Bugbot round-4 regressions --------------------------------------------

test("ask --scope without --probe, and --probe without --collection, are errors (#R4-1/#R4-2)", async () => {
  const [a] = await askVerb.run(ctx("q?", { collection: "col_x", scope: "file" })); // scope, no probe
  assert.equal(a.state, "error");
  assert.match(a.error ?? "", /--scope only applies with --probe/);
  const [b] = await askVerb.run(ctx("q?", { probe: true })); // probe, no collection
  assert.equal(b.state, "error");
  assert.match(b.error ?? "", /only apply with --collection/);
});

test("collection add --type face upgrades an existing unknown stub (#R4-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-typeup-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_x", type: "unknown", name: "col_x" });
    await collectionVerb.run({ input: "add", rest: [video], opts: { to: "col_x", type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(findCollection(openCase(cdir), "col_x")?.type, "face-analysis");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("collection add --all skips non-ready (failed) sense records (#R4-5)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-failall-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_v", type: "media-descriptions", name: "v" });
    c.writeRecord(makeRecord({ verb: "watch", payload: {}, media: { ref: "/tmp/bad.mp4" }, error: "boom", state: "error" }));
    c.writeRecord(makeRecord({ verb: "capture", payload: { kind: "media" }, media: { ref: "/tmp/good.mp4" }, state: "ready" }));
    await collectionVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_v" }, case: openCase(cdir), profile: defaultProfile() });
    const members = findCollection(openCase(cdir), "col_v")!.members.map((m) => m.ref);
    assert.deepEqual(members, ["/tmp/good.mp4"]); // the errored watch is excluded
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("collection entities validates --limit/--offset like ask (#R4-6)", async () => {
  const [rec] = await collectionVerb.run(ctx("entities", { limit: 0 }, ["col_x", "vid"]));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /invalid --limit/);
});

// ---- Bugbot round-5 regressions --------------------------------------------

test("ask --collection rejects a blank value (#R5-1)", async () => {
  const [rec] = await askVerb.run(ctx("q?", { collection: "   " }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /--collection requires/);
});

test("ask --collection rejects a non-media-descriptions collection (#R5-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-asktype-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_f", type: "face-analysis", name: "faces" });
    const [rec] = await askVerb.run({ input: "q?", rest: [], opts: { collection: "col_f" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /not media-descriptions/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("resolveCollectionRef errors on an ambiguous name; findCollection returns undefined (#R5-3)", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-dupname-")));
  c.ensure();
  addCollection(c, { id: "col_1", type: "media-descriptions", name: "calls" });
  addCollection(c, { id: "col_2", type: "media-descriptions", name: "calls" });
  const r = resolveCollectionRef(c, "calls");
  assert.match(r.error ?? "", /matches 2 collections/);
  assert.equal(findCollection(c, "calls"), undefined); // ambiguity-safe
  assert.equal(resolveCollectionRef(c, "col_1").entry?.id, "col_1"); // an exact id still resolves
});

test("collection entities does NOT require the local file (reads remote pre-extracted data) (#R5-4 → code-review [6])", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entex-"));
  try {
    const c = openCase(cdir); c.ensure();
    // a video indexed remotely whose local file is gone must still be readable for
    // its extracted entities — same stance as `collection remove` (requireExists:false).
    const [rec] = await collectionVerb.run({ input: "entities", rest: ["col_x", join(cdir, "gone.mp4")], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(rec.state, "error"); // no "video not found"
    // ...but a non-AV ref is still rejected (the filter still runs)
    const [bad] = await collectionVerb.run({ input: "entities", rest: ["col_x", join(cdir, "notes.txt")], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /not a video\/audio/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- Bugbot round-6 regressions --------------------------------------------

test("face --collection rejects an ambiguous display name (#R6-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-faceamb-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_1", type: "face-analysis", name: "faces" });
    addCollection(c, { id: "col_2", type: "face-analysis", name: "faces" });
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img, collection: "faces" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /matches 2 collections/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face --collection rejects a non-face-analysis collection type (#R6-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-facetype-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_m", type: "media-descriptions", name: "media" });
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img, collection: "col_m" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /not face-analysis/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face rejects invalid numeric flags (--limit 0, --min-similarity 150 — tinycloud's 0–100 scale) (#R6-3)", async () => {
  const [a] = await faceVerb.run(ctx(clip, { limit: 0 }));
  assert.equal(a.state, "error");
  assert.match(a.error ?? "", /invalid --limit/);
  // tinycloud similarity is a 0–100 percent, so > 100 is invalid; a value like 90 is valid
  const [b] = await faceVerb.run(ctx(clip, { "min-similarity": 150, match: face }));
  assert.equal(b.state, "error");
  assert.match(b.error ?? "", /invalid --min-similarity/);
});

// ---- Bugbot round-7 regressions --------------------------------------------

test("collection entities rejects a non-entities collection type (#R7-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-enttype-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_m", type: "media-descriptions", name: "m" });
    const [rec] = await collectionVerb.run({ input: "entities", rest: ["col_m", "vid"], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /not entities/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face --match rejects a record id whose media isn't an image (#R7-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-matchrec-"));
  try {
    const c = openCase(cdir); c.ensure();
    const watch = makeRecord({ verb: "watch", payload: { content: "x" }, media: { ref: "/tmp/clip.mp4" }, state: "ready" });
    c.writeRecord(watch);
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: watch.id, collection: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /isn't a face image/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-8 regressions --------------------------------------------

test("single collection add filters non-ready / face-search / non-AV like --all (#R8-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-add1-"));
  const good = join(cdir, "good.mp4"); writeFileSync(good, "x");
  const notav = join(cdir, "notes.txt"); writeFileSync(notav, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_x", type: "media-descriptions", name: "x" });
    const bad = makeRecord({ verb: "watch", payload: {}, media: { ref: good }, error: "boom", state: "error" });
    c.writeRecord(bad);
    const mk = (rest: string[]) => ({ input: "add", rest, opts: { to: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
    const [r1] = await collectionVerb.run(mk([bad.id])); // a failed watch record
    assert.match(r1.error ?? "", /isn't ready/);
    const [r2] = await collectionVerb.run(mk([notav])); // a non-AV file
    assert.match(r2.error ?? "", /not a video\/audio/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection entities trims a blank id (#R8-2)", async () => {
  const [rec] = await collectionVerb.run(ctx("entities", {}, ["   ", "vid"]));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /usage: collection entities/);
});

test("addMember/removeMember match by id only, not a colliding display name (#R8-3)", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-mem-")));
  c.ensure();
  addCollection(c, { id: "col_a", type: "media-descriptions", name: "a" });
  addCollection(c, { id: "col_b", type: "media-descriptions", name: "col_a" }); // name collides with col_a's id
  assert.equal(addMember(c, "col_a", { ref: "v.mp4" }), true);
  assert.equal(findCollection(c, "col_a")!.members.length, 1); // recorded on col_a (the id)
  assert.equal(findCollection(c, "col_b")!.members.length, 0); // NOT the name-colliding entry
});

test("custom face provider gets the auto-picked sole face collection + op (#R7-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-custres-"));
  const prov = join(cdir, "fp.sh");
  writeFileSync(prov, '#!/usr/bin/env bash\nargs="$*"\nc=""; o=""\nif echo "$args" | grep -q -- "--collection col_f"; then c=yes; fi\nif echo "$args" | grep -q -- "--op search"; then o=yes; fi\necho "{\\"verb\\":\\"face\\",\\"payload\\":{\\"got_collection\\":\\"$c\\",\\"got_op\\":\\"$o\\"},\\"state\\":\\"ready\\"}"\n');
  chmodSync(prov, 0o755);
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_f", type: "face-analysis", name: "faces" });
    const p = defaultProfile();
    p.providers = { ...p.providers, face: { type: "exec", run: `bash ${prov} {{input}}` } };
    // no --collection: the custom path must apply the same sole-face-collection auto-pick + op resolution
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img }, case: c, profile: p });
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).got_collection, "yes");
    assert.equal((rec.payload as Record<string, unknown>).got_op, "yes");
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-9 regressions --------------------------------------------

test("single collection add rejects a scan record (page URL), like --all (#R9-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-addscan-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_x", type: "media-descriptions", name: "x" });
    const scan = makeRecord({ verb: "scan", payload: { url: "https://news.example/post" }, media: { ref: "https://news.example/post" }, state: "ready" });
    c.writeRecord(scan);
    const [rec] = await collectionVerb.run({ input: "add", rest: [scan.id], opts: { to: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /is a scan record/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("a pinned full-path tinycloud face binding runs ALL ops via runFace, not the template's subcommand (#R9-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-pinned-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    const p = defaultProfile();
    // a "pinned binary" (the fake) whose template hardcodes `face detect`
    p.providers = { ...p.providers, face: { type: "exec", run: `${BASE} face detect {{input}} --json` } };
    const [rec] = await faceVerb.run({ input: vid, rest: [], opts: { match: img }, case: c, profile: p });
    const pl = rec.payload as Record<string, unknown>;
    assert.equal(pl.op, "match"); // op resolved + routed through runFace, not the template's `detect`
    assert.equal((pl.faces as Array<Record<string, unknown>>)[0].similarity, 92.5); // the fixture's `face match` result (0–100)
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-10 regressions -------------------------------------------

test("collection add rejects an invalid --type (not silently dropped) (#R10-1)", async () => {
  const [rec] = await collectionVerb.run(ctx("add", { type: "facce", to: "col_x" }, ["vid"]));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /unknown --type/);
});

test("doctor warns about missing tinycloud even when watch/listen are custom-bound (#R10-2)", async () => {
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = "oc-no-such-tinycloud-binary";
  const cdir = mkdtempSync(join(tmpdir(), "oc-doctor-"));
  try {
    const c = openCase(cdir); c.ensure();
    const p = defaultProfile();
    p.providers = { ...p.providers, watch: { type: "exec", run: "bash custom-watch.sh {{input}}" }, listen: { type: "exec", run: "bash custom-listen.sh {{input}}" } };
    const [rec] = await doctorVerb.run({ input: undefined, rest: [], opts: {}, case: c, profile: p, home: cdir });
    const warnings = (rec.payload as Record<string, unknown>).warnings as string[];
    assert.ok(warnings.some((w) => /tinycloud CLI missing/.test(w)), `expected a tinycloud-missing warning; got ${JSON.stringify(warnings)}`);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("collection remove: a pending async op reports removed:true AND prunes the mirror (no contradiction) (#R10-3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-rmpend-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_r", type: "media-descriptions", name: "r" });
    addMember(c, "col_r", { ref: video });
    const [rec] = await collectionVerb.run({ input: "remove", rest: [video], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "pending"); // the fixture's async remove
    assert.equal((rec.payload as Record<string, unknown>).removed, true); // payload agrees with the mirror update
    assert.equal(findCollection(openCase(cdir), "col_r")!.members.length, 0); // mirror pruned
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("writeRecord stamps the case dir + pageCommand embeds --case (paging works from any cwd) (#P2)", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-pagecase-"));
  try {
    const c = openCase(cdir); c.ensure();
    const rec = makeRecord({ verb: "face", payload: { op: "detect", faces: [{ at: 0 }], count: 1 }, state: "ready" });
    c.writeRecord(rec);
    assert.equal(rec.meta?.case, cdir); // every persisted record carries its case
    assert.ok(pageCommand(rec, { withCase: true }).includes(`--case ${cdir}`), "single-record page hint embeds the owning case dir");
    assert.ok(!pageCommand(rec).includes("--case"), "compact (multi-record) locator stays case-free");
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Face headline summary (first-run ergonomics) --------------------------

test("face detect synthesizes a headline summary (count + frames + 'not unique people' caveat), ahead of the faces blob", async () => {
  const rec = await runFace({ op: "detect", source: "clip.mp4" }, { base: BASE });
  const p = rec.payload as Record<string, unknown>;
  assert.match(String(p.summary), /2 face detections/);
  assert.match(String(p.summary), /not unique people/); // the key caveat the first run lacked
  assert.match(String(p.summary), /--match/);           // points at the op that finds a person
  assert.equal(p.provider_summary, "2 faces detected");  // tinycloud's own terse line kept too
  const keys = Object.keys(p);
  assert.ok(keys.indexOf("summary") < keys.indexOf("faces"), "summary precedes the faces[] blob");
  assert.ok(keys.indexOf("count") < keys.indexOf("detailed"), "count precedes the detailed blob");
});

test("face match summary reports moment count, span + similarity percent; moments is the compact timeline", async () => {
  const rec = await runFace({ op: "match", image: "suspect.jpg", source: "clip.mp4" }, { base: BASE });
  const p = rec.payload as Record<string, unknown>;
  assert.match(String(p.summary), /reference face matched at 1 moment/);
  assert.match(String(p.summary), /92\.5%/); // similarity is a 0–100 percent
  // moments = compact {at, similarity} (no box/thumbnail), before the faces[] blob
  const moments = p.moments as Array<Record<string, unknown>>;
  assert.equal(moments.length, 1);
  assert.deepEqual(moments[0], { at: 12, similarity: 92.5 });
  const keys = Object.keys(p);
  assert.ok(keys.indexOf("moments") < keys.indexOf("faces"));
});

test("case memory get on an unknown id names the current case (the per-case wrong-cwd footgun)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-nocase-"));
  try {
    const c = openCase(cdir); c.ensure();
    const [rec] = await caseVerb.run({ input: "memory", rest: ["get", "rec_nope"], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /per-case/);
    assert.ok((rec.error ?? "").includes(cdir), "error names the current case dir");
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Round 19 --------------------------------------------------------------

test("collection create rejects a blank --schema= / --prompt= / --description= (create blank-flag sweep)", async () => {
  for (const f of ["schema", "prompt", "description"]) {
    const [rec] = await collectionVerb.run({ input: "create", rest: ["c"], opts: { type: "media-descriptions", [f]: "" }, case: openCase(dir), profile: defaultProfile() });
    assert.equal(rec.state, "error", `--${f}= should error`);
    assert.match(rec.error ?? "", new RegExp(`--${f} requires`));
  }
});

test("the long tinycloud exec timeout is a single shared constant (collection/ask inherit it)", () => {
  assert.equal(TINYCLOUD_TIMEOUT_MS, 15 * 60_000); // collection + ask get this via runTinycloud's default, matching face/watch/listen
});

// ---- Round 18 --------------------------------------------------------------

test("collection honors a pinned tinycloud in providers.collection (not just env/PATH)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-colbase-"));
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = "/nonexistent/tc-DOES-NOT-EXIST"; // env fallback would fail
    const c = openCase(cdir); c.ensure();
    const prof = defaultProfile();
    prof.providers = { ...prof.providers, collection: { run: `${BASE} library collections {{x}}` } };
    const [rec] = await collectionVerb.run({ input: "create", rest: ["pin-test"], opts: { type: "media-descriptions" }, case: openCase(cdir), profile: prof });
    assert.equal(rec.state, "ready"); // created via the PINNED profile base (fixture), not the bad env fallback
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- Round 17 + shared-validator holistic pass -----------------------------

test("face rejects a blank --start= / --end= (window-flag hygiene)", async () => {
  const [a] = await faceVerb.run(ctx(clip, { start: "" }));
  assert.equal(a.state, "error"); assert.match(a.error ?? "", /--start requires/);
  const [b] = await faceVerb.run(ctx(clip, { end: "" }));
  assert.equal(b.state, "error"); assert.match(b.error ?? "", /--end requires/);
});

test("collection entities rejects a misused --to/--from", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entflag-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_e", type: "entities", name: "e" });
    const [rec] = await collectionVerb.run({ input: "entities", rest: ["col_e", vid], opts: { to: "col_e" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /don't apply/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection add --type matches a sole unknown stub (resolveTarget keeps unknown)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stub-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_u", type: "unknown", name: "col_u" });
    const [rec] = await collectionVerb.run({ input: "add", rest: [vid], opts: { type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(rec.state, "error"); // the sole unknown stub is upgraded + used, not "no collections"
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection add --all rejects a stray positional video", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allpos-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_a", type: "media-descriptions", name: "a" });
    const [rec] = await collectionVerb.run({ input: "add", rest: [vid], opts: { all: true, to: "col_a" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /--all registers every/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection add --all surfaces failed senses instead of 'no videos'", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allfail-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_f", type: "media-descriptions", name: "f" });
    c.writeRecord(makeRecord({ verb: "watch", payload: {}, media: { ref: "/tmp/x.mp4" }, state: "error" }));
    const [rec] = await collectionVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_f" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /failed to sense/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection add --all pending count ignores a face-search record (shared predicate)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allsearch-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_s", type: "media-descriptions", name: "s" });
    // a pending face SEARCH record (media = query image) must NOT be counted as a pending video
    c.writeRecord(makeRecord({ verb: "face", payload: { op: "search" }, media: { ref: "/tmp/q.jpg" }, state: "pending" }));
    const [rec] = await collectionVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_s" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /no new captured\/sensed videos/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection entities rejects a blank --offset= (shared numeric validator; was empty→0)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entoff-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_o", type: "entities", name: "o" });
    const [rec] = await collectionVerb.run({ input: "entities", rest: ["col_o", vid], opts: { offset: "" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /invalid --offset/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Code-review (max) findings --------------------------------------------

test("media-ref isAv accepts the broader set watch/listen take (.ts transport stream) — code-review [0]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-avfmt-"));
  const ts = join(cdir, "stream.ts"); writeFileSync(ts, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_a", type: "media-descriptions", name: "a" });
    const [rec] = await collectionVerb.run({ input: "add", rest: [ts], opts: { to: "col_a" }, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(rec.state, "error"); // a .ts clip is no longer rejected as "not a video"
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection declares a 3rd positional so `entities <id> <video>` is reachable from the agent surface — code-review [3]", () => {
  assert.equal(collectionVerb.args.length, 3);
  assert.equal(collectionVerb.args[2].name, "arg2");
});

test("bare `collection delete` (no id) errors instead of deleting the sole collection — code-review [9]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-baredel-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [rec] = await collectionVerb.run({ input: "delete", rest: [], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /explicit id/);
    assert.equal(listCollections(openCase(cdir)).length, 1); // the sole collection survives
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection add --to a typed collection with a conflicting --type errors — code-review [4]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-typeconf-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_md", type: "media-descriptions", name: "md" });
    const [rec] = await collectionVerb.run({ input: "add", rest: [vid], opts: { to: "col_md", type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /conflicts with collection/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face accepts an enhance record's video (MEDIA_VERBS includes enhance) — code-review [7]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-faceenh-"));
  const enhanced = join(cdir, "enhanced.mp4"); writeFileSync(enhanced, "x");
  try {
    const c = openCase(cdir); c.ensure();
    const e = makeRecord({ verb: "enhance", payload: {}, media: { ref: enhanced }, state: "ready" });
    c.writeRecord(e);
    const [rec] = await faceVerb.run({ input: e.id, rest: [], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(rec.state, "error"); // an enhanced clip is a valid face source
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face rejects an empty --min-similarity= (not silently a 0 floor) — code-review [min-sim]", async () => {
  const [rec] = await faceVerb.run(ctx(clip, { "min-similarity": "", match: face }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /invalid --min-similarity/);
});

test("mapTinycloudState: a null exit (signal kill) on a ready/pending status is an error — code-review [10]", () => {
  assert.equal(mapTinycloudState({ status: "ready" }, {}, null), "error");
  assert.equal(mapTinycloudState({ status: "pending" }, {}, null), "error");
});

test("collection mirror load() tolerates a valid-JSON-but-wrong-shape file — code-review [12]", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-badshape-"));
  try {
    const c = openCase(cdir); c.ensure();
    writeFileSync(c.collectionsFile, JSON.stringify({ collections: null }));
    assert.deepEqual(listCollections(openCase(cdir)), []); // no throw
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("tinycloudBaseFromRun keeps leading global flags before the subcommand — code-review [1/5/8]", () => {
  assert.equal(tinycloudBaseFromRun("tinycloud --config /etc/tc.toml face detect {{input}}"), "tinycloud --config /etc/tc.toml");
  assert.equal(tinycloudBaseFromRun("/opt/tc/tinycloud face detect {{input}}"), "/opt/tc/tinycloud");
});

test("brief rejects an empty --scope= (not the full unfiltered brief) — code-review [brief]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-briefscope-"));
  try {
    const c = openCase(cdir); c.ensure();
    const [rec] = await briefVerb.run({ input: undefined, rest: [], opts: { scope: "" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /--scope requires a value/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Holistic pass (theme closure) -----------------------------------------

test("mapTinycloudState: a 'pending' (or 'ready') status with a failure exit is an error", () => {
  assert.equal(mapTinycloudState({ status: "pending" }, {}, 1), "error");
  assert.equal(mapTinycloudState({ status: "pending" }, {}, 2), "needs_credentials");
  assert.equal(mapTinycloudState({ status: "pending" }, {}, 3), "pending"); // needs_upload/download legitimately exits 3
  assert.equal(mapTinycloudState({ status: "pending" }, {}, 0), "pending");
  assert.equal(mapTinycloudState({ status: "ready" }, {}, 1), "error");
});

test("face video input applies the shared media filters (rejects a scan record)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-facevid-"));
  try {
    const c = openCase(cdir); c.ensure();
    const scan = makeRecord({ verb: "scan", payload: { url: "https://x/p" }, media: { ref: "https://x/p.html" }, state: "ready" });
    c.writeRecord(scan);
    const [rec] = await faceVerb.run({ input: scan.id, rest: [], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /is a scan record|not a video/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("single collection add dedupes an already-registered video (no re-submit)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-dedupe-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_d", type: "media-descriptions", name: "d" });
    addMember(c, "col_d", { ref: vid });
    const [rec] = await collectionVerb.run({ input: "add", rest: [vid], opts: { to: "col_d" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).already_member, true);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-16 regressions -------------------------------------------

test("collection remove applies media filters but allows a gone file / errored record (#R16-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-rmfilt-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_r", type: "media-descriptions", name: "r" });
    addMember(c, "col_r", { ref: "/tmp/gone.mp4" });
    const scan = makeRecord({ verb: "scan", payload: { url: "https://x/p" }, media: { ref: "https://x/p" }, state: "ready" });
    c.writeRecord(scan);
    const [bad] = await collectionVerb.run({ input: "remove", rest: [scan.id], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.match(bad.error ?? "", /is a scan record/); // a scan record is rejected
    // a gone local file is still removable (no existsSync gate on remove)
    const [ok] = await collectionVerb.run({ input: "remove", rest: ["/tmp/gone.mp4"], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(ok.state, "error");
    assert.equal(findCollection(openCase(cdir), "col_r")!.members.length, 0);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection add --all reports pending videos instead of 'no videos' (#R16-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allpend-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_p", type: "media-descriptions", name: "p" });
    c.writeRecord(makeRecord({ verb: "watch", payload: {}, media: { ref: "/tmp/inflight.mp4" }, state: "pending" }));
    const [rec] = await collectionVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_p" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /still processing \(pending\)/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-15 regressions -------------------------------------------

test("collection add/remove reject the inapplicable target flag (--from on add, --to on remove) (#R15-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-wrongflag-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [a] = await collectionVerb.run({ input: "add", rest: [vid], opts: { from: "col_only" }, case: openCase(cdir), profile: defaultProfile() });
    assert.match(a.error ?? "", /targets with --to/);
    const [r] = await collectionVerb.run({ input: "remove", rest: [vid], opts: { to: "col_only" }, case: openCase(cdir), profile: defaultProfile() });
    assert.match(r.error ?? "", /targets with --from/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("collection entities applies add's media filters (rejects a scan record) (#R15-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entfilt-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_e", type: "entities", name: "e" });
    const scan = makeRecord({ verb: "scan", payload: { url: "https://x/post" }, media: { ref: "https://x/post" }, state: "ready" });
    c.writeRecord(scan);
    const [rec] = await collectionVerb.run({ input: "entities", rest: ["col_e", scan.id], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /is a scan record/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-14 regressions -------------------------------------------

test("collection create rejects a whitespace-only name and a whitespace-only entities --prompt (#R14-1/#R14-2)", async () => {
  const [n] = await collectionVerb.run(ctx("create", { type: "media" }, ["   "]));
  assert.equal(n.state, "error");
  assert.match(n.error ?? "", /usage: collection create/);
  const [p] = await collectionVerb.run(ctx("create", { type: "entities", prompt: "   " }, ["people"]));
  assert.equal(p.state, "error");
  assert.match(p.error ?? "", /--prompt|--schema/);
});

test("collection delete rejects a misused --to (no silent sole-collection delete) (#R14-3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stray-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [d] = await collectionVerb.run({ input: "delete", rest: [], opts: { to: "col_only" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(d.state, "error");
    assert.match(d.error ?? "", /positional id/);
    assert.equal(listCollections(openCase(cdir)).length, 1); // the sole collection was NOT deleted
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face --match record rejects an http video/page media.ref (#R14-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-httpimg-"));
  try {
    const c = openCase(cdir); c.ensure();
    const w = makeRecord({ verb: "watch", payload: {}, media: { ref: "https://example.com/clip.mp4" }, state: "ready" });
    c.writeRecord(w);
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: w.id, collection: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /isn't a face image/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-13 regression --------------------------------------------

test("empty-string --match / --type are rejected, not treated as omitted (#R13)", async () => {
  // face --match= must NOT silently run detect
  const [f] = await faceVerb.run(ctx(clip, { match: "" }));
  assert.equal(f.state, "error");
  assert.match(f.error ?? "", /--match requires/);
  // collection create --type= must NOT silently default to media-descriptions
  const [cr] = await collectionVerb.run(ctx("create", { type: "" }, ["c"]));
  assert.equal(cr.state, "error");
  assert.match(cr.error ?? "", /unknown --type/);
  // collection add --type= must NOT silently drop the type
  const [ad] = await collectionVerb.run(ctx("add", { type: "", to: "col_x" }, ["vid"]));
  assert.equal(ad.state, "error");
  assert.match(ad.error ?? "", /unknown --type/);
});

// ---- Bugbot round-12 regression --------------------------------------------

test("empty-string collection flags (--collection=, --to=) are rejected, not treated as omitted (#R12-1)", async () => {
  // ask --collection= must NOT silently fall back to local memory
  const [a] = await askVerb.run(ctx("q?", { collection: "" }));
  assert.equal(a.state, "error");
  assert.match(a.error ?? "", /--collection requires/);
  // face --collection= must NOT auto-pick / run unscoped
  const [f] = await faceVerb.run(ctx(clip, { collection: "" }));
  assert.equal(f.state, "error");
  assert.match(f.error ?? "", /--collection requires/);
  // collection add <vid> --to= must NOT target the case's sole collection
  const cdir = mkdtempSync(join(tmpdir(), "oc-emptyto-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [r] = await collectionVerb.run({ input: "add", rest: [vid], opts: { to: "" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(r.state, "error");
    assert.match(r.error ?? "", /blank collection id/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-11 regression --------------------------------------------

test("collection target rejects a BLANK explicit id but allows an omitted one (#R11)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-blanktgt-"));
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_only", type: "media-descriptions", name: "only" });
    // a PROVIDED-but-blank id is a user error — must not silently target the sole collection
    const [blank] = await collectionVerb.run({ input: "show", rest: ["   "], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(blank.state, "error");
    assert.match(blank.error ?? "", /blank collection id/);
    // an OMITTED id still resolves the case's sole collection (the convenience path)
    const [omitted] = await collectionVerb.run({ input: "show", rest: [], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(omitted.state, "error");
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});
