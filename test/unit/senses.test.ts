import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runListen } from "../../src/providers/tinycloud/listen.ts";
import { seeVerb, enhanceVerb, viewVerb } from "../../src/verbs/senses.ts";
import { cropVerb } from "../../src/verbs/crop.ts";
import { FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_LISTEN = join(HERE, "..", "fixtures", "fake-listen.sh");
const FAKE_LISTEN_NT = join(HERE, "..", "fixtures", "fake-listen-notiming.sh");

let dir: string;
let clip: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-sense-"));
  clip = join(dir, "tiny.mp4");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "testsrc=size=128x96:rate=10:duration=1", "-pix_fmt", "yuv420p", clip],
    { stdio: "ignore" },
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

function ctx(input: string, opts: VerbContext["opts"] = {}): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest: [], opts, case: c, profile: defaultProfile() };
}

test("runListen maps a speech envelope to audio.analysis (via fixture provider)", async () => {
  chmodSync(FAKE_LISTEN, 0o755);
  const rec = await runListen("call.m4a", { run: `bash ${FAKE_LISTEN} {{input}}` });
  assert.equal(rec.verb, "listen");
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.language, "en");
  assert.match(p.transcript as string, /Hello, are you there\?/);
  assert.match(p.transcript as string, /A:/); // speaker-tagged
  const segs = p.segments as Array<Record<string, unknown>>;
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0].at, [0, 3]);
});

test("see is a placeholder (needs_credentials) when no HF token + no binding", async () => {
  const saved = { a: process.env.HF_TOKEN, b: process.env.HUGGING_FACE_HUB_TOKEN };
  delete process.env.HF_TOKEN;
  delete process.env.HUGGING_FACE_HUB_TOKEN;
  try {
    const [rec] = await seeVerb.run(ctx("./suspect.jpg"));
    assert.equal(rec.verb, "see");
    assert.equal(rec.state, "needs_credentials");
    assert.match((rec.payload as Record<string, unknown>).guidance as string, /setup provider see/);
  } finally {
    if (saved.a) process.env.HF_TOKEN = saved.a;
    if (saved.b) process.env.HUGGING_FACE_HUB_TOKEN = saved.b;
  }
});

test("see/enhance route to a bound provider (pass-through), e.g. a HF-style VLM", async () => {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const seeScript = join(dir, "see-prov.sh");
  writeFileSync(seeScript, '#!/usr/bin/env bash\necho "{\\"verb\\":\\"see\\",\\"payload\\":{\\"caption\\":\\"a green square\\"},\\"meta\\":{\\"provider\\":\\"hf:blip\\"},\\"state\\":\\"ready\\"}"\n');
  chmodSync(seeScript, 0o755);
  const c = openCase(dir); c.ensure();
  const p = defaultProfile();
  p.providers = { ...p.providers, see: { type: "exec", run: `bash ${seeScript} {{input}}` } };
  const sctx: VerbContext = { input: clip, rest: [], opts: {}, case: c, profile: p };
  const [srec] = await seeVerb.run(sctx);
  assert.equal(srec.state, "ready");
  assert.equal((srec.payload as Record<string, unknown>).caption, "a green square");
  assert.equal(srec.meta?.provider, "hf:blip");

  // enhance routes to its bound provider instead of ffmpeg
  const enhScript = join(dir, "enh-prov.sh");
  writeFileSync(enhScript, `#!/usr/bin/env bash\necho "{\\"verb\\":\\"enhance\\",\\"payload\\":{\\"output\\":\\"/tmp/x.png\\"},\\"media\\":{\\"ref\\":\\"/tmp/x.png\\"},\\"meta\\":{\\"provider\\":\\"hf:upscale\\"},\\"state\\":\\"ready\\"}"\n`);
  chmodSync(enhScript, 0o755);
  p.providers.enhance = { type: "exec", run: `bash ${enhScript} {{input}}` };
  const [erec] = await enhanceVerb.run({ input: clip, rest: [], opts: {}, case: c, profile: p });
  assert.equal(erec.state, "ready");
  assert.equal(erec.meta?.provider, "hf:upscale");
});

