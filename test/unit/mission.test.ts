// Mission-board renderer invariants (Bugbot round on the brief restructure):
// dismissed findings stay quarantined from thread stories, and the latest-
// evidence feed can't be starved by a burst of newer findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findingStatusMap, makeRecord, type OvercastRecord } from "../../src/record.ts";
import { threadCard } from "../../src/report/mission.ts";
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
