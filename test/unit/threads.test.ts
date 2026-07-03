import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { buildThreads, threadsHeadline } from "../../src/signals/threads.ts";
import { addTarget, listTargets, setTargetStatus, primaryTarget, isTargetClosed } from "../../src/state/target.ts";
import { targetVerb } from "../../src/verbs/osint.ts";
import type { TargetEntry } from "../../src/state/target.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const NOW = Date.parse("2026-07-02T00:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function target(over: Partial<TargetEntry> & { id: string; value: string }): TargetEntry {
  return { kind: "name", created: "2026-07-01T00:00:00Z", ...over } as TargetEntry;
}

test("buildThreads: stage ladder from cold → collecting → leads → corroborated", () => {
  const t = target({ id: "tgt_a", value: "acme" });
  // cold
  assert.equal(buildThreads([], [t], NOW)[0].stage, "cold");
  // collecting: an evidence record mentions the target
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "acme spotted at pier" }, media: { ref: "v.mp4" }, meta: { time: iso(3600_000) } });
  assert.equal(buildThreads([watch], [t], NOW)[0].stage, "collecting");
  // leads: an open finding on the target
  const open = makeRecord({ verb: "finding", format: "json", payload: { text: "lead", target: "acme", source_record: watch.id, source_verb: "watch", trigger: "human", status: "open" }, meta: { time: iso(1800_000) } });
  assert.equal(buildThreads([watch, open], [t], NOW)[0].stage, "leads");
  // corroborated: an accepted finding (via review record)
  const accept = makeRecord({ verb: "finding", format: "json", payload: { finding_id: open.id, status: "accepted", reviewed_at: iso(900_000) } });
  assert.equal(buildThreads([watch, open, accept], [t], NOW)[0].stage, "corroborated");
});

test("buildThreads: declared status wins over evidence stage", () => {
  const t = target({ id: "tgt_a", value: "acme", status: "dead-end", status_note: "handle deleted" });
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "acme" }, media: { ref: "v.mp4" } });
  const th = buildThreads([watch], [t], NOW)[0];
  assert.equal(th.stage, "dead-end");
  assert.equal(th.status, "dead-end");
  assert.equal(th.why, "handle deleted");
});

test("buildThreads: image targets link via reference-path match, not text", () => {
  const t = target({ id: "tgt_img", value: "refs/probe.jpg", kind: "image" });
  const faceHit = makeRecord({ verb: "face", format: "json", payload: { op: "match", reference: "refs/probe.jpg", faces: [{ at: 5, similarity: 88 }], count: 1 }, media: { ref: "clip.mp4" }, meta: { time: iso(1000) } });
  const unrelated = makeRecord({ verb: "watch", format: "json", payload: { content: "mentions probe.jpg in text" }, media: { ref: "x.mp4" } });
  const th = buildThreads([faceHit, unrelated], [t], NOW)[0];
  assert.equal(th.funnel.matches, 1);
  assert.equal(th.stage, "collecting");
  // the text-only watch must NOT link to an image target
  assert.equal(th.evidence.watch, undefined);
});

test("buildThreads: finding counts, funnel, and momentum", () => {
  const t = target({ id: "tgt_a", value: "acme" });
  const records: OvercastRecord[] = [
    makeRecord({ verb: "scan", format: "json", payload: { source: "web", url: "http://x/1", title: "acme post" }, meta: { time: iso(6 * 24 * 3600_000) } }),
    makeRecord({ verb: "capture", format: "json", payload: { text: "acme capture" }, media: { ref: "c.mp4" }, meta: { time: iso(2 * 24 * 3600_000) } }),
    makeRecord({ verb: "watch", format: "json", payload: { content: "acme in view" }, media: { ref: "c.mp4" }, meta: { time: iso(3600_000) } }),
    makeRecord({ verb: "finding", format: "json", payload: { text: "s", target: "acme", source_record: "x", source_verb: "face", trigger: "signal:face-match", status: "suggested" }, meta: { time: iso(1800_000) } }),
  ];
  const th = buildThreads(records, [t], NOW)[0];
  assert.equal(th.funnel.scan, 1);
  assert.equal(th.funnel.captures, 1);
  assert.equal(th.funnel.senses, 1);
  assert.equal(th.findings.suggested, 1);
  assert.equal(th.stage, "leads");
  assert.equal(th.recent.day, 2); // watch + suggested finding within 24h
  assert.equal(th.recent.week, 4);
  assert.equal(th.activityBins.length, 8);
  assert.ok(th.activityBins.reduce((a, b) => a + b, 0) === 4);
});

