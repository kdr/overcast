import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FFMPEG_PATH,
  probe,
  extractFrame,
  enhance,
  defaultOps,
  modalityFromExt,
  parseFrameRef,
} from "../../src/media/ffmpeg.ts";

let dir: string;
let clip: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-ff-"));
  clip = join(dir, "tiny.mp4");
  // a real 1s clip with both video + audio, via the vendored ffmpeg
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