test("enhance produces media.enhanced with the output as media.ref", async () => {
  const [rec] = await enhanceVerb.run(ctx(clip, { ops: "grayscale" }));
  assert.equal(rec.verb, "enhance");
  assert.equal(rec.state, "ready");
  assert.equal((rec.payload as Record<string, unknown>).modality, "video");
  assert.ok(existsSync(rec.media!.ref));
});

test("enhance errors cleanly on a missing input", async () => {
  const [rec] = await enhanceVerb.run(ctx(join(dir, "nope.mp4")));
  assert.equal(rec.state, "error");
});

test("view --no-open writes an HTML player and emits a view record", async () => {
  const [rec] = await viewVerb.run(ctx(clip, { "no-open": true }));
  assert.equal(rec.verb, "view");
  assert.equal(rec.state, "ready");
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.mode, "video");
  assert.equal(p.opened, false);
  assert.ok(existsSync(p.viewer as string));
});

test("crop materializes a face detection as a local evidence record", async () => {
  const c = openCase(dir);
  c.ensure();
  const face = makeRecord({
    verb: "face",
    payload: {
      op: "detect",
      summary: "one face",
      faces: [{ face_id: "f_1", at: 0.2, box: { left: 0.25, top: 0.25, width: 0.5, height: 0.5 } }],
    },
    media: { ref: clip, at: 0.2 },
  });
  c.writeRecord(face);
  const [rec] = await cropVerb.run({ input: face.id, rest: [], opts: { all: true, square: true }, case: c, profile: defaultProfile() });
  assert.equal(rec.verb, "crop");
  assert.equal(rec.state, "ready");
  assert.ok(existsSync(rec.media!.ref));
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.source_record, face.id);
  assert.equal(p.detection_id, "f_1");
  assert.equal(p.class, "face");
});

test("crop prefers a face thumbnail frame over seeking the source video", async () => {
  const c = openCase(dir);
  c.ensure();
  const thumb = join(dir, "face-frame.jpg");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "testsrc=size=200x120:rate=1:duration=1", "-frames:v", "1", thumb],
    { stdio: "ignore" },
  );
  const face = makeRecord({
    verb: "face",
    payload: {
      op: "detect",
      summary: "one face with provider frame",
      faces: [{
        face_id: "f_thumb",
        frame_id: "frame_4",
        at: 4,
        box: { left: 0.2, top: 0.1, width: 0.4, height: 0.5 },
        thumbnail: thumb,
      }],
    },
    media: { ref: clip, at: 4 },
  });
  c.writeRecord(face);
  const [rec] = await cropVerb.run({ input: face.id, rest: [], opts: { all: true }, case: c, profile: defaultProfile() });
  assert.equal(rec.state, "ready");
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.source_media, clip);
  assert.equal(p.crop_source_media, thumb);
  assert.equal(p.thumbnail, thumb);
  assert.equal(p.frame_id, "frame_4");
  assert.ok(existsSync(rec.media!.ref));
});

test("view escapes a media path with quotes/specials (no HTML/attr breakage)", async () => {
  // a clip whose name contains a double-quote and angle brackets
  const nasty = join(dir, 'a"<b> .mp4');
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-pix_fmt", "yuv420p", nasty],
    { stdio: "ignore" },
  );
  const [rec] = await viewVerb.run(ctx(nasty, { "no-open": true }));
  const html = readFileSync((rec.payload as Record<string, unknown>).viewer as string, "utf8");
  // the src attribute must be a single well-formed value with no raw inner quote
  const srcMatch = html.match(/src="([^"]*)"/);
  assert.ok(srcMatch, "video src attribute present and quote-balanced");
  assert.match(srcMatch![1], /%22%3Cb%3E/); // quote + <b> are percent-encoded in the URL
  // body text must not contain raw angle brackets from the filename
  assert.ok(!html.includes("<b>"), "raw <b> leaked into HTML body");
  assert.match(html, /&lt;b&gt;/); // escaped in the visible note/title
});

