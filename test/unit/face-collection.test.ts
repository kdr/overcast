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
import { runFace } from "../../src/providers/tinycloud/face.ts";
import {
  normalizeCollectionType,
  addCollection,
  listCollections,
  findCollection,
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
