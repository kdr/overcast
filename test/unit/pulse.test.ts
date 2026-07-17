import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { casePulse, triageCounts, sourceScanFreshness } from "../../src/signals/pulse.ts";
import type { TargetEntry } from "../../src/state/target.ts";
import type { SourceEntry } from "../../src/state/source.ts";

const NOW = Date.parse("2026-07-02T00:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3600_000;

function source(over: Partial<SourceEntry> & { id: string }): SourceEntry {
  return { type: "web", ref: "q", enabled: true, created: "2026-07-01T00:00:00Z", ...over };
}

test("sourceScanFreshness: newest ready scan per source, pull_progress + failures excluded", () => {
  const records: OvercastRecord[] = [
    makeRecord({ verb: "scan", format: "json", payload: { source: "web", url: "u1" }, meta: { time: iso(5 * HOUR) } }),
    makeRecord({ verb: "scan", format: "json", payload: { source: "web", url: "u2" }, meta: { time: iso(1 * HOUR) } }),
    makeRecord({ verb: "scan", format: "json", payload: { source: "web", op: "pull_progress" }, meta: { time: iso(1000) } }),
    makeRecord({ verb: "scan", format: "json", payload: { source: "youtube" }, error: "boom", state: "error", meta: { time: iso(1000) } }),
  ];
  const fresh = sourceScanFreshness(records, NOW);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].source, "web");
  assert.equal(Math.round(fresh[0].ageSeconds), HOUR / 1000);
});

test("triageCounts: buckets by effective status", () => {
  const open = makeRecord({ verb: "finding", format: "json", payload: { text: "a", target: "", source_record: "x", source_verb: "watch", trigger: "human", status: "open" } });
  const suggested = makeRecord({ verb: "finding", format: "json", payload: { text: "b", target: "", source_record: "y", source_verb: "face", trigger: "signal:face-match", status: "suggested" } });
  const accept = makeRecord({ verb: "finding", format: "json", payload: { finding_id: suggested.id, status: "accepted", reviewed_at: iso(0) } });
  const t = triageCounts([open, suggested, accept]);
  assert.equal(t.open, 1);
  assert.equal(t.accepted, 1);
  assert.equal(t.suggested, 0); // promoted
});

test("casePulse: coverage funnel joins source → hits → captures → sensed", () => {
  const src = source({ id: "src_a", type: "web", ref: "pier" });
  const hit = makeRecord({ verb: "scan", format: "json", payload: { source: "web", source_id: "src_a", url: "http://x/1" }, meta: { time: iso(2 * HOUR) } });
  const cap = makeRecord({ verb: "capture", format: "json", payload: { path: "c.mp4", source_record: hit.id }, media: { ref: "c.mp4" }, meta: { time: iso(1 * HOUR) } });
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "scene" }, media: { ref: "c.mp4" }, meta: { time: iso(30 * 60 * 1000) } });
  const pulse = casePulse({ records: [hit, cap, watch], targets: [], sources: [src], now: NOW });
  const cov = pulse.coverage[0];
  assert.equal(cov.hits, 1);
  assert.equal(cov.captured, 1);
  assert.equal(cov.sensed, 1);
  assert.equal(cov.gap, false);
  assert.equal(pulse.media.captured, 1);
  assert.equal(pulse.media.sensed, 1);
  assert.equal(pulse.media.unsensed, 0);
});

test("casePulse: coverage rows carry the grabbed media items behind the counts", () => {
  const src = source({ id: "src_a", type: "web", ref: "pier" });
  const hit = makeRecord({ verb: "scan", format: "json", payload: { source: "web", source_id: "src_a", url: "http://x/1", title: "Pier cam clip" }, meta: { time: iso(3 * HOUR) } });
  const capOld = makeRecord({ verb: "capture", format: "json", payload: { path: "old.mp4", source_record: hit.id }, media: { ref: "old.mp4" }, meta: { time: iso(2 * HOUR) } });
  const capNew = makeRecord({ verb: "capture", format: "json", payload: { path: "new.mp4", source_record: hit.id }, media: { ref: "new.mp4" }, meta: { time: iso(1 * HOUR) } });
  const adhocCap = makeRecord({ verb: "capture", format: "json", payload: { path: "stray.mp4" }, media: { ref: "stray.mp4" }, meta: { time: iso(HOUR) } });
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "scene" }, media: { ref: "new.mp4" }, meta: { time: iso(30 * 60 * 1000) } });
  const pulse = casePulse({ records: [hit, capOld, capNew, adhocCap, watch], targets: [], sources: [src], now: NOW });
  const media = pulse.coverage[0].media;
  assert.equal(media.length, 2); // the unattributed capture stays out
  // newest-first, sensed flags per ref, title lifted from the source hit
  assert.deepEqual(media[0], { record: capNew.id, ref: "new.mp4", title: "Pier cam clip", sensed: true });
  assert.deepEqual(media[1], { record: capOld.id, ref: "old.mp4", title: "Pier cam clip", sensed: false });
});

