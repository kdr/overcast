import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { makeRecord, memoryRecords, type OvercastRecord } from "../../src/record.ts";
import { evaluateTriggers, extractSignal, resolveFindingsPolicy, DEFAULT_TRIGGER_THRESHOLDS } from "../../src/signals/triggers.ts";
import { persistRecords } from "../../src/registry/persist.ts";
import { findingVerb } from "../../src/verbs/finding.ts";
import { emptySetup, saveSetup, loadSetup } from "../../src/state/setup.ts";
import { addTarget } from "../../src/state/target.ts";
import type { TargetEntry } from "../../src/state/target.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const T = DEFAULT_TRIGGER_THRESHOLDS;

function faceMatch(similarity: number, opts: { ref?: string; at?: number; reference?: string } = {}): OvercastRecord {
  return makeRecord({
    verb: "face",
    format: "json",
    payload: {
      op: "match",
      reference: opts.reference ?? "probe.jpg",
      faces: [{ at: opts.at ?? 41, similarity }, { at: 3, similarity: Math.max(0, similarity - 20) }],
      count: 2,
    },
    media: { ref: opts.ref ?? "clip.mp4", at: 0 },
  });
}

function imageMatch(inliers: number): OvercastRecord {
  return makeRecord({
    verb: "image",
    format: "json",
    payload: { op: "match", matches: [{ ref: "db.jpg", num_inliers: inliers, at: 12 }], count: 1 },
    media: { ref: "probe.mp4" },
  });
}

function similarMatch(similarity: number, op = "match"): OvercastRecord {
  return makeRecord({
    verb: "similar",
    format: "json",
    payload: { op, matches: [{ ref: "member.mp4", similarity, at: 7 }], count: 1 },
    media: { ref: "query.jpg" },
  });
}

function clusterIdentify(similarity: number): OvercastRecord {
  return makeRecord({
    verb: "cluster",
    format: "json",
    payload: { op: "identify", matches: [{ at: 5, confident: true, candidates: [{ label: "person_1", similarity }] }], count: 1 },
    media: { ref: "probe.jpg" },
  });
}

const nameTarget: TargetEntry = { id: "tgt_a", kind: "name", value: "acme handle", created: "2026-07-01T00:00:00Z" };
const imageTarget: TargetEntry = { id: "tgt_b", kind: "image", value: "refs/probe.jpg", created: "2026-07-01T00:00:00Z" };
const SUGGEST = { mode: "suggest" as const };

test("extractSignal: face match clears floor, picks best moment", () => {
  const sig = extractSignal(faceMatch(87.2, { at: 41 }), T);
  assert.ok(sig);
  assert.equal(sig.kind, "face-match");
  assert.equal(sig.score, 87.2);
  assert.equal(sig.at, 41);
});

test("extractSignal: below-floor scores and non-match ops return nothing", () => {
  assert.equal(extractSignal(faceMatch(60), T), undefined);
  assert.equal(extractSignal(similarMatch(95, "search"), T), undefined);
  assert.equal(extractSignal(similarMatch(80), T), undefined);
  assert.equal(extractSignal(clusterIdentify(60), T), undefined);
});

test("evaluateTriggers: face match emits a quarantined suggested finding with confidence bands", () => {
  const high = evaluateTriggers({ fresh: [faceMatch(87.2)], existing: [], targets: [imageTarget], policy: SUGGEST });
  assert.equal(high.length, 1);
  const p = high[0].payload as Record<string, unknown>;
  assert.equal(p.status, "suggested");
  assert.equal(p.trigger, "signal:face-match");
  assert.equal(p.confidence, "high");
  assert.equal(p.target, imageTarget.value); // linked by reference basename
  assert.equal(p.target_id, imageTarget.id);
  assert.equal(high[0].media?.at, 41); // anchored at the best-scoring moment

  const medium = evaluateTriggers({ fresh: [faceMatch(78)], existing: [], targets: [], policy: SUGGEST });
  assert.equal((medium[0].payload as Record<string, unknown>).confidence, "medium");
});

