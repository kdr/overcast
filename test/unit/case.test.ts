import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
