// Mission-board renderer invariants (Bugbot rounds on the brief restructure):
// dismissed findings stay quarantined from thread stories, activity, and the
// delta line; the latest-evidence feed can't be starved by newer findings; and
// the finding→thread text fallback can't false-link machine suggestion copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findingStatusMap, makeRecord, type OvercastRecord } from "../../src/record.ts";
import { briefDelta, threadCard } from "../../src/report/mission.ts";
import { buildThreads } from "../../src/signals/threads.ts";
import type { TargetEntry } from "../../src/state/target.ts";

const NOW = Date.parse("2026-07-02T00:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const target = { id: "tgt_a", value: "acme", kind: "name", created: "2026-07-01T00:00:00Z" } as TargetEntry;

function cardFor(records: OvercastRecord[]) {
  const th = buildThreads(records, [target], NOW)[0];
  return { th, card: threadCard(th, { byId: new Map(records.map((r) => [r.id, r])), statusByFinding: findingStatusMap(records), now: NOW }) };
}

test("threadCard: a dismissed finding never renders back into the thread story", () => {
  const watch = makeRecord({ verb: "watch", payload: { content: "acme at pier" }, media: { ref: "v.mp4" }, meta: { time: iso(3600_000) } });
  const bad = makeRecord({ verb: "finding", payload: { text: "acme false lead", target: "acme", source_record: watch.id, source_verb: "watch", trigger: "signal:text-target", status: "suggested" }, meta: { time: iso(1800_000) } });
  const dismiss = makeRecord({ verb: "finding", payload: { finding_id: bad.id, status: "dismissed", reviewed_at: iso(900_000) }, meta: { time: iso(900_000) } });
  const { th, card } = cardFor([watch, bad, dismiss]);
  // the root stays linked for audit (thread-level dismissed count)…
  assert.ok(th.findingIds.includes(bad.id));
  assert.equal(th.findings.dismissed, 1);
  // …but never renders into the story: no rows, no live counts
  assert.equal(card.findings.length, 0);
  assert.deepEqual(card.findingCounts, { accepted: 0, open: 0, suggested: 0 });
  // …and never drives activity: last activity comes from the watch (1h ago),
  // not from the newer dismissed lead — no "active" read from triage noise
  assert.equal(th.lastActivity, iso(3600_000));
  assert.equal(th.recent.day, 1);
  assert.ok(!th.recentIds.includes(bad.id));
});

test("findingLinksTarget: machine suggestion copy cannot false-link via filenames; declared target is authoritative", () => {
  const vanTarget = { id: "tgt_van", value: "van", kind: "name", created: "2026-07-01T00:00:00Z" } as TargetEntry;
  const acmeTarget = { id: "tgt_acme", value: "acme", kind: "name", created: "2026-07-01T00:00:00Z" } as TargetEntry;
  // an unattributed SCORE lead whose machine text embeds a media basename
  // containing the target value — must NOT attach to the "van" line
  const scoreLead = makeRecord({ verb: "finding", payload: { text: "Reference face matched at 87.0% similarity in white-van-cam.mp4", target: "", source_record: "s1", source_verb: "face", trigger: "signal:face-match", status: "suggested" }, meta: { time: iso(1000) } });
  // a lead DECLARED for acme that happens to mention "van" — must stay on acme
  const declared = makeRecord({ verb: "finding", payload: { text: "acme's van spotted", target: "acme", source_record: "s2", source_verb: "watch", trigger: "signal:text-target", status: "suggested" }, meta: { time: iso(900) } });
  // a human finding naming the value — the text fallback's intended case
  const manual = makeRecord({ verb: "finding", payload: { text: "the van has no rear plate", target: "", source_record: "manual", source_verb: "manual", trigger: "human", status: "open" }, meta: { time: iso(800) } });
  const records = [scoreLead, declared, manual];
  const [van, acme] = buildThreads(records, [vanTarget, acmeTarget], NOW);
  assert.deepEqual(van.findingIds, [manual.id]);
  assert.deepEqual(acme.findingIds, [declared.id]);
});

test("briefDelta: a post-brief create+dismiss is not '+1 finding'", () => {
  const brief = makeRecord({ verb: "brief", payload: { report: "# Brief", synthesis: {} }, meta: { time: iso(7200_000) } });
  const rejected = makeRecord({ verb: "finding", payload: { text: "bogus lead", target: "", source_record: "manual", source_verb: "manual", trigger: "human", status: "open" }, meta: { time: iso(3600_000) } });
  const dismiss = makeRecord({ verb: "finding", payload: { finding_id: rejected.id, status: "dismissed", reviewed_at: iso(1800_000) }, meta: { time: iso(1800_000) } });
  const kept = makeRecord({ verb: "finding", payload: { text: "real lead", target: "", source_record: "manual", source_verb: "manual", trigger: "human", status: "open" }, meta: { time: iso(1200_000) } });
  const delta = briefDelta([brief, rejected, dismiss, kept], NOW);
  assert.match(String(delta), /\+1 finding\b/);
  assert.doesNotMatch(String(delta), /\+2 findings/);
});

test("threadCard: latest evidence survives a burst of newer findings (no recentIds starvation)", () => {
  const watch = makeRecord({ verb: "watch", payload: { content: "acme spotted" }, media: { ref: "v.mp4" }, meta: { time: iso(9 * 3600_000) } });
  const records: OvercastRecord[] = [watch];
  for (let i = 0; i < 8; i++) {
    records.push(makeRecord({ verb: "finding", payload: { text: `acme lead ${i}`, target: "acme", source_record: watch.id, source_verb: "watch", trigger: "human", status: "open" }, meta: { time: iso((8 - i) * 60_000) } }));
  }
  const { th, card } = cardFor(records);
  // the mixed recency list saturates with the 8 newer findings…
  assert.ok(th.recentIds.every((id) => id !== watch.id));
  // …but the evidence-only feed still surfaces the older watch record
  assert.equal(card.latest.length, 1);
  assert.equal(card.latest[0].id, watch.id);
});
