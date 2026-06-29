import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeRecord,
  memoryRecords,
  validateRecord,
  isReady,
  newRecordId,
  appendRecordJSONL,
  readRecordsJSONL,
  readAllRecords,
} from "../../src/record.ts";

test("newRecordId is prefixed + unique", () => {
  const a = newRecordId();
  const b = newRecordId();
  assert.match(a, /^rec_[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test("makeRecord fills defaults: id, format from payload type", () => {
  const j = makeRecord({ verb: "watch", payload: { content: "x" } });
  assert.equal(j.format, "json");
  assert.match(j.id, /^rec_/);
  const t = makeRecord({ verb: "ask", payload: "hello" });
  assert.equal(t.format, "txt");
});

test("validateRecord enforces only the 4 required fields (loose contract)", () => {
  const good = makeRecord({ verb: "watch", payload: { a: 1 }, media: { ref: "x.mp4", at: [1, 2] } });
  assert.equal(validateRecord(good).ok, true);

  assert.equal(validateRecord({ verb: "x", format: "json", payload: {} }).ok, false); // no id
  assert.equal(validateRecord({ id: "r", format: "json", payload: {} }).ok, false); // no verb
  assert.equal(validateRecord({ id: "r", verb: "x", format: "bogus", payload: {} }).ok, false);
  assert.equal(validateRecord({ id: "r", verb: "x", format: "json" }).ok, false); // no payload

  // media.at variants
  assert.equal(validateRecord({ id: "r", verb: "x", format: "json", payload: {}, media: { ref: "a", at: 5 } }).ok, true);
  assert.equal(validateRecord({ id: "r", verb: "x", format: "json", payload: {}, media: { ref: "a", at: [1, 2, 3] } }).ok, false);
});

test("isReady treats missing/unknown state as ready", () => {
  assert.equal(isReady({}), true);
  assert.equal(isReady({ state: "ready" }), true);
  assert.equal(isReady({ state: "pending" }), false);
  assert.equal(isReady({ state: "weird" }), false);
});

test("scan pull-progress records are excluded from memory evidence", () => {
  const progress = makeRecord({ verb: "scan", payload: { op: "pull_progress", stage: "complete", processed: 2 } });
  const hit = makeRecord({ verb: "scan", payload: { title: "real hit", snippet: "Zurich", url: "https://example.test" } });
  assert.deepEqual(memoryRecords([progress, hit]).map((r) => r.id), [hit.id]);
});

test("JSONL round-trips through the real fs store", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-rec-"));
  try {
    const file = join(dir, "watch.jsonl");
    const r1 = makeRecord({ verb: "watch", payload: { content: "a" } });
    const r2 = makeRecord({ verb: "watch", payload: { content: "b" }, state: "pending" });
    appendRecordJSONL(file, r1);
    appendRecordJSONL(file, r2);
    const read = readRecordsJSONL(file);
    assert.equal(read.length, 2);
    assert.equal(read[0].id, r1.id);
    assert.equal(read[1].state, "pending");

    // readAllRecords aggregates *.jsonl in a dir
    const all = readAllRecords(dir);
    assert.equal(all.length, 2);
    assert.deepEqual(readRecordsJSONL(join(dir, "missing.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
