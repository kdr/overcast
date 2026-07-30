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

test("runWatch: an UNPAIRED bracket is spoken text, not markup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-watchgt-"));
  try {
    const vtt = join(dir, "speech.vtt");
    // a lone `<` must NOT swallow the rest of the cue — a plain depth counter
    // does exactly that, silently truncating real spoken content
    writeFileSync(vtt, `WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nif 2 > 1 and x < y then <b>ship</b> it\n`);
    const json = JSON.stringify({ status: "ready", data: { title: "clip", summary: "s", transcript: "", describe: { vtt_path: vtt }, segments: [] } });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    assert.equal(String((rec.payload as Record<string, unknown>).transcript), "if 2 > 1 and x < y then ship it");
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

test("runWatch passes --segment/--shot-*-seconds through to the default tinycloud argv", async () => {
  // `watch --segment shots` used to be silently dropped: the default path
  // hardcoded ["watch", input, "--json"], so every watch got uniform:20.
  const dir = mkdtempSync(join(tmpdir(), "oc-watchseg-"));
  const prior = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    // a fake tinycloud that echoes the argv it received back inside the envelope
    const script = join(dir, "tc.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '{"status":"ready","data":{"title":"argv","summary":"%s"}}\\n' "$*"\n`);
    chmodSync(script, 0o755);
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${script}`;

    const rec = await runWatch("clip.mp4", { segment: "shots", shotMinSeconds: 0.6, shotMaxSeconds: 30 });
    assert.equal(rec.state, "ready");
    const argv = String(((rec.payload as Record<string, unknown>).detailed as Record<string, unknown>).summary);
    assert.equal(argv, "watch clip.mp4 --segment shots --shot-min-seconds 0.6 --shot-max-seconds 30 --json");

    // unset flags leave the default argv untouched
    const plain = await runWatch("clip.mp4", {});
    const plainArgv = String(((plain.payload as Record<string, unknown>).detailed as Record<string, unknown>).summary);
    assert.equal(plainArgv, "watch clip.mp4 --json");
  } finally {
    if (prior === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch appends segmentation flags to a custom run template (wrapper contract)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-watchsegc-"));
  try {
    const script = join(dir, "tc.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '{"status":"ready","data":{"title":"argv","summary":"%s"}}\\n' "$*"\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("clip.mp4", { run: `bash ${script} {{input}}`, segment: "shots" });
    const argv = String(((rec.payload as Record<string, unknown>).detailed as Record<string, unknown>).summary);
    assert.equal(argv, "clip.mp4 --segment shots");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch surfaces describe.primary_segmentation as the authoritative meta.segmentation", async () => {
  // tinycloud ≤ 0.3.15's top-level `segmentation` doesn't track what ran (a real
  // shots run still echoes "uniform:20" there — the field that sent a live case
  // down a phantom "shots silently fell back" debugging spiral). The record must
  // lead with describe.primary_segmentation + the modality list instead.
  const dir = mkdtempSync(join(tmpdir(), "oc-watchprimseg-"));
  try {
    const json = JSON.stringify({
      status: "ready",
      data: {
        title: "talk",
        summary: "a talk",
        duration_seconds: 1298,
        segmentation: "uniform:20", // the misleading upstream echo
        segments: [{ index: 1, start_time: 0, end_time: 60, description: "d", summary: "s" }],
        describe: {
          profile: "default",
          primary_segmentation: "shots",
          primary_modalities: ["speech", "visual", "scene_text", "audio_description", "summary"],
        },
      },
    });
    const script = join(dir, "tc.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);

    // requested kind matches what ran → truthful meta, NO warning
    const rec = await runWatch("talk.mp4", { run: `bash ${script} {{input}}`, segment: "shots" });
    assert.equal(rec.state, "ready");
    assert.equal(rec.meta?.segmentation, "shots");
    assert.equal(rec.meta?.segmentation_requested, "shots");
    assert.deepEqual(rec.meta?.modalities, ["speech", "visual", "scene_text", "audio_description", "summary"]);
    assert.equal((rec.payload as Record<string, unknown>).warning, undefined);

    // requested kind DIFFERS from what ran → a leading warning names both sides
    const fell = await runWatch("talk.mp4", { run: `bash ${script} {{input}}`, segment: "chapters" });
    assert.equal(fell.state, "ready");
    assert.equal(fell.meta?.segmentation, "shots");
    assert.match((fell.payload as Record<string, unknown>).warning as string, /--segment chapters/);
    assert.match((fell.payload as Record<string, unknown>).warning as string, /ran shots/);

    // no --segment requested → meta still carries the truth, no requested echo
    const plain = await runWatch("talk.mp4", { run: `bash ${script} {{input}}` });
    assert.equal(plain.meta?.segmentation, "shots");
    assert.equal(plain.meta?.segmentation_requested, undefined);
    assert.equal((plain.payload as Record<string, unknown>).warning, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch stays quiet about segmentation when the provider doesn't report it", async () => {
  // an older tinycloud (or custom wrapper) with no describe.primary_segmentation:
  // no meta.segmentation, and no mismatch warning to false-positive on.
  const dir = mkdtempSync(join(tmpdir(), "oc-watchnoseg-"));
  try {
    const json = JSON.stringify({ status: "ready", data: { title: "t", summary: "s", segments: [] } });
    const script = join(dir, "tc.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("clip.mp4", { run: `bash ${script} {{input}}`, segment: "shots" });
    assert.equal(rec.state, "ready");
    assert.equal(rec.meta?.segmentation, undefined);
    assert.equal(rec.meta?.segmentation_requested, "shots");
    assert.equal((rec.payload as Record<string, unknown>).warning, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch survives an envelope past the 64 KiB pipe buffer (stdoutToFile)", async () => {
  // shot segmentation on long-form video pushes the envelope well past 64 KiB —
  // exactly where the tinycloud bun-flush truncation used to sever the JSON.
  const dir = mkdtempSync(join(tmpdir(), "oc-watchbig-"));
  try {
    const summary = "s".repeat(128 * 1024);
    writeFileSync(join(dir, "big.json"), JSON.stringify({ status: "ready", data: { title: "big", summary, segments: [] } }));
    const script = join(dir, "tc.sh");
    writeFileSync(script, `#!/usr/bin/env bash\ncat "${join(dir, "big.json")}"\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    assert.equal(rec.state, "ready");
    assert.ok(String((rec.payload as Record<string, unknown>).content).includes(summary), "full envelope parsed, not truncated at 65536");
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

test("runWatch surfaces an OBJECT error envelope ({code,message}), not an empty exit message", async () => {
  // a real Cloudglue job-timeout envelope: status error, data null, and the
  // detail under error.message — the string-only check used to drop it.
  const dir = mkdtempSync(join(tmpdir(), "oc-watchobjerr-"));
  try {
    const json = JSON.stringify({
      tinycloud: "1",
      kind: "watch",
      status: "error",
      data: null,
      error: { code: "upstream", message: "Describe job did not finish within 600s (still processing — retry).", retryable: true },
    });
    const script = join(dir, "watch.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' '${json}'\nexit 1\n`);
    chmodSync(script, 0o755);
    const rec = await runWatch("x.mp4", { run: `bash ${script} {{input}}` });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /Describe job did not finish within 600s/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch tags pending when the marker is nested under data", async () => {
  chmodSync(CASES, 0o755);
  const rec = await runWatch("x.mp4", { run: `bash ${CASES} pending {{input}}` });
  assert.equal(rec.state, "pending");
  assert.equal(rec.error, undefined);
});
