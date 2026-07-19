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

test("runWatch maps a ≥0.3.12 envelope's inline segments[].speech into transcript (deduped)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-watchspeech-"));
  try {
    // shaped like a real 0.3.12 capture: verbatim cues ride speech[] per
    // segment, and a cue touching the segment boundary appears in BOTH
    // neighboring segments — the transcript must carry it once.
    const json = JSON.stringify({
      status: "ready",
      data: {
        title: "Podcast clip",
        summary: "Two men talk in a studio.",
        duration_seconds: 30,
        segments: [
          { index: 1, start_time: 0, end_time: 20, description: "Podcast Interview", summary: "Scene prose.", speech: ["Are there a lot of birth fears?"] },
          { index: 2, start_time: 20, end_time: 30, description: "Podcast Discussion", summary: "More scene prose.", speech: ["Are there a lot of birth fears?", "Can I ask you something?"] },
        ],
      },
    });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    const transcript = String(p.transcript);
    assert.ok(transcript.length > 0, "transcript populated from the watch envelope alone");
    assert.match(transcript, /\[0\] Are there a lot of birth fears\?/);
    assert.match(transcript, /\[20\] Can I ask you something\?/);
    // the boundary-duplicated cue appears exactly once
    assert.equal(transcript.match(/birth fears/g)?.length, 1);
    // scene prose never leaks into the transcript
    assert.ok(!transcript.includes("Scene prose"), "segment summary leaked into transcript");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch boundary dedupe is per-adjacent-segment: repeats after a gap survive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-watchgap-"));
  try {
    // mirrors the listen-side case: a speechless segment clears the dedupe
    // state, so a genuinely repeated utterance later in the video is kept.
    const json = JSON.stringify({
      status: "ready",
      data: {
        title: "clip",
        summary: "sum",
        segments: [
          { index: 1, start_time: 0, end_time: 10, speech: ["Yeah."] },
          { index: 2, start_time: 10, end_time: 20, speech: [] },
          { index: 3, start_time: 20, end_time: 30, speech: ["Yeah."] },
        ],
      },
    });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    assert.equal(String((rec.payload as Record<string, unknown>).transcript), "[0] Yeah.\n[20] Yeah.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("runWatch strips cue tags inside a <v> voice cue, at any nesting", async () => {
  // tinycloud VTTs lean on `<v Name>`, and that branch used to return the body
  // verbatim — so nested <b>/<i>/timestamp tags rode straight into the
  // transcript. Interleaved brackets need the depth-aware strip too: a single
  // regex pass over `<<b>b>` matches `<` to the FIRST `>` and leaves `b>`.
  const dir = mkdtempSync(join(tmpdir(), "oc-watchvoice-"));
  try {
    const vtt = join(dir, "speech.vtt");
    writeFileSync(vtt, `WEBVTT

1
00:00:00.000 --> 00:00:01.000
<v Ada Lovelace><b>bold</b> and <i>italic</i></v>

2
00:00:01.000 --> 00:00:02.000
<v Alan Turing><00:00:01.500>timed <<b>b>nested</v>
`);
    const json = JSON.stringify({ status: "ready", data: { title: "clip", summary: "s", transcript: "", describe: { vtt_path: vtt }, segments: [] } });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    const transcript = String((rec.payload as Record<string, unknown>).transcript);

    assert.match(transcript, /Ada Lovelace: bold and italic/);
    assert.match(transcript, /Alan Turing: timed nested/);
    // no markup of any kind survives — neither whole tags nor bracket residue
    assert.doesNotMatch(transcript, /[<>]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch cue stripping stays linear on deeply nested provider text", async () => {
  // the fixed-point loop this replaced peeled ONE nesting layer per pass, so a
  // crafted sidecar cost O(n^2) and could stall the mapper. 200k nested opens is
  // ~seconds-to-minutes quadratic; linear it is instant.
  const dir = mkdtempSync(join(tmpdir(), "oc-watchdeep-"));
  try {
    const vtt = join(dir, "speech.vtt");
    // text OUTSIDE the nested wrapper must survive; text inside it is markup
    const nested = "keep" + "<".repeat(200_000) + "inner" + ">".repeat(200_000) + "tail";
    writeFileSync(vtt, `WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n${nested}\n`);
    const json = JSON.stringify({ status: "ready", data: { title: "clip", summary: "s", transcript: "", describe: { vtt_path: vtt }, segments: [] } });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);

    const started = Date.now();
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    const elapsed = Date.now() - started;

    const transcript = String((rec.payload as Record<string, unknown>).transcript);
    assert.equal(transcript, "keeptail", "nested wrapper stripped, surrounding text kept");
    assert.ok(elapsed < 10_000, `cue strip should be linear, took ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch: a `>` with no open tag is spoken text, not markup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-watchgt-"));
  try {
    const vtt = join(dir, "speech.vtt");
    writeFileSync(vtt, `WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nif 2 > 1 then <b>ship</b> it\n`);
    const json = JSON.stringify({ status: "ready", data: { title: "clip", summary: "s", transcript: "", describe: { vtt_path: vtt }, segments: [] } });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    assert.equal(String((rec.payload as Record<string, unknown>).transcript), "if 2 > 1 then ship it");
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