test("evaluateTriggers: image / similar / cluster triggers fire per table", () => {
  const img = evaluateTriggers({ fresh: [imageMatch(50)], existing: [], targets: [], policy: SUGGEST });
  assert.equal((img[0].payload as Record<string, unknown>).confidence, "high");
  const imgMed = evaluateTriggers({ fresh: [imageMatch(20)], existing: [], targets: [], policy: SUGGEST });
  assert.equal((imgMed[0].payload as Record<string, unknown>).confidence, "medium");
  const sim = evaluateTriggers({ fresh: [similarMatch(91)], existing: [], targets: [], policy: SUGGEST });
  assert.equal((sim[0].payload as Record<string, unknown>).trigger, "signal:similar-match");
  const cl = evaluateTriggers({ fresh: [clusterIdentify(82)], existing: [], targets: [], policy: SUGGEST });
  assert.equal((cl[0].payload as Record<string, unknown>).confidence, "high");
  assert.match(String((cl[0].payload as Record<string, unknown>).text), /person_1/);
});

test("evaluateTriggers: text-target — suggested in suggest mode, legacy open in review mode", () => {
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "the acme handle appears here" }, media: { ref: "v.mp4" } });
  const suggested = evaluateTriggers({ fresh: [watch], existing: [], targets: [nameTarget], policy: SUGGEST });
  assert.equal((suggested[0].payload as Record<string, unknown>).status, "suggested");
  const legacy = evaluateTriggers({ fresh: [watch], existing: [], targets: [nameTarget], policy: { mode: "review" }, via: "scan:watch" });
  assert.equal((legacy[0].payload as Record<string, unknown>).status, "open");
  assert.equal((legacy[0].payload as Record<string, unknown>).trigger, "scan:watch");
});

test("evaluateTriggers: analyst notes do NOT self-suggest (only machine-analyzed content)", () => {
  // a /debrief thread/tldr note routinely names the target — auto-suggesting a
  // finding that cites the analyst's own note is triage noise, so notes are out
  const note = makeRecord({ verb: "note", format: "json", payload: { text: "acme handle reups traced to @codez", tags: ["thread:tgt_a"] }, media: { ref: "n.txt" } });
  assert.equal(evaluateTriggers({ fresh: [note], existing: [], targets: [nameTarget], policy: SUGGEST }).length, 0);
  // the same phrase in a machine transcript still leads
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "acme handle reups traced to @codez" }, media: { ref: "v.mp4" } });
  assert.equal(evaluateTriggers({ fresh: [watch], existing: [], targets: [nameTarget], policy: SUGGEST }).length, 1);
});

test("evaluateTriggers: text-target fires on content verbs, NOT scan hits or captures", () => {
  // a scan hit whose title mentions the target must NOT create a text lead —
  // otherwise the same item leads once from its hit and again from its watch
  const scanHit = makeRecord({ verb: "scan", format: "json", payload: { source: "x", url: "http://x/1", title: "acme handle reup", source_id: "s1" }, media: { ref: "http://x/1" } });
  const capture = makeRecord({ verb: "capture", format: "json", payload: { path: "c.mp4", source_text: "acme handle" }, media: { ref: "c.mp4" } });
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "acme handle on screen" }, media: { ref: "c.mp4" } });
  assert.equal(evaluateTriggers({ fresh: [scanHit], existing: [], targets: [nameTarget], policy: SUGGEST }).length, 0);
  assert.equal(evaluateTriggers({ fresh: [capture], existing: [], targets: [nameTarget], policy: SUGGEST }).length, 0);
  assert.equal(evaluateTriggers({ fresh: [watch], existing: [], targets: [nameTarget], policy: SUGGEST }).length, 1);
});

test("evaluateTriggers: two senses on the same clip fold to one text lead (shared media.ref)", () => {
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "acme handle appears" }, media: { ref: "c.mp4" } });
  const listen = makeRecord({ verb: "listen", format: "json", payload: { transcript: "someone says acme handle" }, media: { ref: "c.mp4" } });
  const first = evaluateTriggers({ fresh: [watch], existing: [], targets: [nameTarget], policy: SUGGEST });
  assert.equal(first.length, 1);
  // listen on the same clip must dedup via the shared media.ref, not re-lead
  assert.equal(evaluateTriggers({ fresh: [listen], existing: first, targets: [nameTarget], policy: SUGGEST }).length, 0);
});

