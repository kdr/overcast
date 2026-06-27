import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase, recordFiles } from "../../src/case.ts";
import { makeRecord } from "../../src/record.ts";

function withTmp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "oc-case-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ensure() creates .overcast store + case.json with stable id", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    assert.equal(c.exists(), false);
    const info = c.ensure();
    assert.match(info.id, /^case_/);
    assert.equal(info.name, c.dir.split("/").pop());
    assert.ok(existsSync(c.caseFile));
    assert.ok(existsSync(c.recordsDir));
    // idempotent: second ensure returns same id
    assert.equal(openCase(dir).ensure().id, info.id);
  });
});

test("writeRecord persists per-verb JSONL and records() reads them back", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    c.ensure();
    const r = makeRecord({ verb: "watch", payload: { content: "hi" }, media: { ref: "x.mp4" } });
    const file = c.writeRecord(r);
    assert.ok(file.endsWith("watch.jsonl"));
    assert.deepEqual(recordFiles(c), ["watch.jsonl"]);

    const all = c.records();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, r.id);
    assert.equal(c.recordById(r.id)?.payload && (c.recordById(r.id)!.payload as Record<string, unknown>).content, "hi");
  });
});

test("clearSummary reports resettable records, media, index, and state files", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "hi" }, media: { ref: "x.mp4" } }));
    mkdirSync(c.indexDir, { recursive: true });
    writeFileSync(join(c.mediaDir, "clip.txt"), "media");
    writeFileSync(join(c.indexDir, "idx.txt"), "index");
    writeFileSync(c.sourcesFile, JSON.stringify({ sources: [] }));

    const summary = c.clearSummary();
    assert.equal(summary.records, 1);
    assert.deepEqual(summary.counts, { watch: 1 });
    assert.equal(summary.media.files, 1);
    assert.equal(summary.media.bytes, 5);
    assert.equal(summary.index.files, 1);
    assert.deepEqual(summary.stateFiles, ["sources.json"]);
    assert.equal(c.records().length, 1, "summary does not mutate the case");
  });
});

test("clear removes records/media/index/state while preserving case.json", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    const info = c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "hi" }, media: { ref: "x.mp4" } }));
    mkdirSync(c.indexDir, { recursive: true });
    writeFileSync(join(c.mediaDir, "clip.txt"), "media");
    writeFileSync(join(c.indexDir, "idx.txt"), "index");
    writeFileSync(c.targetFile, JSON.stringify({ targets: [] }));

    const before = c.clear();
    assert.equal(before.records, 1);
    assert.ok(existsSync(c.caseFile));
    assert.equal(openCase(dir).info().id, info.id);
    assert.equal(c.records().length, 0);
    assert.equal(existsSync(join(c.mediaDir, "clip.txt")), false);
    assert.equal(existsSync(c.indexDir), false);
    assert.equal(existsSync(c.targetFile), false);
  });
});
