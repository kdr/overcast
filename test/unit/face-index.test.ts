// Face + index coverage. The external tinycloud process is faked
// (test/fixtures/fake-tinycloud.sh) so the REAL envelope→record mapping +
// verb/op-resolution code runs offline. Uses plain dummy files (no ffmpeg).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
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
  normalizeIndexType,
  addIndex,
  listIndexes,
  findIndex,
  resolveIndexRef,
  removeIndex,
  addMember,
  setMembers,
  removeMember,
  indexesByType,
} from "../../src/state/index.ts";
import { faceVerb } from "../../src/verbs/face.ts";
import { imageVerb } from "../../src/verbs/image.ts";
import { indexVerb } from "../../src/verbs/index.ts";
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

test("face search summary pluralizes 'matches' correctly (not 'matchs')", async () => {
  const rec = await runFace({ op: "search", image: "suspect.jpg", collections: ["col_x"] }, { base: BASE });
  const s = String((rec.payload as Record<string, unknown>).summary);
  assert.match(s, /2 matches for that face/);
  assert.doesNotMatch(s, /matchs/);
});

test("runFace search → media.ref is the query image, no seek anchor; index recorded", async () => {
  const rec = await runFace({ op: "search", image: "suspect.jpg", collections: ["col_x"] }, { base: BASE });
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.op, "search");
  assert.equal(p.index, "col_x");
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

test("face verb: --match + a single case face index → search (no video)", async () => {
  const c = openCase(dir);
  c.ensure();
  addIndex(c, { id: "col_faceA", type: "face-analysis", name: "faces" });
  try {
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: face }, case: c, profile: defaultProfile() });
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.op, "search");
    assert.equal(p.index, "col_faceA");
  } finally {
    removeIndex(c, "col_faceA");
  }
});

test("face verb: no video and no match → usage error", async () => {
  const [rec] = await faceVerb.run(ctx(undefined));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /face requires a video/);
});

// ---- index state mirror -----------------------------------------------

test("normalizeIndexType maps aliases; rejects unknown", () => {
  assert.equal(normalizeIndexType("face"), "face-analysis");
  assert.equal(normalizeIndexType("faces"), "face-analysis");
  assert.equal(normalizeIndexType("media"), "media-descriptions");
  assert.equal(normalizeIndexType("entities"), "entities");
  assert.equal(normalizeIndexType("transcripts"), "rich-transcripts");
  assert.equal(normalizeIndexType("deepface-local"), "deepface-local");
  assert.equal(normalizeIndexType("image"), "image-ransac");
  assert.equal(normalizeIndexType("nope"), undefined);
});

test("index mirror: add/find/members/remove round-trip", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-colstate-")));
  c.ensure();
  addIndex(c, { id: "col_1", type: "media-descriptions", name: "calls" });
  addIndex(c, { id: "col_2", type: "face-analysis", name: "faces" });
  assert.equal(listIndexes(c).length, 2);
  assert.equal(findIndex(c, "col_1")?.name, "calls");
  assert.equal(findIndex(c, "faces")?.id, "col_2"); // resolve by name
  assert.equal(indexesByType(c, "face-analysis").length, 1);

  assert.equal(addMember(c, "col_1", { ref: "a.mp4" }), true);
  addMember(c, "col_1", { ref: "a.mp4" }); // dedupe by ref
  addMember(c, "col_1", { ref: "b.mp4" });
  assert.equal(findIndex(c, "col_1")?.members.length, 2);
  assert.equal(addMember(c, "missing", { ref: "x" }), false);
  assert.equal(removeMember(c, "col_1", "a.mp4"), true);
  assert.equal(findIndex(c, "col_1")?.members.length, 1);

  assert.equal(removeIndex(c, "col_1"), true);
  assert.equal(listIndexes(c).length, 1);
});