test("evaluateTriggers: CLOSED lines accumulate no new suggestions (text + score)", () => {
  const closedName: TargetEntry = { ...nameTarget, status: "dead-end" };
  const closedImg: TargetEntry = { ...imageTarget, status: "answered" };
  // text-target against a closed name line: no lead
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "the acme handle appears here" }, media: { ref: "v.mp4" } });
  assert.equal(evaluateTriggers({ fresh: [watch], existing: [], targets: [closedName], policy: SUGGEST }).length, 0);
  // score match whose reference IS a closed image line: still fires (the match is
  // intrinsically interesting) but is NOT attributed to the dead line
  const [f] = evaluateTriggers({ fresh: [faceMatch(90, { reference: imageTarget.value })], existing: [], targets: [closedImg], policy: SUGGEST });
  assert.ok(f);
  assert.equal((f.payload as Record<string, unknown>).target, "");
  assert.equal((f.payload as Record<string, unknown>).target_id, undefined);
});

test("evaluateTriggers: mode off fires nothing; score triggers stay off in review mode", () => {
  assert.equal(evaluateTriggers({ fresh: [faceMatch(99)], existing: [], targets: [], policy: { mode: "off" } }).length, 0);
  assert.equal(evaluateTriggers({ fresh: [faceMatch(99)], existing: [], targets: [], policy: { mode: "review" } }).length, 0);
});

test("evaluateTriggers: dedup — existing suggestion blocks, dismissed blocks in suggest mode", () => {
  const rec = faceMatch(90);
  const first = evaluateTriggers({ fresh: [rec], existing: [], targets: [], policy: SUGGEST });
  assert.equal(first.length, 1);
  // same source again → no re-fire
  assert.equal(evaluateTriggers({ fresh: [rec], existing: first, targets: [], policy: SUGGEST }).length, 0);
  // dismissed → still no re-fire (suggest semantics)
  const dismissal = makeRecord({ verb: "finding", format: "json", payload: { finding_id: first[0].id, status: "dismissed", reviewed_at: "2026-07-02T00:00:00Z" } });
  assert.equal(evaluateTriggers({ fresh: [rec], existing: [...first, dismissal], targets: [], policy: SUGGEST }).length, 0);
});

test("evaluateTriggers: review mode keeps legacy dismissed-refire semantics", () => {
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "acme handle sighting" }, media: { ref: "v.mp4" } });
  const first = evaluateTriggers({ fresh: [watch], existing: [], targets: [nameTarget], policy: { mode: "review" } });
  const dismissal = makeRecord({ verb: "finding", format: "json", payload: { finding_id: first[0].id, status: "dismissed", reviewed_at: "2026-07-02T00:00:00Z" } });
  const again = evaluateTriggers({ fresh: [watch], existing: [...first, dismissal], targets: [nameTarget], policy: { mode: "review" } });
  assert.equal(again.length, 1);
});

test("evaluateTriggers: a manual finding citing the record blocks a score re-suggestion", () => {
  const rec = imageMatch(60);
  const manual = makeRecord({ verb: "finding", format: "json", payload: { text: "confirmed reupload", target: "", source_record: rec.id, source_verb: "image", trigger: "human", status: "open" } });
  assert.equal(evaluateTriggers({ fresh: [rec], existing: [manual], targets: [], policy: SUGGEST }).length, 0);
});

test("memoryRecords: suggested findings are quarantined until accepted", () => {
  const rec = faceMatch(90);
  const [suggested] = evaluateTriggers({ fresh: [rec], existing: [], targets: [], policy: SUGGEST });
  assert.equal(memoryRecords([rec, suggested]).some((r) => r.id === suggested.id), false);
  const accept = makeRecord({ verb: "finding", format: "json", payload: { finding_id: suggested.id, status: "accepted", reviewed_at: "2026-07-02T00:00:00Z" } });
  assert.equal(memoryRecords([rec, suggested, accept]).some((r) => r.id === suggested.id), true);
  const dismiss = makeRecord({ verb: "finding", format: "json", payload: { finding_id: suggested.id, status: "dismissed", reviewed_at: "2026-07-03T00:00:00Z" } });
  assert.equal(memoryRecords([rec, suggested, accept, dismiss]).some((r) => r.id === suggested.id), false);
});

