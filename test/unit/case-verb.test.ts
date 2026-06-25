import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function withCase(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-casev-"));
  const c = openCase(dir); c.ensure();
  c.writeRecord(makeRecord({ verb: "watch", payload: { content: "white van at the docks" }, media: { ref: "x.mp4" } }));
  c.writeRecord(makeRecord({ verb: "scan", payload: { title: "feed" } }));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const ctx = (dir: string, input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext =>
  ({ input, rest, opts, case: openCase(dir), profile: defaultProfile() });

test("case info reports record count + per-verb counts", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "info"));
    assert.equal((rec.payload as Record<string, unknown>).records, 2);
    assert.deepEqual((rec.payload as Record<string, unknown>).counts, { watch: 1, scan: 1 });
  });
});
test("case records --verb filters", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "records", [], { verb: "watch" }));
    const recs = (rec.payload as Record<string, unknown>).records as unknown[];
    assert.equal(recs.length, 1);
  });
});
test("case memory search returns passages", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["search", "white", "van"]));
    assert.ok(((rec.payload as Record<string, unknown>).passages as unknown[]).length >= 1);
  });
});
test("case unknown action errors", async () => {
  await withCase(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "frob"));
    assert.equal(rec.state, "error");
  });
});

// --- case memory get: manifest + field paging --------------------------------

/** Seed a case with one big-content watch record; return [dir, id]. */
function withBigRecord(fn: (dir: string, id: string, content: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-getp-"));
  const c = openCase(dir); c.ensure();
  const content = Array.from({ length: 60 }, (_, i) => `scene ${i} line`).join("\n"); // multi-page
  const rec = makeRecord({ verb: "watch", payload: { content, transcript: "", detailed: { segments: [1, 2, 3] } }, media: { ref: "v.mp4" } });
  c.writeRecord(rec);
  return fn(dir, rec.id, content).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("case memory get <id> returns a field manifest with chars matching paging total", async () => {
  await withBigRecord(async (dir, id, content) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", id]));
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.record, id);
    assert.equal(p.verb, "watch");
    const fields = p.fields as Array<Record<string, unknown>>;
    const contentField = fields.find((f) => f.name === "content")!;
    assert.equal(contentField.type, "string");
    assert.equal(contentField.chars, content.length); // manifest chars === what paging reports as total
  });
});

test("case memory get --field pages deterministically with has_more/next_offset", async () => {
  await withBigRecord(async (dir, id, content) => {
    const [p1] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: 0, limit: 100 }));
    const a = p1.payload as Record<string, unknown>;
    assert.equal(a.field, "content");
    assert.equal(a.total, content.length);
    assert.equal(a.offset, 0);
    assert.equal(a.returned, 100);
    assert.equal(a.has_more, true);
    assert.equal(a.next_offset, 100);
    assert.equal(a.chunk, content.slice(0, 100));

    // continue at next_offset — the second page resumes exactly where the first ended
    const [p2] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: a.next_offset as number, limit: 100 }));
    const b = p2.payload as Record<string, unknown>;
    assert.equal(b.offset, 100);
    assert.equal(b.chunk, content.slice(100, 200));
  });
});

test("case memory get --field reaches the end (has_more false, next_offset null)", async () => {
  await withBigRecord(async (dir, id, content) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: 0, limit: content.length + 50 }));
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.returned, content.length);
    assert.equal(p.has_more, false);
    assert.equal(p.next_offset, null);
  });
});

test("case memory get errors on a missing field, listing the real fields", async () => {
  await withBigRecord(async (dir, id) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "nope" }));
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /no field 'nope'/);
    assert.match(String(rec.error), /content/);
  });
});

test("case memory get validates --offset and --limit", async () => {
  await withBigRecord(async (dir, id) => {
    const [bad1] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: -5 }));
    assert.equal(bad1.state, "error");
    const [bad2] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", limit: 0 }));
    assert.equal(bad2.state, "error");
  });
});

test("case memory get rejects --offset/--limit without --field on an object payload", async () => {
  await withBigRecord(async (dir, id) => {
    const [o] = await caseVerb.run(ctx(dir, "memory", ["get", id], { offset: 0 }));
    assert.equal(o.state, "error");
    assert.match(String(o.error), /require --field/);
    const [l] = await caseVerb.run(ctx(dir, "memory", ["get", id], { limit: 100 }));
    assert.equal(l.state, "error");
  });
});

test("case memory get manifest/chunk carry meta.pageTarget for correct hints", async () => {
  await withBigRecord(async (dir, id) => {
    const [man] = await caseVerb.run(ctx(dir, "memory", ["get", id]));
    assert.equal(man.meta?.pageTarget, id);
    const [chunk] = await caseVerb.run(ctx(dir, "memory", ["get", id], { field: "content", offset: 0, limit: 10 }));
    assert.equal(chunk.meta?.pageTarget, id);
  });
});

test("case memory get on a missing record errors", async () => {
  await withBigRecord(async (dir) => {
    const [rec] = await caseVerb.run(ctx(dir, "memory", ["get", "rec_doesnotexist"]));
    assert.equal(rec.state, "error");
  });
});

test("case memory get pages a plain-string payload as (text), no --field needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-getstr-"));
  try {
    const c = openCase(dir); c.ensure();
    const rec = makeRecord({ verb: "note", payload: "a plain string payload body" });
    c.writeRecord(rec);
    const [out] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { offset: 0, limit: 5 }));
    const p = out.payload as Record<string, unknown>;
    assert.equal(p.field, "(text)");
    assert.equal(p.chunk, "a pla");
    assert.equal(p.total, "a plain string payload body".length);

    // a wrong --field on a string payload must error, not silently page the string
    const [bad] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { field: "content" }));
    assert.equal(bad.state, "error");
    assert.match(String(bad.error), /no field 'content'.*\(text\)/);
    // the explicit "(text)" field name is accepted
    const [okp] = await caseVerb.run(ctx(dir, "memory", ["get", rec.id], { field: "(text)", offset: 0, limit: 3 }));
    assert.equal((okp.payload as Record<string, unknown>).chunk, "a p");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
