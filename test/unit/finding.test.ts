import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { makeFinding, findingVerb } from "../../src/verbs/finding.ts";
import { makeRecord, isMemoryRecord } from "../../src/record.ts";
import { defaultProfile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const ctx = (dir: string, input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext =>
  ({ input, rest, opts, case: openCase(dir), profile: defaultProfile() });

test("finding list/accept/dismiss uses append-only review records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finding-"));
  try {
    const c = openCase(dir); c.ensure();
    const source = makeRecord({ verb: "watch", payload: { content: "white van" }, media: { ref: "clip.mp4", at: 12 } });
    c.writeRecord(source);
    const finding = makeFinding({ text: "Automated match", target: "white van", sourceRecord: source, trigger: "test" });
    c.writeRecord(finding);

    const [listed] = await findingVerb.run(ctx(dir, "list"));
    assert.equal((((listed.payload as Record<string, unknown>).findings as unknown[]).length), 1);

    const [dismissed] = await findingVerb.run(ctx(dir, "dismiss", [finding.id]));
    c.writeRecord(dismissed);
    assert.equal((dismissed.payload as Record<string, unknown>).status, "dismissed");

    const [open] = await findingVerb.run(ctx(dir, "list"));
    assert.equal((((open.payload as Record<string, unknown>).findings as unknown[]).length), 0);
    const [all] = await findingVerb.run(ctx(dir, "list", [], { state: "all" }));
    assert.equal((((all.payload as Record<string, unknown>).findings as unknown[]).length), 1);
    assert.equal(isMemoryRecord(dismissed), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