test("resolveFindingsPolicy: missing setup / policy defaults to suggest", () => {
  assert.equal(resolveFindingsPolicy(undefined).mode, "suggest");
  const setup = emptySetup("t");
  assert.equal(resolveFindingsPolicy(setup).mode, "suggest");
});

function withCase(fn: (c: ReturnType<typeof openCase>) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-triggers-"));
  const c = openCase(dir);
  c.ensure();
  return Promise.resolve(fn(c)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("persistRecords: a standalone match run persists + returns a suggested lead exactly once", () =>
  withCase((c) => {
    const rec = faceMatch(90);
    const suggestions = persistRecords(c, [rec]);
    assert.equal(suggestions.length, 1);
    assert.equal((suggestions[0].payload as Record<string, unknown>).status, "suggested");
    const stored = c.records();
    assert.ok(stored.some((r) => r.id === rec.id));
    assert.ok(stored.some((r) => r.id === suggestions[0].id));
    // idempotent: persisting more output for the same media doesn't re-suggest
    const again = persistRecords(c, [faceMatch(90)]);
    assert.equal(again.length, 0);
  }));

test("persistRecords: saved setup with findings off suppresses suggestions", () =>
  withCase((c) => {
    const setup = emptySetup("t");
    setup.findings = { mode: "off" };
    saveSetup(c, setup);
    assert.equal(persistRecords(c, [faceMatch(95)]).length, 0);
  }));

test("persistRecords: custom threshold from setup gates the trigger", () =>
  withCase((c) => {
    const setup = emptySetup("t");
    setup.findings = { mode: "suggest", thresholds: { face: 95 } };
    saveSetup(c, setup);
    assert.equal(persistRecords(c, [faceMatch(90)]).length, 0);
    assert.equal(persistRecords(c, [faceMatch(96, { ref: "other.mp4" })]).length, 1);
  }));

test("loadSetup: legacy setup without findings policy resolves to suggest", () =>
  withCase((c) => {
    const setup = emptySetup("t");
    delete (setup as Partial<typeof setup>).findings;
    saveSetup(c, setup as typeof setup);
    assert.equal(loadSetup(c)?.findings?.mode, "suggest");
  }));

function ctxFor(c: ReturnType<typeof openCase>, input: string | undefined, rest: string[] = [], opts: Record<string, unknown> = {}): VerbContext {
  return { input, rest, opts, case: c, profile: { name: "test", providers: {} }, profileName: "test" } as unknown as VerbContext;
}

test("finding list: --state triage queues open + suggested newest first with provenance", () =>
  withCase(async (c) => {
    addTarget(c, "acme handle");
    // a watch record (sensed from a captured post) carrying its source provenance
    // — text-target fires on content verbs; triage rows walk source_* for context
    const watch = makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "acme handle posted again", source_url: "https://x.com/p/1", source_text: "acme handle posted again" },
      media: { ref: "c.mp4" },
      meta: { time: "2026-07-01T10:00:00Z" },
    });
    persistRecords(c, [watch]);
    const manual = await findingVerb.run(ctxFor(c, "create", ["manual", "observation"], { target: "acme handle" }));
    persistRecords(c, manual, { signals: false });
    const listed = await findingVerb.run(ctxFor(c, "list", [], { state: "triage" }));
    const payload = listed[0].payload as { findings: Array<Record<string, unknown>> };
    assert.equal(payload.findings.length, 2);
    const statuses = payload.findings.map((f) => f.review_status);
    assert.ok(statuses.includes("suggested") && statuses.includes("open"));
    const suggestedRow = payload.findings.find((f) => f.review_status === "suggested");
    assert.equal(suggestedRow?.source_url, "https://x.com/p/1");
    assert.match(String(suggestedRow?.source_excerpt), /acme handle/);
  }));

test("finding accept/dismiss work on suggested roots", () =>
  withCase(async (c) => {
    const [suggested] = persistRecords(c, [faceMatch(90)]);
    const accepted = await findingVerb.run(ctxFor(c, "accept", [suggested.id]));
    persistRecords(c, accepted, { signals: false });
    const listed = await findingVerb.run(ctxFor(c, "list", [], { state: "accepted" }));
    assert.equal((listed[0].payload as { findings: unknown[] }).findings.length, 1);
  }));
