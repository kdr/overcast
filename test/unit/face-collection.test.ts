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
import { faceVerb, tinycloudBaseFromRun } from "../../src/verbs/face.ts";
import { collectionVerb } from "../../src/verbs/collection.ts";
import { askVerb } from "../../src/verbs/read.ts";

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
  assert.equal(faces[0].similarity, 92.5);
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
  assert.equal(faces[0].similarity, 88); // score → similarity
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

test("face --match auto-resolves a lone UNKNOWN-typed stub when no face collection exists (#R2-2b)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stubunk-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addCollection(c, { id: "col_u", type: "unknown", name: "col_u" });
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal((rec.payload as Record<string, unknown>).op, "search");
    assert.equal((rec.payload as Record<string, unknown>).collection, "col_u");
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

test("collection entities fails early on a missing local video (#R5-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entex-"));
  try {
    const c = openCase(cdir); c.ensure();
    const [rec] = await collectionVerb.run({ input: "entities", rest: ["col_x", join(cdir, "nope.mp4")], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /video not found/);
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

test("face rejects invalid numeric flags (--limit 0, --min-similarity 150) (#R6-3)", async () => {
  const [a] = await faceVerb.run(ctx(clip, { limit: 0 }));
  assert.equal(a.state, "error");
  assert.match(a.error ?? "", /invalid --limit/);
  const [b] = await faceVerb.run(ctx(clip, { "min-similarity": 150, match: face }));
  assert.equal(b.state, "error");
  assert.match(b.error ?? "", /invalid --min-similarity/);
});
