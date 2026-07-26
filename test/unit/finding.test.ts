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

function ctx(dir: string, input: string | undefined, rest: string[] = [], opts: VerbContext["opts"] = {}, surface?: VerbContext["surface"]): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: defaultProfile(), surface };
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

test("finding create --ref accepts a path relative to the CASE dir (not just cwd)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finding-caserel-"));
  try {
    const c = openCase(dir);
    c.ensure();
    // exists relative to the CASE dir, but NOT the process cwd (the repo)
    writeFileSync(join(dir, "case-rel-evidence.jpg"), "img");
    const [ok] = await findingVerb.run(ctx(dir, "create", ["rear plate visible"], { ref: "case-rel-evidence.jpg" }));
    assert.equal(ok.state, "ready", ok.error ?? "");
    assert.equal((ok.media as { ref: string }).ref, "case-rel-evidence.jpg");

    // a genuinely bogus relative path is still rejected
    const [bad] = await findingVerb.run(ctx(dir, "create", ["x"], { ref: "nope-does-not-exist.jpg" }));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /does not resolve/);

    // a ../ traversal that ESCAPES the case dir is rejected even if the file exists
    const outside = join(dir, "..", `oc-outside-${Date.now()}.txt`);
    writeFileSync(outside, "secret");
    try {
      const [esc] = await findingVerb.run(ctx(dir, "create", ["x"], { ref: `../${outside.split("/").pop()}` }));
      assert.equal(esc.state, "error");
      assert.match(esc.error ?? "", /does not resolve/);
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding create/review attribute the actor — agent-tool calls stamp agent, CLI stays human", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finding-actor-"));
  try {
    // create: the "who" is the invoking surface, not a constant — an
    // agent-invoked create must not masquerade as a human-typed one.
    const [byHuman] = await findingVerb.run(ctx(dir, "create", ["operator-typed"], {}, "cli"));
    assert.equal(byHuman.meta?.provider, "human");
    const [byAgent] = await findingVerb.run(ctx(dir, "create", ["agent-created"], {}, "agent"));
    assert.equal(byAgent.meta?.provider, "agent");
    // unknown surface (direct library use) keeps the human default
    const [byUnknown] = await findingVerb.run(ctx(dir, "create", ["no surface"]));
    assert.equal(byUnknown.meta?.provider, "human");

    // review rows carry the same attribution as "<who>-review"
    const c = openCase(dir);
    c.writeRecord(byAgent);
    const [review] = await findingVerb.run(ctx(dir, "accept", [byAgent.id], {}, "agent"));
    assert.equal(review.state, "ready", review.error ?? "");
    assert.equal(review.meta?.provider, "agent-review");
    c.writeRecord(byHuman);
    const [cliReview] = await findingVerb.run(ctx(dir, "dismiss", [byHuman.id], {}, "cli"));
    assert.equal(cliReview.meta?.provider, "human-review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finding accept/dismiss --note records the review rationale on the review record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finding-note-"));
  try {
    const c = openCase(dir);
    c.ensure();
    const root = makeRecord({ verb: "finding", payload: { text: "possible reupload", status: "suggested", source_record: "rec_x", source_verb: "image", trigger: "signal:image-match" }, meta: { case: c.dir } });
    c.writeRecord(root);

    const [accepted] = await findingVerb.run(ctx(dir, "accept", [root.id], { note: "homography verified against the original frame" }));
    assert.equal(accepted.state, "ready", accepted.error ?? "");
    assert.equal((accepted.payload as Record<string, unknown>).note, "homography verified against the original frame");

    const [dismissed] = await findingVerb.run(ctx(dir, "dismiss", [root.id], { note: "thumbnail collision, different event" }));
    assert.equal((dismissed.payload as Record<string, unknown>).note, "thumbnail collision, different event");

    // an empty --note is a usage error, not a silent drop
    const [bad] = await findingVerb.run(ctx(dir, "accept", [root.id], { note: "  " }));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /--note requires a value/);

    // no --note stays optional: no note key on the review payload
    const [plain] = await findingVerb.run(ctx(dir, "accept", [root.id]));
    assert.equal(plain.state, "ready");
    assert.equal("note" in (plain.payload as Record<string, unknown>), false);
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