test("buildThreads: notes tagged thread:<id> link even without value match", () => {
  const t = target({ id: "tgt_z", value: "acme" });
  const note = makeRecord({ verb: "note", format: "json", payload: { text: "this line is cold", tags: ["thread:tgt_z"] }, meta: { time: iso(100) } });
  const th = buildThreads([note], [t], NOW)[0];
  assert.equal(th.evidence.note, 1);
});

test("buildThreads: newest thread:<id> note surfaces as the line narrative", () => {
  const t = target({ id: "tgt_n", value: "acme" });
  const older = makeRecord({ verb: "note", format: "json", payload: { text: "early read on this line", tags: ["thread:tgt_n"] }, meta: { time: iso(2 * 24 * 3600_000) } });
  const newer = makeRecord({ verb: "note", format: "json", payload: { text: "reups traced to @codez; next: subpoena the reseller", tags: ["thread:tgt_n"] }, meta: { time: iso(3600_000) } });
  const th = buildThreads([older, newer], [t], NOW)[0];
  assert.equal(th.narrative, "reups traced to @codez; next: subpoena the reseller");
});

test("threadsHeadline: honest progress sentence", () => {
  const threads = [
    { status: "active", stage: "leads" },
    { status: "active", stage: "collecting" },
    { status: "answered", stage: "answered" },
    { status: "dead-end", stage: "dead-end" },
  ] as Parameters<typeof threadsHeadline>[0];
  const line = threadsHeadline(threads, 3);
  assert.match(line, /2 lines active \(1 with leads\)/);
  assert.match(line, /1 answered/);
  assert.match(line, /1 dead-end/);
  assert.match(line, /3 suggestions awaiting triage/);
  assert.equal(threadsHeadline([], 0), "No lines of investigation yet");
});

// ---- target state persistence + verb ----

function withCase(fn: (c: ReturnType<typeof openCase>) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-threads-"));
  const c = openCase(dir);
  c.ensure();
  return Promise.resolve(fn(c)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function ctxFor(c: ReturnType<typeof openCase>, input: string | undefined, rest: string[] = [], opts: Record<string, unknown> = {}): VerbContext {
  return { input, rest, opts, case: c, profile: { name: "test", providers: {} }, profileName: "test" } as unknown as VerbContext;
}

test("setTargetStatus: close + reopen round-trips; primaryTarget skips closed", () =>
  withCase((c) => {
    const a = addTarget(c, "alpha");
    const b = addTarget(c, "bravo");
    assert.equal(primaryTarget(c)?.id, b.id);
    setTargetStatus(c, b.id, "dead-end", "no hits");
    assert.equal(primaryTarget(c)?.id, a.id); // skips the closed newest
    assert.ok(isTargetClosed(listTargets(c).find((t) => t.id === b.id)!));
    setTargetStatus(c, b.id, "active");
    assert.equal(primaryTarget(c)?.id, b.id);
    assert.equal(listTargets(c).find((t) => t.id === b.id)!.status, undefined);
  }));

test("target verb: add --question, close --as, reopen", () =>
  withCase(async (c) => {
    const add = await targetVerb.run(ctxFor(c, "add", ["mystery"], { question: "who runs it?" }));
    const id = (add[0].payload as { id: string }).id;
    assert.equal(listTargets(c)[0].question, "who runs it?");
    const close = await targetVerb.run(ctxFor(c, "close", [id], { as: "answered", note: "identified" }));
    assert.equal((close[0].payload as { status: string }).status, "answered");
    assert.equal(listTargets(c)[0].status_note, "identified");
    const reopen = await targetVerb.run(ctxFor(c, "reopen", [id]));
    assert.equal((reopen[0].payload as { status?: string }).status, undefined);
    // bad --as is a user error
    const bad = await targetVerb.run(ctxFor(c, "close", [id], { as: "maybe" }));
    assert.equal(bad[0].state, "error");
  }));
