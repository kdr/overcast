import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, openSync, fstatSync, closeSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase, recordFiles } from "../../src/case.ts";
import { appendRecordJSONL, makeRecord } from "../../src/record.ts";

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

test("records() ignores stray records tagged for a different case", () => {
  withTmp((dir) => {
    const other = mkdtempSync(join(tmpdir(), "oc-other-case-"));
    try {
      const c = openCase(dir);
      c.ensure();
      c.writeRecord(makeRecord({ verb: "note", payload: { text: "mine" } }));
      appendRecordJSONL(
        join(c.recordsDir, "watch.jsonl"),
        makeRecord({ verb: "watch", payload: { content: "not mine" }, meta: { case: other } }),
      );

      assert.deepEqual(c.records().map((r) => r.verb), ["note"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
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
    writeFileSync(join(dir, "brief.html"), "<html></html>");
    writeFileSync(c.sourcesFile, JSON.stringify({ sources: [] }));
    writeFileSync(c.legacyCollectionsFile, JSON.stringify({ collections: [] }));

    const summary = c.clearSummary();
    assert.equal(summary.records, 1);
    assert.deepEqual(summary.counts, { watch: 1 });
    assert.equal(summary.media.files, 1);
    assert.equal(summary.media.bytes, 5);
    assert.equal(summary.index.files, 1);
    assert.deepEqual(summary.artifacts, ["brief.html"]);
    assert.deepEqual(summary.stateFiles, ["sources.json", "collections.json"]);
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
    writeFileSync(join(dir, "brief.html"), "<html></html>");
    writeFileSync(join(dir, "brief.md"), "# Brief");
    writeFileSync(c.targetFile, JSON.stringify({ targets: [] }));
    writeFileSync(c.legacyCollectionsFile, JSON.stringify({ collections: [] }));

    const before = c.clear();
    assert.equal(before.records, 1);
    assert.ok(existsSync(c.caseFile));
    assert.equal(openCase(dir).info().id, info.id);
    assert.equal(c.records().length, 0);
    assert.equal(existsSync(join(c.mediaDir, "clip.txt")), false);
    assert.equal(existsSync(c.indexDir), false);
    assert.equal(existsSync(join(dir, "brief.html")), false);
    assert.equal(existsSync(join(dir, "brief.md")), false);
    assert.equal(existsSync(c.targetFile), false);
    assert.equal(existsSync(c.legacyCollectionsFile), false);
  });
});

test("records() cache: a write on the same instance is visible to reads (read-after-write)", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    c.ensure();
    assert.equal(c.records().length, 0);
    const r1 = makeRecord({ verb: "watch", payload: { content: "a" } });
    c.writeRecord(r1);
    // records() populated the (empty) cache first; the write must still show
    assert.equal(c.records().length, 1);
    assert.equal(c.recordById(r1.id)?.id, r1.id);
    const r2 = makeRecord({ verb: "listen", payload: { transcript: "b" } });
    c.writeRecord(r2);
    assert.equal(c.records().length, 2);
    assert.equal(c.recordById(r2.id)?.verb, "listen");
  });
});

test("records() cache: a fresh Case instance reads what another wrote to disk", () => {
  withTmp((dir) => {
    const a = openCase(dir);
    a.ensure();
    a.writeRecord(makeRecord({ id: "rec_x1", verb: "note", payload: { text: "hi" } }));
    // a different instance (a new command) must NOT be hidden by a's cache
    const b = openCase(dir);
    assert.equal(b.records().length, 1);
    assert.equal(b.recordById("rec_x1")?.verb, "note");
  });
});

test("records() cache: returns a fresh array (in-place mutation can't corrupt the cache)", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: {} }));
    c.writeRecord(makeRecord({ verb: "listen", payload: {} }));
    const first = c.records();
    first.length = 0; // mutate the returned array
    assert.equal(c.records().length, 2, "cache is unaffected by mutating a returned array");
  });
});

test("records() cache: clear() drops the cache", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: {} }));
    assert.equal(c.records().length, 1);
    c.clear();
    assert.equal(c.records().length, 0);
  });
});

test("records() cache: an external in-place jsonl change is picked up (disk-coherent)", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ id: "rec_ext", verb: "watch", payload: { content: "before" } }));
    const before = c.recordById("rec_ext")?.payload as { content: string };
    assert.equal(before.content, "before");
    // rewrite the file in place, bypassing writeRecord (what qmd staleness detects)
    const f = join(c.recordsDir, "watch.jsonl");
    writeFileSync(f, JSON.stringify(makeRecord({ id: "rec_ext", verb: "watch", payload: { content: "AFTER-EXTERNAL" } })) + "\n", "utf8");
    const after = c.recordById("rec_ext")?.payload as { content: string };
    assert.equal(after.content, "AFTER-EXTERNAL", "cache reloaded on external mtime/size change");
  });
});

test("records() cache: an external write between cache-build and a local write is not dropped", () => {
  withTmp((dir) => {
    const a = openCase(dir);
    a.ensure();
    a.writeRecord(makeRecord({ id: "rec_a1", verb: "watch", payload: {} }));
    assert.equal(a.records().length, 1); // warms a's cache + stamp

    // a DIFFERENT Case on the same dir appends (simulates another process)
    openCase(dir).writeRecord(makeRecord({ id: "rec_b1", verb: "listen", payload: {} }));

    // a writes again — it must NOT re-bless its stale cache (which lacks rec_b1)
    a.writeRecord(makeRecord({ id: "rec_a2", verb: "watch", payload: {} }));

    assert.deepEqual(a.records().map((r) => r.id).sort(), ["rec_a1", "rec_a2", "rec_b1"]);
    assert.ok(a.recordById("rec_b1"), "recordById sees the external write too");
  });
});

test("records() cache: a same-size in-place edit is detected even if mtime is forged back (ctime)", () => {
  withTmp((dir) => {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ id: "rec_ss", verb: "watch", payload: { content: "AAAA" } }));
    assert.equal((c.recordById("rec_ss")?.payload as { content: string }).content, "AAAA");

    const f = join(c.recordsDir, "watch.jsonl");
    // stat + read the SAME descriptor rather than the path twice — the mtime we
    // forge back has to belong to the bytes we edited for the assertion to mean
    // anything (and path-check-then-path-read is CodeQL js/file-system-race).
    const fd = openSync(f, "r");
    let beforeMtime: Date;
    let raw: string;
    try {
      beforeMtime = fstatSync(fd).mtime;
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const edited = raw.replace('"AAAA"', '"BBBB"'); // same byte length
    assert.equal(edited.length, raw.length, "edit must be the exact same size");
    writeFileSync(f, edited, "utf8");
    // forge the mtime back to before the edit — the old maxMtime:totalSize stamp
    // would collide (size unchanged, mtime reset); only ctime advances now.
    utimesSync(f, beforeMtime, beforeMtime);

    assert.equal((c.recordById("rec_ss")?.payload as { content: string }).content, "BBBB");
  });
});
