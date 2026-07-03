import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gridVerb } from "../../src/verbs/grid.ts";
import { contactSheet, probe, FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";

let dir: string;
let clip: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-grid-"));
  clip = join(dir, "clip.mp4");
  // a 12s 320x180 clip so cell aspect + windowing are exercised on real media
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=12", "-pix_fmt", "yuv420p", clip],
    { stdio: "ignore" },
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

function ctx(input: string, opts: VerbContext["opts"] = {}): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest: [], opts, case: c, profile: defaultProfile() };
}

test("contactSheet tiles a real clip into one montage with an exact cell map", async () => {
  const secs = [1, 4, 7, 10];
  const r = await contactSheet(clip, secs, join(dir, "sheets"), { cols: 2 });
  assert.ok(existsSync(r.output), "montage written");
  assert.equal(r.cols, 2);
  assert.equal(r.rows, 2); // 4 cells / 2 cols
  assert.deepEqual(r.cells, secs.map((at, i) => ({ n: i + 1, at })));
  // it's a real, non-empty image the tile filter actually produced
  const p = await probe(r.output);
  assert.ok((p.width ?? 0) > 0 && (p.height ?? 0) > 0, "montage has dimensions");
  assert.equal(typeof r.labeled, "boolean"); // labeled iff drawtext + font present
});

test("grid verb: window sampling emits a media.grid record with midpoint cells", async () => {
  const [rec] = await gridVerb.run(ctx(clip, { count: 6, cols: 3, json: true }));
  assert.equal(rec.verb, "grid");
  assert.equal(rec.state, "ready");
  const p = rec.payload as Record<string, any>;
  assert.equal(p.count, 6);
  assert.equal(p.grid, "3x2");
  assert.equal(p.cells.length, 6);
  // midpoint sampling never lands on the exact clip start (0) or a black tail
  assert.ok(p.cells[0].at > 0, "first sample is a midpoint, not 0");
  assert.ok(p.cells.every((c: any, i: number) => c.n === i + 1), "cells numbered 1..N");
  assert.ok(existsSync(p.montage), "montage on disk");
  assert.equal(rec.media?.ref, p.montage);
});

test("grid verb: explicit --at overrides window and is sorted + deduped", async () => {
  const [rec] = await gridVerb.run(ctx(clip, { at: "8,2,2,5", json: true }));
  assert.equal(rec.state, "ready");
  const p = rec.payload as Record<string, any>;
  assert.deepEqual(p.cells.map((c: any) => c.at), [2, 5, 8]);
  assert.equal(p.window, undefined); // --at path carries no window
});

test("grid verb: validation rejects out-of-range flags and bad --at", async () => {
  const [tooMany] = await gridVerb.run(ctx(clip, { count: 999, json: true }));
  assert.equal(tooMany.state, "error");
  assert.match(tooMany.error ?? "", /count/);

  const [badAt] = await gridVerb.run(ctx(clip, { at: "nope", json: true }));
  assert.equal(badAt.state, "error");
  assert.match(badAt.error ?? "", /--at/);

  const [emptyWin] = await gridVerb.run(ctx(clip, { start: "10", end: "5", json: true }));
  assert.equal(emptyWin.state, "error");
  assert.match(emptyWin.error ?? "", /window/);
});

test("grid verb: missing input errors cleanly", async () => {
  const [rec] = await gridVerb.run(ctx("", { json: true }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /requires a video/);
});

test("grid verb: >64 --at timestamps error instead of silently truncating", async () => {
  const many = Array.from({ length: 65 }, (_, i) => i + 1).join(",");
  const [rec] = await gridVerb.run(ctx(clip, { at: many, json: true }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /too many --at timestamps \(65\)/);
});

test("grid verb: an out-of-range --count is ignored when --at overrides it", async () => {
  const [rec] = await gridVerb.run(ctx(clip, { count: 999, at: "2,5,8", json: true }));
  assert.equal(rec.state, "ready"); // count is irrelevant with --at, so no validation error
  const p = rec.payload as Record<string, any>;
  assert.deepEqual(p.cells.map((c: any) => c.at), [2, 5, 8]);
});

test("grid verb: a fractional --count is rejected (skews window sampling)", async () => {
  const [rec] = await gridVerb.run(ctx(clip, { count: 16.9, json: true }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /whole number/);
});

test("grid verb: an audio-only input is rejected with a clear video-required error", async () => {
  const audio = join(dir, "tone.m4a");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", audio],
    { stdio: "ignore" },
  );
  const [rec] = await gridVerb.run(ctx(audio, { count: 4, json: true }));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /no video stream/);
});

test("grid verb: a nested --out path has its parent dir created", async () => {
  const out = join(dir, "nested", "deep", "sheet.png");
  const [rec] = await gridVerb.run(ctx(clip, { count: 4, out, json: true }));
  assert.equal(rec.state, "ready");
  assert.equal((rec.payload as Record<string, any>).montage, out);
  assert.ok(existsSync(out), "montage written into freshly-created nested dir");
});
