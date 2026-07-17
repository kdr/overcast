// Pure-logic tests for lib/jobs.ts (no vscode import — plain node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, jobLabel, jobVerbTarget, shouldTrackJob } from "../src/lib/jobs.ts";

test("shouldTrackJob: skips the noisy poll reads + version, tracks the rest", () => {
  assert.equal(shouldTrackJob(["case", "status"]), false);
  assert.equal(shouldTrackJob(["case", "records", "--limit", "500"]), false);
  assert.equal(shouldTrackJob(["finding", "list", "--state", "all"]), false);
  assert.equal(shouldTrackJob(["--version"]), false);
  assert.equal(shouldTrackJob(["commands"]), false);
  assert.equal(shouldTrackJob(["index", "list"]), false); // model poll read
  assert.equal(shouldTrackJob(["index"]), false); // bare index = list
  assert.equal(shouldTrackJob([]), false);
  assert.equal(shouldTrackJob(["watch", "/a/clip.mp4"]), true);
  assert.equal(shouldTrackJob(["scan", "youtube:@handle"]), true);
  assert.equal(shouldTrackJob(["index", "create", "faces", "--type", "face"]), true);
  assert.equal(shouldTrackJob(["note", "--text", "hi"]), true);
});

test("jobVerbTarget: basename of a path 2nd positional", () => {
  assert.deepEqual(jobVerbTarget(["watch", "/a/b/clip.mp4", "--json"]), {
    verb: "watch",
    target: "clip.mp4",
  });
  assert.deepEqual(jobVerbTarget(["see", "C:\\shots\\photo.png"]), {
    verb: "see",
    target: "photo.png",
  });
});

test("jobVerbTarget: non-path token used verbatim", () => {
  assert.deepEqual(jobVerbTarget(["scan", "youtube:@handle"]), {
    verb: "scan",
    target: "youtube:@handle",
  });
  assert.deepEqual(jobVerbTarget(["target", "add"]), { verb: "target", target: "add" });
});

test("jobVerbTarget: a flag 2nd token yields no target", () => {
  assert.deepEqual(jobVerbTarget(["note", "--text", "some note"]), { verb: "note" });
  assert.deepEqual(jobVerbTarget(["scan", "--local"]), { verb: "scan" });
});

test("jobVerbTarget: long target is ellipsized", () => {
  const t = jobVerbTarget(["scan", "web:a very long free text query with many words"]).target;
  assert.ok(t && t.length <= 28);
  assert.ok(t!.endsWith("…"));
});

test("formatDuration: seconds then minutes", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(1200), "1s");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(59_400), "59s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(83_000), "1m 23s");
  assert.equal(formatDuration(-5), "0s");
});

test("jobLabel: target appended when present", () => {
  assert.equal(jobLabel("watch", "clip.mp4"), "watch clip.mp4");
  assert.equal(jobLabel("scan"), "scan");
});
