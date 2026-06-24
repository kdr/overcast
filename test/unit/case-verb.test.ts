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