test("casePulse: per-source freshness uses the source's OWN hits, not the platform", () => {
  // two X sources scanned at different times must not share a freshness age
  const a = source({ id: "src_a", type: "x", ref: "@old" });
  const b = source({ id: "src_b", type: "x", ref: "@new" });
  const hitOld = makeRecord({ verb: "scan", format: "json", payload: { source: "x", source_id: "src_a", url: "http://x/old" }, meta: { time: iso(5 * HOUR) } });
  const hitNew = makeRecord({ verb: "scan", format: "json", payload: { source: "x", source_id: "src_b", url: "http://x/new" }, meta: { time: iso(1 * HOUR) } });
  const pulse = casePulse({ records: [hitOld, hitNew], targets: [], sources: [a, b], now: NOW });
  const covA = pulse.coverage.find((c) => c.id === "src_a")!;
  const covB = pulse.coverage.find((c) => c.id === "src_b")!;
  assert.equal(Math.round(covA.lastScanAgeSeconds!), (5 * HOUR) / 1000);
  assert.equal(Math.round(covB.lastScanAgeSeconds!), (1 * HOUR) / 1000);
  assert.notEqual(covA.lastScanAgeSeconds, covB.lastScanAgeSeconds);
});

test("casePulse: coverage counts scan hits lacking source_id via platform-type fallback", () => {
  // a legacy/adhoc hit with no source_id must still attribute to its platform's
  // enabled source — not read as "never scanned"
  const src = source({ id: "src_w", type: "web", ref: "pier" });
  const unstamped = makeRecord({ verb: "scan", format: "json", payload: { source: "web", url: "http://x/1" }, meta: { time: iso(HOUR) } });
  const pulse = casePulse({ records: [unstamped], targets: [], sources: [src], now: NOW });
  const cov = pulse.coverage[0];
  assert.equal(cov.hits, 1);
  assert.equal(cov.gap, false);
  assert.equal(Math.round(cov.lastScanAgeSeconds!), HOUR / 1000);
});

test("casePulse: an unstamped hit is NOT attributed when the type has multiple sources", () => {
  // two web sources: an unstamped web hit is ambiguous, so it must attribute to
  // neither (attributing to both would double-count + falsely clear gaps)
  const a = source({ id: "src_a", type: "web", ref: "q1" });
  const b = source({ id: "src_b", type: "web", ref: "q2" });
  const unstamped = makeRecord({ verb: "scan", format: "json", payload: { source: "web", url: "http://x/1" }, meta: { time: iso(HOUR) } });
  const pulse = casePulse({ records: [unstamped], targets: [], sources: [a, b], now: NOW });
  assert.equal(pulse.coverage.find((c) => c.id === "src_a")!.hits, 0);
  assert.equal(pulse.coverage.find((c) => c.id === "src_b")!.hits, 0);
  // both remain gaps (neither can claim the ambiguous hit)
  assert.ok(pulse.coverage.every((c) => c.gap));
});

test("casePulse: enabled-but-never-scanned source is a coverage gap", () => {
  const src = source({ id: "src_b", type: "x", ref: "@h" });
  const pulse = casePulse({ records: [], targets: [], sources: [src], now: NOW });
  assert.equal(pulse.coverage[0].gap, true);
  assert.ok(pulse.gaps.some((g) => g.includes("x:@h enabled but never scanned")));
});

test("casePulse: unsensed captures surface as a backlog gap", () => {
  const cap = makeRecord({ verb: "capture", format: "json", payload: { path: "c.mp4" }, media: { ref: "c.mp4" }, meta: { time: iso(HOUR) } });
  const pulse = casePulse({ records: [cap], targets: [], sources: [], now: NOW });
  assert.equal(pulse.media.unsensed, 1);
  assert.ok(pulse.gaps.some((g) => /1 capture pulled but never sensed/.test(g)));
});

test("casePulse: progress + headline reflect targets and triage", () => {
  const targets: TargetEntry[] = [
    { id: "tgt_a", kind: "name", value: "acme", created: iso(0) },
    { id: "tgt_b", kind: "name", value: "beta", created: iso(0), status: "answered" },
  ];
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "acme spotted" }, media: { ref: "v.mp4" }, meta: { time: iso(HOUR) } });
  const suggested = makeRecord({ verb: "finding", format: "json", payload: { text: "lead", target: "acme", target_id: "tgt_a", source_record: "x", source_verb: "face", trigger: "signal:face-match", status: "suggested" }, meta: { time: iso(HOUR) } });
  const pulse = casePulse({ records: [watch, suggested], targets, sources: [], now: NOW });
  assert.equal(pulse.progress.targets_total, 2);
  assert.equal(pulse.progress.targets_open, 1);
  assert.equal(pulse.progress.targets_answered, 1);
  assert.equal(pulse.progress.triage_pending, 1);
  assert.match(pulse.headline, /1 line active/);
  assert.match(pulse.headline, /1 answered/);
  assert.match(pulse.headline, /1 suggestion awaiting triage/);
});
