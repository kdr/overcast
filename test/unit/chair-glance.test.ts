import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { makeRecord } from "../../src/record.ts";
import { addTarget } from "../../src/state/target.ts";
import { addSource } from "../../src/state/source.ts";
import { buildCaseGlance } from "../../src/chair/glance.ts";

test("case glance: counts, open findings only, latest per verb, scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-glance-"));
  try {
    const c = openCase(dir);
    c.ensure();

    c.writeRecord(
      makeRecord({
        verb: "watch",
        payload: { content: "a white van circles the block twice" },
        meta: { time: "2026-07-01T10:00:00Z" },
      }),
    );
    c.writeRecord(
      makeRecord({
        verb: "watch",
        payload: { content: "night footage, nothing of note" },
        meta: { time: "2026-07-02T10:00:00Z" },
      }),
    );
    c.writeRecord(
      makeRecord({ verb: "scan", payload: { op: "scan", query: "white van" }, meta: { time: "2026-07-03T09:00:00Z" } }),
    );

    // one open finding, one dismissed (root + review row)
    const open = makeRecord({
      verb: "finding",
      payload: { text: "van plate matches target sighting", status: "open", source_record: "rec_a", target: "van" },
      meta: { time: "2026-07-03T10:00:00Z" },
    });
    c.writeRecord(open);
    const dismissed = makeRecord({
      verb: "finding",
      payload: { text: "false hit on the red car", status: "open", source_record: "rec_b" },
    });
    c.writeRecord(dismissed);
    c.writeRecord(makeRecord({ verb: "finding", payload: { finding_id: dismissed.id, status: "dismissed" } }));

    addTarget(c, "@vanwatcher");
    addSource(c, "youtube:@cityfeed");

    const glance = buildCaseGlance(c);
    assert.equal(glance.records, 6);
    assert.equal(glance.counts.watch, 2);
    assert.equal(glance.counts.finding, 3);

    // only the still-open finding surfaces
    assert.equal(glance.openFindings.length, 1);
    assert.equal(glance.openFindings[0].id, open.id);
    assert.equal(glance.openFindings[0].target, "van");

    // newest record per verb, newest verbs first
    const byVerb = Object.fromEntries(glance.latest.map((r) => [r.verb, r]));
    assert.match(byVerb.watch.summary, /night footage/);
    assert.equal(glance.latest[0].verb, "finding"); // 2026-07-03T10:00 is newest

    assert.deepEqual(
      glance.targets.map((t) => t.value),
      ["@vanwatcher"],
    );
    assert.deepEqual(
      glance.sources.map((s) => `${s.type}:${s.ref}`),
      ["youtube:@cityfeed"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case glance: empty/uninitialized case degrades to folder name", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-glance-empty-"));
  try {
    const glance = buildCaseGlance(openCase(dir));
    assert.equal(glance.records, 0);
    assert.deepEqual(glance.openFindings, []);
    assert.deepEqual(glance.latest, []);
    assert.ok(glance.caseName.startsWith("oc-glance-empty-"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
