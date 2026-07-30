import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FFMPEG_PATH,
  probe,
  probeSafe,
  noAudioStreamWarning,
  extractFrame,
  enhance,
  defaultOps,
  modalityFromExt,
  parseFrameRef,
  parseTimecode,
  parseAtSpan,
  type ProbeResult,
} from "../../src/media/ffmpeg.ts";

let dir: string;
let clip: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-ff-"));
  clip = join(dir, "tiny.mp4");
  // a real 1s clip with both video + audio, via the system ffmpeg
  execFileSync(
    FFMPEG_PATH,
    [
      "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-shortest", "-pix_fmt", "yuv420p", clip,
    ],
    { stdio: "ignore" },
  );
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("modalityFromExt classifies by extension", () => {
  assert.equal(modalityFromExt("a.jpg"), "image");
  assert.equal(modalityFromExt("a.mp3"), "audio");
  assert.equal(modalityFromExt("a.mp4"), "video");
  assert.equal(modalityFromExt("a.pdf"), "other");
});

test("probe reads duration + streams + modality from a real clip", async () => {
  const p = await probe(clip);
  assert.equal(p.modality, "video");
  assert.equal(p.hasVideo, true);
  assert.equal(p.hasAudio, true);
  assert.equal(p.width, 160);
  assert.equal(p.height, 120);
  assert.ok((p.durationSeconds ?? 0) > 0.5);
});

test("extractFrame writes a real jpg at a timestamp", async () => {
  const out = await extractFrame(clip, 0, join(dir, "frames"));
  assert.ok(existsSync(out));
  assert.match(out, /\.jpg$/);
});

test("enhance runs deterministic ffmpeg ops and writes output", async () => {
  const r = await enhance(clip, ["grayscale"], join(dir, "enh"));
  assert.ok(existsSync(r.output));
  assert.deepEqual(r.ops, ["grayscale"]);
  assert.equal(r.modality, "video");
});

test("enhance creates the parent dir of a nested explicit --out path", async () => {
  const out = join(dir, "enh-nested", "deep", "gray.mp4");
  const r = await enhance(clip, ["grayscale"], join(dir, "enh"), out);
  assert.equal(r.output, out);
  assert.ok(existsSync(out), "output written into freshly-created nested dir");
});

test("enhance default output name distinguishes op sets but is idempotent per op set", async () => {
  const g = await enhance(clip, ["grayscale"], join(dir, "enh-ops"));
  const d = await enhance(clip, ["denoise"], join(dir, "enh-ops"));
  assert.notEqual(g.output, d.output); // different ops -> different file, no overwrite
  assert.ok(existsSync(g.output) && existsSync(d.output));
  const g2 = await enhance(clip, ["grayscale"], join(dir, "enh-ops"));
  assert.equal(g2.output, g.output); // same ops -> same (cached) name
});

test("defaultOps differ per modality", () => {
  assert.deepEqual(defaultOps("audio"), ["denoise", "normalize"]);
  assert.deepEqual(defaultOps("image"), ["denoise"]);
  assert.deepEqual(defaultOps("other"), []);
});

test("probe classifies a real image as image even with a non-image extension", async () => {
  // a genuine PNG saved as .dat must not be mistaken for video (review finding)
  const png = join(dir, "frame.dat");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "color=c=red:size=64x64:duration=1", "-frames:v", "1", "-f", "image2", png],
    { stdio: "ignore" },
  );
  const p = await probe(png);
  assert.equal(p.modality, "image");
});

test("enhance throws (no silent no-op) when no op applies to the modality", async () => {
  // an audio-only op on an image applies nothing → must error, not re-encode
  const png = join(dir, "img.png");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "color=c=blue:size=48x48:duration=1", "-frames:v", "1", png],
    { stdio: "ignore" },
  );
  await assert.rejects(() => enhance(png, ["normalize"], join(dir, "e2")), /apply to image/);
  // a video op DOES apply to the image → ok, and reports it under ops
  const r = await enhance(png, ["grayscale"], join(dir, "e3"));
  assert.deepEqual(r.ops, ["grayscale"]);
});

test("parseTimecode accepts seconds + 2–3 segment timecodes, rejects garbage", () => {
  assert.equal(parseTimecode("90"), 90);
  assert.equal(parseTimecode("42.5"), 42.5);
  assert.equal(parseTimecode("1:02"), 62);
  assert.equal(parseTimecode("1:02:03"), 3723);
  assert.equal(parseTimecode(""), undefined);
  assert.equal(parseTimecode("1:2:3:4"), undefined);
  assert.equal(parseTimecode(":30"), undefined);
  assert.equal(parseTimecode("a:b"), undefined);
  assert.equal(parseTimecode("-5"), undefined);
});

test("parseAtSpan parses points and spans, rejects end < start", () => {
  assert.deepEqual(parseAtSpan("80-95"), [80, 95]);
  assert.deepEqual(parseAtSpan("1:20-1:35"), [80, 95]);
  assert.equal(parseAtSpan("95-80"), undefined);
  assert.equal(parseAtSpan("90"), 90);
});

