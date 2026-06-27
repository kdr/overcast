import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runWatch } from "../../src/providers/tinycloud/watch.ts";
import { openCase } from "../../src/case.ts";
import { makeRecord } from "../../src/record.ts";
import { defaultProfile } from "../../src/profile.ts";
import { watchVerb } from "../../src/registry/verbs.ts";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "..", "fixtures", "fake-watch.sh");
const CASES = join(HERE, "..", "fixtures", "fake-watch-cases.sh");

test("runWatch maps a real tinycloud envelope to the loose record (via fixture provider)", async () => {
  chmodSync(FAKE, 0o755);
  // exercise the REAL mapping code against the REAL captured envelope, offline.
  const rec = await runWatch("browse-hackernews.mp4", {
    run: `bash ${FAKE} {{input}}`,
  });

  assert.equal(rec.verb, "watch");
  assert.equal(rec.format, "json");
  assert.equal(rec.state, "ready");
  assert.equal(rec.error, undefined);
  assert.equal(rec.media?.ref, "browse-hackernews.mp4");

  const payload = rec.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["content", "detailed", "transcript"]);

  // content is synthesized from title + summary + segment breakdown
  assert.match(payload.content as string, /Hacker News/);
  assert.match(payload.content as string, /## Segments/);

  // detailed carries the structured describe data
  const detailed = payload.detailed as Record<string, unknown>;
  assert.equal(detailed.title, "Exploring Hacker News Discussions on macOS Customization and AI Tools");
  assert.ok(Array.isArray(detailed.segments));

  // meta carries provider + extracted title/duration
  assert.equal(rec.meta?.provider, "tinycloud");
  assert.equal(rec.meta?.title, detailed.title);
});

test("runWatch fills transcript from tinycloud's speech.vtt sidecar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-watchvtt-"));
  try {
    const vtt = join(dir, "speech.vtt");
    writeFileSync(vtt, `WEBVTT

1
00:00:00.000 --> 00:00:01.000
<v Bobby Lee>That's cool.</v>

2
00:00:01.000 --> 00:00:02.000
<v Bobby Lee>That's amazing.</v>

3
00:00:02.000 --> 00:00:03.000
<v Theo Von>Are there birth fears?</v>
`);
    const json = JSON.stringify({ status: "ready", data: { title: "clip", summary: "summary", transcript: "", describe: { vtt_path: vtt }, segments: [] } });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    const p = rec.payload as Record<string, unknown>;
    assert.match(String(p.transcript), /Bobby Lee: That's cool\. That's amazing\./);
    assert.match(String(p.transcript), /Theo Von: Are there birth fears\?/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch resolves capture_id handles before dispatching to a provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-watchcap-"));
  const media = join(dir, "clip.mp4");
  try {
    writeFileSync(media, "x");
    const c = openCase(dir); c.ensure();
    c.writeRecord(makeRecord({ verb: "capture", payload: { capture_id: "cap_clip.mp4" }, media: { ref: media }, state: "ready" }));
    const script = join(dir, "provider.sh");
    writeFileSync(script, '#!/usr/bin/env bash\nprintf \'{"verb":"watch","payload":{"input":"%s"},"media":{"ref":"%s"},"state":"ready"}\\n\' "$1" "$1"\n');
    chmodSync(script, 0o755);
    const p = defaultProfile();
    p.providers = { ...p.providers, watch: { type: "exec", run: `bash ${script} {{input}}` } };
    const [rec] = await watchVerb.run({ input: "cap_clip.mp4", rest: [], opts: {}, case: c, profile: p });
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).input, media);
    assert.equal(rec.media?.ref, media);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch returns an error record when the provider emits no JSON", async () => {
  const rec = await runWatch("x.mp4", { run: `bash -c 'echo not-json' {{input}}` });
  assert.equal(rec.state, "error");
  assert.ok(rec.error);
});

test("runWatch surfaces a non-zero exit even when JSON is present (no silent success)", async () => {
  chmodSync(CASES, 0o755);
  const rec = await runWatch("x.mp4", { run: `bash ${CASES} exit7 {{input}}` });
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /exit 7/);
});

test("runWatch maps an error envelope (status:error) to an error record", async () => {
  chmodSync(CASES, 0o755);
  const rec = await runWatch("x.mp4", { run: `bash ${CASES} error {{input}}` });
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /quota exceeded/);
});

test("runWatch tags pending when the marker is nested under data", async () => {
  chmodSync(CASES, 0o755);
  const rec = await runWatch("x.mp4", { run: `bash ${CASES} pending {{input}}` });
  assert.equal(rec.state, "pending");
  assert.equal(rec.error, undefined);
});