test("local visual index: create/add/list/show/delete without tinycloud", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-visual-db-"));
  const img = join(cdir, "logo.jpg");
  writeFileSync(img, "not a real jpeg, but enough for mirror-level add");
  const mk = (input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext => {
    const c = openCase(cdir);
    c.ensure();
    return { input, rest, opts, case: c, profile: defaultProfile() };
  };
  try {
    const [created] = await indexVerb.run(mk("create", ["logos"], { type: "image-ransac", local: true }));
    assert.equal(created.state, "ready");
    const id = String((created.payload as Record<string, unknown>).index);
    assert.match(id, /^local_image_ransac_/);
    assert.equal(findIndex(openCase(cdir), id)?.backend, "local");

    const [added] = await indexVerb.run(mk("add", [img], { to: id }));
    assert.equal(added.state, "ready");
    assert.equal((added.payload as Record<string, unknown>).backend, "local");
    assert.equal(findIndex(openCase(cdir), id)?.members.length, 1);

    const [dupe] = await imageVerb.run(mk("add", [img], { index: id }));
    assert.equal(dupe.state, "ready");
    assert.equal((dupe.payload as Record<string, unknown>).already_member, true);

    const [listed] = await indexVerb.run(mk("list"));
    const indexes = (listed.payload as Record<string, unknown>).indexes as Array<Record<string, unknown>>;
    assert.equal(indexes[0].backend, "local");

    const [shown] = await indexVerb.run(mk("show", [id]));
    assert.equal((shown.payload as Record<string, unknown>).member_count, 1);

    const [deleted] = await indexVerb.run(mk("delete", [id]));
    assert.equal((deleted.payload as Record<string, unknown>).deleted, true);
    assert.equal(findIndex(openCase(cdir), id), undefined);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("local-only visual types require backend local and cannot be attached remotely", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-visual-db-remote-type-"));
  const video = join(cdir, "v.mp4");
  writeFileSync(video, "x");
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = BASE;
  const mk = (input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext => {
    const c = openCase(cdir);
    c.ensure();
    return { input, rest, opts, case: c, profile: defaultProfile() };
  };
  try {
    const [attach] = await indexVerb.run(mk("attach", ["remote_logos"], { type: "image-ransac" }));
    assert.equal(attach.state, "error");
    assert.match(attach.error ?? "", /local-only/);

    const c = openCase(cdir);
    c.ensure();
    addIndex(c, { id: "col_fake123", name: "remote-local-looking", type: "image-ransac" });
    const [shown] = await indexVerb.run(mk("show", ["col_fake123"]));
    assert.equal(shown.state, "ready");
    assert.notEqual((shown.payload as Record<string, unknown>).backend, "local");
    assert.equal(shown.meta?.provider, "tinycloud");
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face provider binding deepface-local runs local detect/match without requiring --index", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-deepface-provider-"));
  const video = join(cdir, "v.mp4");
  const ref = join(cdir, "ref.jpg");
  const webpRef = join(cdir, "ref.webp");
  const fakePy = join(cdir, "fake-visual-db");
  writeFileSync(video, "x");
  writeFileSync(ref, "x");
  writeFileSync(webpRef, "x");
  writeFileSync(fakePy, `#!/usr/bin/env bash
op=""
fps=""
max=""
start=""
end=""
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  if [ "$arg" = "--op" ]; then j=$((i+1)); op="\${!j}"; fi
  if [ "$arg" = "--fps" ]; then j=$((i+1)); fps="\${!j}"; fi
  if [ "$arg" = "--max-frames" ]; then j=$((i+1)); max="\${!j}"; fi
  if [ "$arg" = "--start" ]; then j=$((i+1)); start="\${!j}"; fi
  if [ "$arg" = "--end" ]; then j=$((i+1)); end="\${!j}"; fi
done
printf '{"verb":"face","format":"json","payload":{"op":"%s","count":1,"sampling":{"fps":%s,"max_frames":%s,"start":"%s","end":"%s"}},"state":"ready","meta":{"provider":"fake-deepface"}}\\n' "$op" "\${fps:-0}" "\${max:-0}" "$start" "$end"
`);
  chmodSync(fakePy, 0o755);
  const savedPy = process.env.OC_VISUAL_DB_PY;
  process.env.OC_VISUAL_DB_PY = fakePy;
  const mk = (input: string | undefined, opts: VerbContext["opts"] = {}, rest: string[] = []): VerbContext => {
    const c = openCase(cdir);
    c.ensure();
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, face: { type: "inproc", backend: "deepface-local", id: "deepface-local" } };
    return { input, rest, opts, case: c, profile };
  };
  try {
    const [det] = await faceVerb.run(mk(video, { fps: 0.5, "max-frames": 3 }));
    assert.equal(det.state, "ready");
    assert.equal((det.payload as Record<string, unknown>).op, "detect");

    const [thumbs] = await faceVerb.run(mk(video, { thumbnails: true }));
    assert.equal(thumbs.state, "error");
    assert.match(thumbs.error ?? "", /does not support --thumbnails/);

    const [match] = await faceVerb.run(mk(video, { match: ref, fps: 0.5, "max-frames": 3, start: "00:00:01", end: "3.5" }));
    assert.equal(match.state, "ready");
    assert.equal((match.payload as Record<string, unknown>).op, "match");
    const sampling = (match.payload as Record<string, unknown>).sampling as Record<string, unknown>;
    assert.equal(sampling.fps, 0.5);
    assert.equal(sampling.start, "00:00:01");
    assert.equal(sampling.end, "3.5");

    const [webp] = await faceVerb.run(mk(video, { match: webpRef }));
    assert.equal(webp.state, "ready");
    assert.equal((webp.payload as Record<string, unknown>).op, "match");
  } finally {
    if (savedPy === undefined) delete process.env.OC_VISUAL_DB_PY;
    else process.env.OC_VISUAL_DB_PY = savedPy;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face provider binding deepface-local does not intercept explicit tinycloud face indexes", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-deepface-tc-index-"));
  const video = join(cdir, "v.mp4");
  const ref = join(cdir, "ref.jpg");
  writeFileSync(video, "x");
  writeFileSync(ref, "x");
  try {
    const c = openCase(cdir);
    c.ensure();
    addIndex(c, { id: "col_faces", name: "cloud-faces", type: "face-analysis" });
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, face: { type: "inproc", backend: "deepface-local", id: "deepface-local" } };

    const [search] = await faceVerb.run({ input: undefined, rest: [], opts: { match: ref, index: "col_faces" }, case: c, profile });
    assert.equal(search.state, "ready");
    assert.equal(search.meta?.provider, "tinycloud");
    assert.equal((search.payload as Record<string, unknown>).op, "search");
    assert.equal((search.payload as Record<string, unknown>).index, "col_faces");

    const [list] = await faceVerb.run({ input: video, rest: [], opts: { index: "col_faces" }, case: c, profile });
    assert.equal(list.state, "ready");
    assert.equal(list.meta?.provider, "tinycloud");
    assert.equal((list.payload as Record<string, unknown>).op, "list");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face with a deepface-local index does not turn list into fresh detect", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-deepface-list-"));
  const video = join(cdir, "v.mp4");
  writeFileSync(video, "x");
  try {
    const c = openCase(cdir);
    c.ensure();
    addIndex(c, { id: "local_faces", name: "faces", type: "deepface-local", backend: "local" });
    const [rec] = await faceVerb.run({ input: video, rest: [], opts: { index: "local_faces" }, case: c, profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /store reference images, not per-video detections/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("deepface-local provider keeps min-similarity on the 0-100 CLI scale", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", "face_match.py"), "utf8");
  assert.doesNotMatch(src, /threshold\s*\*=/);
  assert.match(src, /threshold\s*<\s*0\s+or\s+threshold\s*>\s*100/);
});

// ---- index verb (lifecycle via the fake tinycloud) --------------------

test("index verb: create → add → list → show → delete, mirroring locally", async () => {
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
    const [created] = await indexVerb.run(mk("create", ["calls"], { type: "media" }));
    assert.equal(created.state, "ready");
    assert.equal((created.payload as Record<string, unknown>).id, "col_fake123");
    assert.equal(listIndexes(openCase(cdir)).length, 1);

    const [added] = await indexVerb.run(mk("add", [video], { to: "col_fake123" }));
    assert.equal(added.state, "pending"); // async ingest
    assert.equal(findIndex(openCase(cdir), "col_fake123")?.members.length, 1);

    const [listed] = await indexVerb.run(mk("list"));
    const lp = listed.payload as Record<string, unknown>;
    assert.equal((lp.indexes as unknown[]).length, 1);

    const [shown] = await indexVerb.run(mk("show", ["col_fake123"]));
    assert.equal((shown.payload as Record<string, unknown>).file_count, 2);

    const [deleted] = await indexVerb.run(mk("delete", ["col_fake123"]));
    assert.equal(deleted.state, "ready");
    assert.equal(listIndexes(openCase(cdir)).length, 0); // mirror pruned
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index verb: entities index needs --prompt/--schema; bogus action errors", async () => {
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = BASE;
  try {
    const [needsPrompt] = await indexVerb.run(ctx("create", { type: "entities" }, ["people"]));
    assert.equal(needsPrompt.state, "error");
    assert.match(needsPrompt.error ?? "", /--prompt|--schema/);

    const [ok] = await indexVerb.run(ctx("create", { type: "entities", prompt: "extract people" }, ["people"]));
    assert.equal(ok.state, "ready");

    const [bad] = await indexVerb.run(ctx("frobnicate"));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /unknown index action/);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
  }
});

// ---- ask --index ------------------------------------------------------

test("ask --index routes to tinycloud index ask (answer + citations)", async () => {
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = BASE;
  try {
    const [rec] = await askVerb.run(ctx("What did they object to?", { index: "col_x" }));
    assert.equal(rec.verb, "ask");
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    assert.match(p.text as string, /objected to the price/);
    assert.equal((p.citations as unknown[]).length, 1);
    assert.equal(p.index, "col_x");
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

test("runTinycloud: a 'pending' envelope carrying an error is an error, not in-progress", async () => {
  const saved = process.env.OVERCAST_FAKE_TC_MODE;
  process.env.OVERCAST_FAKE_TC_MODE = "pending_error";
  try {
    const rec = await runFace({ op: "detect", source: "clip.mp4" }, { base: BASE });
    assert.equal(rec.state, "error"); // downgraded from pending — must not satisfy accepted()
    assert.ok(rec.error);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
    else process.env.OVERCAST_FAKE_TC_MODE = saved;
  }
});

test("ask --index rejects an invalid --limit instead of dropping it (#6)", async () => {
  const [rec] = await askVerb.run(ctx("q?", { index: "col_x", limit: 0 }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /--limit/);
});

test("ask --index rejects --limit unless probing; probe forwards it", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-asklimit-"));
  const log = join(cdir, "argv.txt");
  const fake = join(cdir, "tc.sh");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\necho '{"tinycloud":"1","kind":"'$1'","status":"ready","data":{"answer":"ok","citations":[]}}'\n`,
  );
  chmodSync(fake, 0o755);
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  process.env.OVERCAST_TINYCLOUD_CMD = `bash ${fake}`;
  try {
    const c = openCase(cdir);
    c.ensure();
    const mk = (opts: VerbContext["opts"]): VerbContext => ({
      input: "q?",
      rest: [],
      opts,
      case: c,
      profile: defaultProfile(),
    });
    const [bad] = await askVerb.run(mk({ index: "col_x", limit: 3 }));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /--limit with --index only applies with --probe/);
    await askVerb.run(mk({ index: "col_x", probe: true, limit: 3 }));
    const lines = readFileSync(log, "utf8").trim().split(/\n/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^probe q\? --in collection:col_x --limit 3 --json$/);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add to an UNMIRRORED id records a stub + tracks the member (#2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-colmir-"));
  const video = join(cdir, "v.mp4");
  writeFileSync(video, "x");
  const mkc = (input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext =>
    ({ input, rest, opts, case: openCase(cdir), profile: defaultProfile() });
  try {
    const c = openCase(cdir); c.ensure();
    assert.equal(findIndex(c, "col_remote"), undefined); // not created via this case
    const [rec] = await indexVerb.run(mkc("add", [video], { to: "col_remote" }));
    assert.notEqual(rec.state, "error");
    const col = findIndex(openCase(cdir), "col_remote");
    assert.ok(col, "stub mirror entry created for the remote-only index");
    assert.equal(col!.members.length, 1);
    assert.equal(col!.members[0].ref, video);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add local video emits a watch record for local case memory, not a face detect", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-addwatch-"));
  const video = join(cdir, "v.mp4");
  writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_face", type: "face-analysis", name: "faces" });
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `${BASE} watch {{input}} --json` } };
    const recs = await indexVerb.run({ input: "add", rest: [video], opts: { to: "col_face" }, case: openCase(cdir), profile });
    assert.equal(recs[0].verb, "index");
    assert.equal(recs[1].verb, "watch");
    assert.equal(recs[1].state, "ready");
    assert.equal(recs[1].media?.ref, video);
    assert.ok(!recs.some((r) => r.verb === "face"), "index add must not create a face-detect record for local memory");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add --all registers captured/watched videos but NOT scan page URLs (#1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-colall-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_a", type: "media-descriptions", name: "a" });
    c.writeRecord(makeRecord({ verb: "capture", payload: { kind: "media" }, media: { ref: "/tmp/clipA.mp4" }, state: "ready" }));
    c.writeRecord(makeRecord({ verb: "scan", payload: { url: "https://news.example/post" }, media: { ref: "https://news.example/post" }, state: "ready" }));
    const recs = await indexVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_a" }, case: openCase(cdir), profile: defaultProfile() });
    const members = findIndex(openCase(cdir), "col_a")!.members.map((m) => m.ref);
    assert.deepEqual(members, ["/tmp/clipA.mp4"]); // the .mp4 only; the scan page URL is excluded
    assert.equal(recs.length, 1); // exactly one tinycloud add (the video)
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add --all emits watch records for captured local videos missing watch analysis", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allwatch-"));
  const video = join(cdir, "clip.mp4");
  writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_a", type: "media-descriptions", name: "a" });
    c.writeRecord(makeRecord({ verb: "capture", payload: { kind: "media" }, media: { ref: video }, state: "ready" }));
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `${BASE} watch {{input}} --json` } };
    const recs = await indexVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_a" }, case: openCase(cdir), profile });
    assert.ok(recs.some((r) => r.verb === "index"));
    assert.ok(recs.some((r) => r.verb === "watch" && r.media?.ref === video));
    assert.ok(!recs.some((r) => r.verb === "face"));
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add does not re-watch a local video with pending watch evidence", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-pendingwatch-"));
  const video = join(cdir, "v.mp4");
  writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_face", type: "face-analysis", name: "faces" });
    c.writeRecord(makeRecord({ verb: "watch", payload: { summary: "watch still processing" }, media: { ref: video }, state: "pending" }));
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `${BASE} watch {{input}} --json` } };
    const recs = await indexVerb.run({ input: "add", rest: [video], opts: { to: "col_face" }, case: openCase(cdir), profile });
    assert.ok(recs.some((r) => r.verb === "index"));
    assert.ok(!recs.some((r) => r.verb === "watch"), "pending watch evidence should prevent duplicate watch work");
    assert.ok(!recs.some((r) => r.verb === "face"));
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("custom face provider receives --match for a index-wide search (#3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-faceprov-"));
  const prov = join(cdir, "face-prov.sh");
  writeFileSync(prov, '#!/usr/bin/env bash\nif printf "%s " "$@" | grep -q -- --match; then m=true; else m=false; fi\necho "{\\"verb\\":\\"face\\",\\"payload\\":{\\"got_match\\":$m},\\"state\\":\\"ready\\"}"\n');
  chmodSync(prov, 0o755);
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    const p = defaultProfile();
    p.providers = { ...p.providers, face: { type: "exec", run: `bash ${prov} {{input}}` } };
    // search: --match image + --index, no video → the custom branch must forward --match
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img, index: "col_face" }, case: c, profile: p });
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
  assert.equal(tinycloudBaseFromRun("/opt/tc/tinycloud library indexes list --json"), "/opt/tc/tinycloud");
});

// ---- Bugbot round-2 regressions --------------------------------------------

test("mapTinycloudState: an UNRECOGNIZED status never maps to ready (#R2-6)", () => {
  assert.equal(mapTinycloudState({ status: "analyzing" }, {}, 0), "pending");
  assert.equal(mapTinycloudState({ status: "analyzing" }, {}, null), "pending");
  assert.equal(mapTinycloudState({ status: "weird" }, {}, 1), "error");
  assert.equal(mapTinycloudState({ status: "weird" }, {}, 2), "needs_credentials");
});

test("faceArgv repeats --in per index, not one --in with many values (#R2-4)", () => {
  const a = faceArgv({ op: "search", image: "q.jpg", collections: ["col_a", "col_b"] });
  assert.equal(a.filter((t) => t === "--in").length, 2);
  assert.ok(a.join(" ").includes("--in collection:col_a --in collection:col_b"));
});

test("ask --index rejects --since (no time filter on a index query) (#R2-5)", async () => {
  const [rec] = await askVerb.run(ctx("q?", { index: "col_x", since: "24h" }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /--since/);
});

test("face --index that resolves to no id is a usage error, not an unscoped run (#R2-1)", async () => {
  const [rec] = await faceVerb.run(ctx(clip, { index: " , " }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /no valid index id/);
});

test("face --match + a video + --index errors instead of ignoring --index (#R2-3)", async () => {
  const [rec] = await faceVerb.run(ctx(clip, { match: face, index: "col_x" }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /can't combine with a video/);
});

test("index add --type face types the stub so face --match auto-resolves it (#R2-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stubtype-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    await indexVerb.run({ input: "add", rest: [video], opts: { to: "col_face", type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(findIndex(openCase(cdir), "col_face")?.type, "face-analysis");
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal((rec.payload as Record<string, unknown>).op, "search");
    assert.equal((rec.payload as Record<string, unknown>).index, "col_face");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face --match does NOT auto-pick an unknown-typed stub (must be classified/explicit) (#R7-3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stubunk-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_u", type: "unknown", name: "col_u" }); // an untyped stub
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /face-analysis index/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add --all includes listen-sensed media (#R2-7)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-listenall-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_l", type: "media-descriptions", name: "l" });
    c.writeRecord(makeRecord({ verb: "listen", payload: { transcript: "hi" }, media: { ref: "/tmp/call.m4a" }, state: "ready" }));
    await indexVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_l" }, case: openCase(cdir), profile: defaultProfile() });
    const members = findIndex(openCase(cdir), "col_l")!.members.map((m) => m.ref);
    assert.deepEqual(members, ["/tmp/call.m4a"]);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- Bugbot round-3 regressions --------------------------------------------

test("ask --index rejects local-memory flags --deep/--memory/--verb (#R3-1)", async () => {
  for (const opt of [{ deep: true }, { memory: "local" }, { verb: "watch" }] as const) {
    const [rec] = await askVerb.run(ctx("q?", { index: "col_x", ...opt }));
    assert.equal(rec.state, "error", `expected error for ${JSON.stringify(opt)}`);
    assert.match(rec.error ?? "", /supported with --index/);
  }
});

test("removeIndex matches by id only, never display name (#R3-2)", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-rmcol-")));
  c.ensure();
  // col_b's NAME collides with col_a's id — deleting col_a must not drop col_b.
  addIndex(c, { id: "col_a", type: "media-descriptions", name: "a" });
  addIndex(c, { id: "col_b", type: "media-descriptions", name: "col_a" });
  assert.equal(removeIndex(c, "col_a"), true);
  const left = listIndexes(c).map((x) => x.id);
  assert.deepEqual(left, ["col_b"]); // only the id match removed
});

test("faceArgv forwards --limit for detect/list/search but never match (#R3-3)", () => {
  assert.ok(faceArgv({ op: "detect", source: "v.mp4", limit: 5 }).includes("--limit"));
  assert.ok(faceArgv({ op: "search", image: "q.jpg", collections: ["c"], limit: 5 }).includes("--limit"));
  assert.ok(!faceArgv({ op: "match", image: "q.jpg", source: "v.mp4", limit: 5 }).includes("--limit"));
});

test("index remove updates the mirror on an accepted op (#R3-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-rmmem-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_r", type: "media-descriptions", name: "r" });
    addMember(c, "col_r", { ref: video });
    assert.equal(findIndex(openCase(cdir), "col_r")!.members.length, 1);
    await indexVerb.run({ input: "remove", rest: [video], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(findIndex(openCase(cdir), "col_r")!.members.length, 0);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- Bugbot round-4 regressions --------------------------------------------

test("ask --scope without --probe, and --probe without --index, are errors (#R4-1/#R4-2)", async () => {
  const [a] = await askVerb.run(ctx("q?", { index: "col_x", scope: "file" })); // scope, no probe
  assert.equal(a.state, "error");
  assert.match(a.error ?? "", /--scope only applies with --probe/);
  const [b] = await askVerb.run(ctx("q?", { probe: true })); // probe, no index
  assert.equal(b.state, "error");
  assert.match(b.error ?? "", /only apply with --index/);
});

test("index add --type face upgrades an existing unknown stub (#R4-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-typeup-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_x", type: "unknown", name: "col_x" });
    await indexVerb.run({ input: "add", rest: [video], opts: { to: "col_x", type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(findIndex(openCase(cdir), "col_x")?.type, "face-analysis");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add --all skips non-ready (failed) sense records (#R4-5)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-failall-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_v", type: "media-descriptions", name: "v" });
    c.writeRecord(makeRecord({ verb: "watch", payload: {}, media: { ref: "/tmp/bad.mp4" }, error: "boom", state: "error" }));
    c.writeRecord(makeRecord({ verb: "capture", payload: { kind: "media" }, media: { ref: "/tmp/good.mp4" }, state: "ready" }));
    await indexVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_v" }, case: openCase(cdir), profile: defaultProfile() });
    const members = findIndex(openCase(cdir), "col_v")!.members.map((m) => m.ref);
    assert.deepEqual(members, ["/tmp/good.mp4"]); // the errored watch is excluded
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index entities validates --limit/--offset like ask (#R4-6)", async () => {
  const [rec] = await indexVerb.run(ctx("entities", { limit: 0 }, ["col_x", "vid"]));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /invalid --limit/);
});

// ---- Bugbot round-5 regressions --------------------------------------------

test("ask --index rejects a blank value (#R5-1)", async () => {
  const [rec] = await askVerb.run(ctx("q?", { index: "   " }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /--index requires/);
});

test("ask --index rejects a non-media-descriptions index (#R5-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-asktype-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_f", type: "face-analysis", name: "faces" });
    const [rec] = await askVerb.run({ input: "q?", rest: [], opts: { index: "col_f" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /not media-descriptions/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("resolveIndexRef errors on an ambiguous name; findIndex returns undefined (#R5-3)", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-dupname-")));
  c.ensure();
  addIndex(c, { id: "col_1", type: "media-descriptions", name: "calls" });
  addIndex(c, { id: "col_2", type: "media-descriptions", name: "calls" });
  const r = resolveIndexRef(c, "calls");
  assert.match(r.error ?? "", /matches 2 indexes/);
  assert.equal(findIndex(c, "calls"), undefined); // ambiguity-safe
  assert.equal(resolveIndexRef(c, "col_1").entry?.id, "col_1"); // an exact id still resolves
});

test("index entities does NOT require the local file (reads remote pre-extracted data) (#R5-4 → code-review [6])", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entex-"));
  try {
    const c = openCase(cdir); c.ensure();
    // a video indexed remotely whose local file is gone must still be readable for
    // its extracted entities — same stance as `index remove` (requireExists:false).
    const [rec] = await indexVerb.run({ input: "entities", rest: ["col_x", join(cdir, "gone.mp4")], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(rec.state, "error"); // no "video not found"
    // ...but a non-AV ref is still rejected (the filter still runs)
    const [bad] = await indexVerb.run({ input: "entities", rest: ["col_x", join(cdir, "notes.txt")], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /not a video\/audio/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- Bugbot round-6 regressions --------------------------------------------

test("face --index rejects an ambiguous display name (#R6-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-faceamb-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_1", type: "face-analysis", name: "faces" });
    addIndex(c, { id: "col_2", type: "face-analysis", name: "faces" });
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img, index: "faces" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /matches 2 indexes/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face --index rejects a non-face-analysis index type (#R6-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-facetype-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_m", type: "media-descriptions", name: "media" });
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img, index: "col_m" }, case: openCase(cdir), profile: defaultProfile() });
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

test("index entities rejects a non-entities index type (#R7-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-enttype-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_m", type: "media-descriptions", name: "m" });
    const [rec] = await indexVerb.run({ input: "entities", rest: ["col_m", "vid"], opts: {}, case: openCase(cdir), profile: defaultProfile() });
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
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: watch.id, index: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /not an image file/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face --match rejects unsupported query-image formats locally (tinycloud 0.3.6 gate)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-matchfmt-"));
  const v = join(cdir, "clip.mp4"); writeFileSync(v, "x");
  const webp = join(cdir, "suspect.webp"); writeFileSync(webp, "x");
  try {
    const [direct] = await faceVerb.run({ input: v, rest: [], opts: { match: webp }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(direct.state, "error");
    assert.match(direct.error ?? "", /JPEG or PNG/);

    const c = openCase(cdir); c.ensure();
    const imageRec = makeRecord({ verb: "capture", payload: {}, media: { ref: webp }, state: "ready" });
    c.writeRecord(imageRec);
    const [byRecord] = await faceVerb.run({ input: v, rest: [], opts: { match: imageRec.id }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(byRecord.state, "error");
    assert.match(byRecord.error ?? "", /JPEG or PNG/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-8 regressions --------------------------------------------

test("single index add filters non-ready / face-search / non-AV like --all (#R8-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-add1-"));
  const good = join(cdir, "good.mp4"); writeFileSync(good, "x");
  const notav = join(cdir, "notes.txt"); writeFileSync(notav, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_x", type: "media-descriptions", name: "x" });
    const bad = makeRecord({ verb: "watch", payload: {}, media: { ref: good }, error: "boom", state: "error" });
    c.writeRecord(bad);
    const mk = (rest: string[]) => ({ input: "add", rest, opts: { to: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
    const [r1] = await indexVerb.run(mk([bad.id])); // a failed watch record
    assert.match(r1.error ?? "", /isn't ready/);
    const [r2] = await indexVerb.run(mk([notav])); // a non-AV file
    assert.match(r2.error ?? "", /not a video\/audio/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index entities trims a blank id (#R8-2)", async () => {
  const [rec] = await indexVerb.run(ctx("entities", {}, ["   ", "vid"]));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /usage: index entities/);
});

test("addMember/removeMember match by id only, not a colliding display name (#R8-3)", () => {
  const c = openCase(mkdtempSync(join(tmpdir(), "oc-mem-")));
  c.ensure();
  addIndex(c, { id: "col_a", type: "media-descriptions", name: "a" });
  addIndex(c, { id: "col_b", type: "media-descriptions", name: "col_a" }); // name collides with col_a's id
  assert.equal(addMember(c, "col_a", { ref: "v.mp4" }), true);
  assert.equal(findIndex(c, "col_a")!.members.length, 1); // recorded on col_a (the id)
  assert.equal(findIndex(c, "col_b")!.members.length, 0); // NOT the name-colliding entry
});

test("custom face provider gets the auto-picked sole face index + op (#R7-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-custres-"));
  const prov = join(cdir, "fp.sh");
  writeFileSync(prov, '#!/usr/bin/env bash\nargs="$*"\nc=""; o=""\nif echo "$args" | grep -q -- "--index col_f"; then c=yes; fi\nif echo "$args" | grep -q -- "--op search"; then o=yes; fi\necho "{\\"verb\\":\\"face\\",\\"payload\\":{\\"got_collection\\":\\"$c\\",\\"got_op\\":\\"$o\\"},\\"state\\":\\"ready\\"}"\n');
  chmodSync(prov, 0o755);
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_f", type: "face-analysis", name: "faces" });
    const p = defaultProfile();
    p.providers = { ...p.providers, face: { type: "exec", run: `bash ${prov} {{input}}` } };
    // no --index: the custom path must apply the same sole-face-index auto-pick + op resolution
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: img }, case: c, profile: p });
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).got_collection, "yes");
    assert.equal((rec.payload as Record<string, unknown>).got_op, "yes");
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-9 regressions --------------------------------------------

test("single index add rejects a scan record (page URL), like --all (#R9-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-addscan-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_x", type: "media-descriptions", name: "x" });
    const scan = makeRecord({ verb: "scan", payload: { url: "https://news.example/post" }, media: { ref: "https://news.example/post" }, state: "ready" });
    c.writeRecord(scan);
    const [rec] = await indexVerb.run({ input: "add", rest: [scan.id], opts: { to: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
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

test("index add rejects an invalid --type (not silently dropped) (#R10-1)", async () => {
  const [rec] = await indexVerb.run(ctx("add", { type: "facce", to: "col_x" }, ["vid"]));
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

test("doctor warns when tinycloud is below the recommended version", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-doctor-tcver-"));
  try {
    const c = openCase(cdir); c.ensure();
    const [rec] = await doctorVerb.run({ input: undefined, rest: [], opts: {}, case: c, profile: defaultProfile(), home: cdir });
    const warnings = (rec.payload as Record<string, unknown>).warnings as string[];
    assert.equal(rec.state, "error");
    assert.ok(warnings.some((w) => /recommended 0\.3\.6/.test(w) && /tinycloud update/.test(w)), `expected a tinycloud update warning; got ${JSON.stringify(warnings)}`);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index remove: a pending async op reports removed:true AND prunes the mirror (no contradiction) (#R10-3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-rmpend-"));
  const video = join(cdir, "v.mp4"); writeFileSync(video, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_r", type: "media-descriptions", name: "r" });
    addMember(c, "col_r", { ref: video });
    const [rec] = await indexVerb.run({ input: "remove", rest: [video], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "pending"); // the fixture's async remove
    assert.equal((rec.payload as Record<string, unknown>).removed, true); // payload agrees with the mirror update
    assert.equal(findIndex(openCase(cdir), "col_r")!.members.length, 0); // mirror pruned
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

// ---- Holistic output consistency: index-read ops get headlines too -----

test("face list (index) summary matches detect's shape (span + 'not unique people') + moments", async () => {
  const rec = await runFace({ op: "list", source: "clip.mp4", collections: ["col_x"] }, { base: BASE });
  const p = rec.payload as Record<string, unknown>;
  assert.match(String(p.summary), /stored face detection/);
  assert.match(String(p.summary), /not unique people/);
  assert.ok(Array.isArray(p.moments)); // same pageable timeline the on-demand ops emit
});

test("index ops lead with a synthesized summary headline (show file-status, create, entities)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-colsum-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_fake123", type: "media-descriptions", name: "fixture" });
    // show: a file-status headline (fixture has 1 completed + 1 pending)
    const [show] = await indexVerb.run({ input: "show", rest: ["col_fake123"], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.match(String((show.payload as Record<string, unknown>).summary), /2 videos:.*1 ready.*1 processing/);
    assert.equal(Object.keys(show.payload as Record<string, unknown>)[1], "summary"); // headline near the top (after op)
    // create: "created <type> index '<name>'"
    const [create] = await indexVerb.run({ input: "create", rest: ["acme"], opts: { type: "media-descriptions" }, case: openCase(cdir), profile: defaultProfile() });
    assert.match(String((create.payload as Record<string, unknown>).summary), /created media-descriptions index/);
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

test("face match summary does not call low-similarity detections a match", async () => {
  const prev = process.env.OVERCAST_FAKE_TC_MODE;
  try {
    process.env.OVERCAST_FAKE_TC_MODE = "low_match";
    const rec = await runFace({ op: "match", image: "suspect.jpg", source: "clip.mp4" }, { base: BASE });
    const p = rec.payload as Record<string, unknown>;
    assert.match(String(p.summary), /no face match; faces detected, max similarity 4\.1%/);
    assert.doesNotMatch(String(p.summary), /reference face matched/);
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
    else process.env.OVERCAST_FAKE_TC_MODE = prev;
  }
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

test("index create rejects a blank --schema= / --prompt= / --description= (create blank-flag sweep)", async () => {
  for (const f of ["schema", "prompt", "description"]) {
    const [rec] = await indexVerb.run({ input: "create", rest: ["c"], opts: { type: "media-descriptions", [f]: "" }, case: openCase(dir), profile: defaultProfile() });
    assert.equal(rec.state, "error", `--${f}= should error`);
    assert.match(rec.error ?? "", new RegExp(`--${f} requires`));
  }
});

test("the long tinycloud exec timeout is a single shared constant (index/ask inherit it)", () => {
  assert.equal(TINYCLOUD_TIMEOUT_MS, 15 * 60_000); // index + ask get this via runTinycloud's default, matching face/watch/listen
});

// ---- Round 18 --------------------------------------------------------------

test("index honors a pinned tinycloud in providers.index (not just env/PATH)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-colbase-"));
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = "/nonexistent/tc-DOES-NOT-EXIST"; // env fallback would fail
    const c = openCase(cdir); c.ensure();
    const prof = defaultProfile();
    prof.providers = { ...prof.providers, index: { run: `${BASE} library indexes {{x}}` } };
    const [rec] = await indexVerb.run({ input: "create", rest: ["pin-test"], opts: { type: "media-descriptions" }, case: openCase(cdir), profile: prof });
    assert.equal(rec.state, "ready"); // created via the PINNED profile base (fixture), not the bad env fallback
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index loads a legacy collections.json mirror", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-legacy-col-"));
  try {
    const c = openCase(cdir); c.ensure();
    writeFileSync(join(c.storeDir, "collections.json"), JSON.stringify({
      collections: [{
        id: "col_legacy",
        type: "media-descriptions",
        name: "legacy",
        members: [],
        created: "2026-01-01T00:00:00Z",
      }],
    }));
    assert.equal(listIndexes(c)[0].id, "col_legacy");
    assert.equal(findIndex(c, "legacy")?.id, "col_legacy");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index and ask --index honor legacy providers.collection binding", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-legacy-provider-"));
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = "/nonexistent/tc-DOES-NOT-EXIST";
    const c = openCase(cdir); c.ensure();
    const prof = defaultProfile();
    prof.providers = { ...prof.providers, collection: { type: "exec", run: `${BASE} library collections {{x}}` } };
    const [created] = await indexVerb.run({ input: "create", rest: ["legacy-pin"], opts: { type: "media-descriptions" }, case: c, profile: prof });
    assert.equal(created.state, "ready");
    const [asked] = await askVerb.run({ input: "What happened?", rest: [], opts: { index: "col_fake123" }, case: c, profile: prof });
    assert.equal(asked.state, "ready");
    assert.match(((asked.payload as Record<string, unknown>).text as string), /objected to the price/);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index attach mirrors an existing remote index by name", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-attach-"));
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = BASE;
    const c = openCase(cdir); c.ensure();
    const [attached] = await indexVerb.run({ input: "attach", rest: ["fixture"], opts: {}, case: c, profile: defaultProfile() });
    assert.equal(attached.state, "ready");
    const p = attached.payload as Record<string, unknown>;
    assert.equal(p.index, "col_fake123");
    assert.equal(p.name, "fixture");
    assert.equal(p.type, "media-descriptions");
    assert.equal(p.member_count, 2);
    assert.equal(findIndex(c, "fixture")?.id, "col_fake123");
    assert.equal(listIndexes(c)[0].members.length, 2);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index attach syncs mirrored members instead of keeping stale refs", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-attach-sync-"));
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = BASE;
    const c = openCase(cdir); c.ensure();
    const [attached] = await indexVerb.run({ input: "attach", rest: ["fixture"], opts: {}, case: c, profile: defaultProfile() });
    assert.equal(attached.state, "ready");
    assert.equal(setMembers(c, "col_fake123", [
      { ref: "file_abc", fileId: "file_abc" },
      { ref: "stale.mp4", fileId: "file_stale" },
    ]), true);
    assert.deepEqual(listIndexes(c)[0].members.map((m) => m.ref), ["file_abc", "stale.mp4"]);

    const [synced] = await indexVerb.run({ input: "attach", rest: ["fixture"], opts: {}, case: c, profile: defaultProfile() });
    assert.equal(synced.state, "ready");
    assert.deepEqual(listIndexes(c)[0].members.map((m) => m.ref), ["file_abc", "file_def"]);
    assert.equal((synced.payload as Record<string, unknown>).member_count, 2);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = saved;
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index list --remote exposes indexes, not collections, at the public layer", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-remote-list-"));
  const saved = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = BASE;
    const c = openCase(cdir); c.ensure();
    const [remote] = await indexVerb.run({ input: "list", rest: [], opts: { remote: true }, case: c, profile: defaultProfile() });
    const p = remote.payload as Record<string, unknown>;
    assert.ok(Array.isArray(p.indexes));
    assert.equal("collections" in p, false);
    assert.match(String(p.summary), /index(?:es)? in this account/);
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

test("index entities rejects a misused --to/--from", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entflag-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_e", type: "entities", name: "e" });
    const [rec] = await indexVerb.run({ input: "entities", rest: ["col_e", vid], opts: { to: "col_e" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /don't apply/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index add --type matches a sole unknown stub (resolveTarget keeps unknown)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stub-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_u", type: "unknown", name: "col_u" });
    const [rec] = await indexVerb.run({ input: "add", rest: [vid], opts: { type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(rec.state, "error"); // the sole unknown stub is upgraded + used, not "no indexes"
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index add --all rejects a stray positional video", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allpos-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_a", type: "media-descriptions", name: "a" });
    const [rec] = await indexVerb.run({ input: "add", rest: [vid], opts: { all: true, to: "col_a" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /--all registers every/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index add --all surfaces failed senses instead of 'no videos'", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allfail-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_f", type: "media-descriptions", name: "f" });
    c.writeRecord(makeRecord({ verb: "watch", payload: {}, media: { ref: "/tmp/x.mp4" }, state: "error" }));
    const [rec] = await indexVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_f" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /failed to sense/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index add --all pending count ignores a face-search record (shared predicate)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allsearch-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_s", type: "media-descriptions", name: "s" });
    // a pending face SEARCH record (media = query image) must NOT be counted as a pending video
    c.writeRecord(makeRecord({ verb: "face", payload: { op: "search" }, media: { ref: "/tmp/q.jpg" }, state: "pending" }));
    const [rec] = await indexVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_s" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /no new captured\/sensed videos/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index entities rejects a blank --offset= (shared numeric validator; was empty→0)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entoff-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_o", type: "entities", name: "o" });
    const [rec] = await indexVerb.run({ input: "entities", rest: ["col_o", vid], opts: { offset: "" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error"); assert.match(rec.error ?? "", /invalid --offset/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Code-review (max) findings --------------------------------------------

test("media-ref isAv accepts the broader set watch/listen take (.ts transport stream) — code-review [0]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-avfmt-"));
  const ts = join(cdir, "stream.ts"); writeFileSync(ts, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_a", type: "media-descriptions", name: "a" });
    const [rec] = await indexVerb.run({ input: "add", rest: [ts], opts: { to: "col_a" }, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(rec.state, "error"); // a .ts clip is no longer rejected as "not a video"
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index declares a 3rd positional so `entities <id> <video>` is reachable from the agent surface — code-review [3]", () => {
  assert.equal(indexVerb.args.length, 3);
  assert.equal(indexVerb.args[2].name, "arg2");
});

test("bare `index delete` (no id) errors instead of deleting the sole index — code-review [9]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-baredel-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [rec] = await indexVerb.run({ input: "delete", rest: [], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /explicit id/);
    assert.equal(listIndexes(openCase(cdir)).length, 1); // the sole index survives
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index add --to a typed index with a conflicting --type errors — code-review [4]", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-typeconf-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_md", type: "media-descriptions", name: "md" });
    const [rec] = await indexVerb.run({ input: "add", rest: [vid], opts: { to: "col_md", type: "face" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /conflicts with index/);
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

test("index mirror load() tolerates a valid-JSON-but-wrong-shape file — code-review [12]", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-badshape-"));
  try {
    const c = openCase(cdir); c.ensure();
    writeFileSync(c.indexesFile, JSON.stringify({ indexes: null }));
    assert.deepEqual(listIndexes(openCase(cdir)), []); // no throw
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("tinycloudBaseFromRun keeps leading global flags before the subcommand — code-review [1/5/8]", () => {
  assert.equal(tinycloudBaseFromRun("tinycloud --config /etc/tc.toml face detect {{input}}"), "tinycloud --config /etc/tc.toml");
  assert.equal(tinycloudBaseFromRun("/opt/tc/tinycloud face detect {{input}}"), "/opt/tc/tinycloud");
});

test("tinycloudBaseFromRun is quote-aware: a spaced binary/path stays one token (round-trips)", () => {
  const base = tinycloudBaseFromRun("'/My Tools/tinycloud' --config '/etc/my dir/tc.toml' face detect {{input}}");
  assert.equal(base, "'/My Tools/tinycloud' --config '/etc/my dir/tc.toml'");
  // re-tokenizing (as tinycloudBase does downstream) yields the right tokens, not a split path
  assert.deepEqual(tinycloudBase(base), ["/My Tools/tinycloud", "--config", "/etc/my dir/tc.toml"]);
});

test("face rejects an op-specific flag set for the wrong op (silently dropped otherwise)", async () => {
  // --min-similarity is match/search only — on a plain detect it would be ignored
  const [a] = await faceVerb.run(ctx(clip, { "min-similarity": 90 }));
  assert.equal(a.state, "error");
  assert.match(a.error ?? "", /--min-similarity doesn't apply to face detect/);
  // --limit is detect/list/search — never forwarded for match (match uses --max-faces)
  const [b] = await faceVerb.run(ctx(clip, { match: face, limit: 5 }));
  assert.equal(b.state, "error");
  assert.match(b.error ?? "", /--limit doesn't apply to face match/);
  // sanity: the flag on its correct op is fine (detect + --limit)
  const [ok] = await faceVerb.run(ctx(clip, { limit: 5 }));
  assert.notEqual(ok.state, "error");
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

test("single index add dedupes an already-registered video (no re-submit)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-dedupe-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_d", type: "media-descriptions", name: "d" });
    addMember(c, "col_d", { ref: vid });
    const [rec] = await indexVerb.run({ input: "add", rest: [vid], opts: { to: "col_d" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).already_member, true);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-16 regressions -------------------------------------------

test("index remove applies media filters but allows a gone file / errored record (#R16-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-rmfilt-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_r", type: "media-descriptions", name: "r" });
    addMember(c, "col_r", { ref: "/tmp/gone.mp4" });
    const scan = makeRecord({ verb: "scan", payload: { url: "https://x/p" }, media: { ref: "https://x/p" }, state: "ready" });
    c.writeRecord(scan);
    const [bad] = await indexVerb.run({ input: "remove", rest: [scan.id], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.match(bad.error ?? "", /is a scan record/); // a scan record is rejected
    // a gone local file is still removable (no existsSync gate on remove)
    const [ok] = await indexVerb.run({ input: "remove", rest: ["/tmp/gone.mp4"], opts: { from: "col_r" }, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(ok.state, "error");
    assert.equal(findIndex(openCase(cdir), "col_r")!.members.length, 0);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index add --all reports pending videos instead of 'no videos' (#R16-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-allpend-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_p", type: "media-descriptions", name: "p" });
    c.writeRecord(makeRecord({ verb: "watch", payload: {}, media: { ref: "/tmp/inflight.mp4" }, state: "pending" }));
    const [rec] = await indexVerb.run({ input: "add", rest: [], opts: { all: true, to: "col_p" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /still processing \(pending\)/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-15 regressions -------------------------------------------

test("index add/remove reject the inapplicable target flag (--from on add, --to on remove) (#R15-1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-wrongflag-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [a] = await indexVerb.run({ input: "add", rest: [vid], opts: { from: "col_only" }, case: openCase(cdir), profile: defaultProfile() });
    assert.match(a.error ?? "", /targets with --to/);
    const [r] = await indexVerb.run({ input: "remove", rest: [vid], opts: { to: "col_only" }, case: openCase(cdir), profile: defaultProfile() });
    assert.match(r.error ?? "", /targets with --from/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("index entities applies add's media filters (rejects a scan record) (#R15-2)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-entfilt-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_e", type: "entities", name: "e" });
    const scan = makeRecord({ verb: "scan", payload: { url: "https://x/post" }, media: { ref: "https://x/post" }, state: "ready" });
    c.writeRecord(scan);
    const [rec] = await indexVerb.run({ input: "entities", rest: ["col_e", scan.id], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /is a scan record/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-14 regressions -------------------------------------------

test("index create rejects a whitespace-only name and a whitespace-only entities --prompt (#R14-1/#R14-2)", async () => {
  const [n] = await indexVerb.run(ctx("create", { type: "media" }, ["   "]));
  assert.equal(n.state, "error");
  assert.match(n.error ?? "", /usage: index create/);
  const [p] = await indexVerb.run(ctx("create", { type: "entities", prompt: "   " }, ["people"]));
  assert.equal(p.state, "error");
  assert.match(p.error ?? "", /--prompt|--schema/);
});

test("index delete rejects a misused --to (no silent sole-index delete) (#R14-3)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-stray-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [d] = await indexVerb.run({ input: "delete", rest: [], opts: { to: "col_only" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(d.state, "error");
    assert.match(d.error ?? "", /positional id/);
    assert.equal(listIndexes(openCase(cdir)).length, 1); // the sole index was NOT deleted
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

test("face --match record rejects an http video/page media.ref (#R14-4)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-httpimg-"));
  try {
    const c = openCase(cdir); c.ensure();
    const w = makeRecord({ verb: "watch", payload: {}, media: { ref: "https://example.com/clip.mp4" }, state: "ready" });
    c.writeRecord(w);
    const [rec] = await faceVerb.run({ input: undefined, rest: [], opts: { match: w.id, index: "col_x" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /JPEG or PNG/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-13 regression --------------------------------------------

test("empty-string --match / --type are rejected, not treated as omitted (#R13)", async () => {
  // face --match= must NOT silently run detect
  const [f] = await faceVerb.run(ctx(clip, { match: "" }));
  assert.equal(f.state, "error");
  assert.match(f.error ?? "", /--match requires/);
  // index create --type= must NOT silently default to media-descriptions
  const [cr] = await indexVerb.run(ctx("create", { type: "" }, ["c"]));
  assert.equal(cr.state, "error");
  assert.match(cr.error ?? "", /unknown --type/);
  // index add --type= must NOT silently drop the type
  const [ad] = await indexVerb.run(ctx("add", { type: "", to: "col_x" }, ["vid"]));
  assert.equal(ad.state, "error");
  assert.match(ad.error ?? "", /unknown --type/);
});

// ---- Bugbot round-12 regression --------------------------------------------

test("empty-string index flags (--index=, --to=) are rejected, not treated as omitted (#R12-1)", async () => {
  // ask --index= must NOT silently fall back to local memory
  const [a] = await askVerb.run(ctx("q?", { index: "" }));
  assert.equal(a.state, "error");
  assert.match(a.error ?? "", /--index requires/);
  // face --index= must NOT auto-pick / run unscoped
  const [f] = await faceVerb.run(ctx(clip, { index: "" }));
  assert.equal(f.state, "error");
  assert.match(f.error ?? "", /--index requires/);
  // index add <vid> --to= must NOT target the case's sole index
  const cdir = mkdtempSync(join(tmpdir(), "oc-emptyto-"));
  const vid = join(cdir, "v.mp4"); writeFileSync(vid, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_only", type: "media-descriptions", name: "only" });
    const [r] = await indexVerb.run({ input: "add", rest: [vid], opts: { to: "" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(r.state, "error");
    assert.match(r.error ?? "", /blank index id/);
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});

// ---- Bugbot round-11 regression --------------------------------------------

test("index target rejects a BLANK explicit id but allows an omitted one (#R11)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-blanktgt-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_only", type: "media-descriptions", name: "only" });
    // a PROVIDED-but-blank id is a user error — must not silently target the sole index
    const [blank] = await indexVerb.run({ input: "show", rest: ["   "], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(blank.state, "error");
    assert.match(blank.error ?? "", /blank index id/);
    // an OMITTED id still resolves the case's sole index (the convenience path)
    const [omitted] = await indexVerb.run({ input: "show", rest: [], opts: {}, case: openCase(cdir), profile: defaultProfile() });
    assert.notEqual(omitted.state, "error");
  } finally { rmSync(cdir, { recursive: true, force: true }); }
});