test("listen omits the at anchor when segment timing is missing (no [null,null])", async () => {
  chmodSync(FAKE_LISTEN_NT, 0o755);
  const rec = await runListen("x.m4a", { run: `bash ${FAKE_LISTEN_NT} {{input}}` });
  const segs = (rec.payload as Record<string, unknown>).segments as Array<Record<string, unknown>>;
  assert.equal(segs.length, 1);
  assert.equal("at" in segs[0], false); // no malformed [null,null]
  assert.match(segs[0].text as string, /no timing/);
});

test("listen --describe surfaces an audio-scene description (full describe mode)", async () => {
  const { runListen } = await import("../../src/providers/tinycloud/listen.ts");
  const fake = join(__dirname_compat(), "..", "fixtures", "fake-listen.sh");
  const rec = await runListen("clip.m4a", { run: `bash ${fake} {{input}}`, describe: true });
  const p = rec.payload as Record<string, unknown>;
  assert.ok("description" in p, "describe mode adds a description field");
  assert.match(p.description as string, /meeting/);
  assert.equal(rec.meta?.mode, "describe");
});
function __dirname_compat() { return dirname(fileURLToPath(import.meta.url)); }

test("listen preserves object-shaped tinycloud error envelope messages", async () => {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const prov = join(dir, "listen-error-object.sh");
  writeFileSync(
    prov,
    '#!/usr/bin/env bash\nprintf \'{"status":"error","data":null,"error":{"code":"upstream","message":"enable_visual_scene_description is not available for audio files"}}\\n\'\n',
  );
  chmodSync(prov, 0o755);
  const rec = await runListen("clip.m4a", { run: `bash ${prov} {{input}}`, describe: true });
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /upstream: enable_visual_scene_description is not available for audio files/);
});

test("listen audio-only describe fallback does not mask a failed speech retry", async () => {
  const { writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const bin = join(dir, "fake-tinycloud-bin");
  mkdirSync(bin, { recursive: true });
  const tinycloud = join(bin, "tinycloud");
  writeFileSync(
    tinycloud,
    `#!/usr/bin/env bash
if printf '%s\\n' "$@" | grep -q -- --speech-only; then
  printf '{"status":"needs_credentials","error":{"code":"no_key","message":"set CLOUDGLUE_API_KEY"}}\\n'
  exit 13
fi
printf '{"status":"error","data":null,"error":{"code":"upstream","message":"enable_visual_scene_description is not available for audio files"}}\\n'
`,
  );
  chmodSync(tinycloud, 0o755);
  const rec = await runListen("clip.m4a", {
    describe: true,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  assert.equal(rec.state, "needs_credentials");
  assert.match(rec.error ?? "", /set CLOUDGLUE_API_KEY/);
  assert.notEqual(rec.meta?.mode, "speech_fallback");
  assert.equal("warning" in (rec.payload as Record<string, unknown>), false);
});

test("see forwards --ocr/--prompt to the bound provider (extraArgs)", async () => {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const prov = join(dir, "see-args.sh");
  // echo back whether --ocr was received
  writeFileSync(prov, '#!/usr/bin/env bash\nargs="$*"\nif echo "$args" | grep -q -- --ocr; then ocr="read it"; else ocr=""; fi\necho "{\\"verb\\":\\"see\\",\\"payload\\":{\\"caption\\":\\"\\",\\"ocr\\":\\"$ocr\\"},\\"state\\":\\"ready\\"}"\n');
  chmodSync(prov, 0o755);
  const c = openCase(dir); c.ensure();
  const p = defaultProfile();
  p.providers = { ...p.providers, see: { type: "exec", run: `bash ${prov} {{input}}` } };
  const [rec] = await seeVerb.run({ input: clip, rest: [], opts: { ocr: true }, case: c, profile: p });
  assert.equal((rec.payload as Record<string, unknown>).ocr, "read it");
});
