import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runListen } from "../../src/providers/tinycloud/listen.ts";
import { seeVerb, enhanceVerb, viewVerb } from "../../src/verbs/senses.ts";
import { FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
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

test("see is a placeholder reporting needs_credentials with guidance", async () => {
  const [rec] = await seeVerb.run(ctx("./suspect.jpg"));
  assert.equal(rec.verb, "see");
  assert.equal(rec.state, "needs_credentials");
  assert.match((rec.payload as Record<string, unknown>).guidance as string, /setup provider see/);
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
