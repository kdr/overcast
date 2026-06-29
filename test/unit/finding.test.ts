import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord, memoryRecords } from "../../src/record.ts";
import { findingVerb } from "../../src/verbs/finding.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function ctx(dir: string, input: string | undefined, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: defaultProfile() };
}

test("finding create makes a root finding anchored to evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finding-"));
  try {
    const c = openCase(dir);
    c.ensure();
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "fake");
    const source = makeRecord({ verb: "watch", payload: { summary: "Zurich" }, media: { ref: video }, meta: { case: c.dir } });
    c.writeRecord(source);

    const [rec] = await findingVerb.run(ctx(dir, "create", ["Confirmed Will Smith in Zurich"], { ref: source.id, at: "0-63", target: "Will Smith", confidence: "high" }));
    assert.equal(rec.verb, "finding");
    assert.equal(rec.state, "ready");
    assert.deepEqual(rec.media, { ref: video, at: [0, 63] });
    const payload = rec.payload as Record<string, unknown>;
    assert.equal(payload.source_record, source.id);
    assert.equal(payload.source_verb, "watch");
    assert.equal(payload.target, "Will Smith");
    assert.equal(payload.confidence, "high");
    assert.equal(memoryRecords([rec]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare finding defaults to listing open findings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finding-list-"));
  try {
    const c = openCase(dir);
    c.ensure();
    const finding = makeRecord({ verb: "finding", payload: { text: "confirmed", status: "open" }, meta: { case: c.dir } });
    c.writeRecord(finding);
    c.writeRecord(makeRecord({ verb: "finding", payload: { error: "usage: finding create|list|accept|dismiss [id]" }, state: "error" }));
    c.writeRecord(makeRecord({ verb: "finding", payload: { state: "open", findings: [finding] } }));

    const [rec] = await findingVerb.run(ctx(dir, undefined));
    const payload = rec.payload as Record<string, unknown>;
    assert.equal(payload.state, "open");
    assert.equal(rec.meta?.transient, true);
    assert.equal((payload.findings as unknown[]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