test("contactSheet nulls a cell whose frame ffmpeg drops (exit 0, no output) — no later-cell shift", async () => {
  // Some ffmpeg builds/containers exit 0 with NO frame written when a seek lands
  // at/past the last decodable frame. That gap truncates the image2 sequence in
  // the tile pass and shifts every LATER cell off its mapped timestamp while the
  // returned map still claims the original one — the grid then silently lies.
  // This machine's ffmpeg errors (non-zero) on such a seek, so we reproduce the
  // exit-0-no-output case deterministically with a wrapper that answers one
  // sentinel seek with exit 0 + no file and delegates everything else to the real
  // ffmpeg (FFMPEG_PATH is captured here before the override).
  const realFfmpeg = FFMPEG_PATH;
  const POISON = 123.456; // a seek this 1s clip has no frame for; the stub drops it
  const stub = join(dir, "ffmpeg-drop-stub.sh");
  writeFileSync(
    stub,
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "${POISON}" ]; then exit 0; fi\ndone\nexec "${realFfmpeg}" "$@"\n`,
    { mode: 0o755 },
  );

  const prev = process.env.OVERCAST_FFMPEG;
  process.env.OVERCAST_FFMPEG = stub;
  try {
    // fresh module instance so FFMPEG_PATH resolves to the stub (it's read at load)
    const { contactSheet } = await import("../../src/media/ffmpeg.ts?dropstub");
    const seconds = [0, 0.2, POISON, 0.6];
    const r = await contactSheet(clip, seconds, join(dir, "drop-sheet"));

    // resolves + still produces a montage (no throw, no half-built grid)
    assert.ok(existsSync(r.output), "montage still produced despite a dropped frame");
    // the dropped cell maps to null — never a shifted/wrong source timestamp
    assert.equal(r.cells[2].at, null, "the cell whose frame was dropped maps to null");
    // every OTHER cell keeps its EXACT original timestamp (no shift into the gap)
    assert.equal(r.cells[0].at, 0);
    assert.equal(r.cells[1].at, 0.2);
    assert.equal(r.cells[3].at, 0.6);
    // invariant: any cell that claims a timestamp maps to its OWN sample, in place
    for (const c of r.cells) {
      if (c.at != null) assert.equal(c.at, seconds[c.n - 1], `cell ${c.n} maps to its own sample`);
    }
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_FFMPEG;
    else process.env.OVERCAST_FFMPEG = prev;
  }
});

test("parseFrameRef parses frame://rec@sec and rejects others", () => {
  assert.deepEqual(parseFrameRef("frame://rec_8f2a@134"), { recordId: "rec_8f2a", second: 134 });
  assert.deepEqual(parseFrameRef("frame://rec_x@12.5"), { recordId: "rec_x", second: 12.5 });
  assert.equal(parseFrameRef("./x.jpg"), null);
  assert.equal(parseFrameRef("frame://rec_x"), null);
});

test("spectrogram renders a PNG from audio via showspectrumpic", async () => {
  const wav = join(dir, "tone.wav");
  execFileSync(FFMPEG_PATH, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav], { stdio: "ignore" });
  const { spectrogram } = await import("../../src/media/ffmpeg.ts");
  const out = await spectrogram(wav, join(dir, "spec"));
  assert.ok(existsSync(out));
  assert.match(out, /_spectrogram\.png$/);
});

// ---- field report §2.6/§2.7: silent-video detection ---------------------------

test("noAudioStreamWarning fires ONLY for a real video with no audio stream", () => {
  const base: ProbeResult = { hasVideo: true, hasAudio: false, streams: [], modality: "video" };
  assert.match(noAudioStreamWarning(base) ?? "", /no audio stream/);
  assert.match(noAudioStreamWarning(base) ?? "", /fabricated/, "names the fabricated-audio-description trap");
  assert.equal(noAudioStreamWarning({ ...base, hasAudio: true }), undefined, "audio present = no warning");
  assert.equal(noAudioStreamWarning({ ...base, modality: "image" }), undefined, "a still image never warns");
  assert.equal(noAudioStreamWarning({ ...base, hasVideo: false, modality: "audio" }), undefined, "audio-only media never warns");
  assert.equal(noAudioStreamWarning(undefined), undefined, "no probe (no ffprobe / URL) = no claim either way");
});

test("probeSafe never throws: garbage file and missing file both probe to undefined", async () => {
  const junk = join(dir, "junk.mp4");
  writeFileSync(junk, "not media");
  assert.equal(await probeSafe(junk), undefined);
  assert.equal(await probeSafe(join(dir, "nope.mp4")), undefined);
  assert.equal(await probeSafe("https://example.com/clip.mp4"), undefined, "non-local inputs are refused, safely");
});

test("a video-only clip probes hasAudio=false and trips the warning end-to-end", async () => {
  const silent = join(dir, "silent.mp4");
  execFileSync(FFMPEG_PATH, [
    "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
    "-pix_fmt", "yuv420p", silent,
  ], { stdio: "ignore" });
  const p = await probeSafe(silent);
  assert.ok(p);
  assert.equal(p!.hasVideo, true);
  assert.equal(p!.hasAudio, false);
  assert.match(noAudioStreamWarning(p) ?? "", /no audio stream/);
});
