import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { groupTimeline, groupSummary } from "../../src/signals/rollup.ts";

test("groupTimeline: records on the same media.ref collapse into one artifact group", () => {
  const watch = makeRecord({ verb: "watch", format: "json", payload: { content: "x" }, media: { ref: "clip.mp4" }, meta: { time: "2026-06-20T10:00:00Z" } });
  const listen = makeRecord({ verb: "listen", format: "json", payload: { transcript: "y" }, media: { ref: "clip.mp4" }, meta: { time: "2026-06-20T10:01:00Z" } });
  const face = makeRecord({ verb: "face", format: "json", payload: { op: "match" }, media: { ref: "clip.mp4" }, meta: { time: "2026-06-20T10:02:00Z" } });
  const groups = groupTimeline([watch, listen, face]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "artifact");
  assert.equal(groups[0].title, "clip.mp4");
  assert.deepEqual(groups[0].counts, { watch: 1, listen: 1, face: 1 });
  assert.equal(groups[0].time, "2026-06-20T10:02:00.000Z");
});

test("groupTimeline: a child citing a parent by source_record folds into the parent artifact", () => {
  const face = makeRecord({ verb: "face", format: "json", payload: { op: "match" }, media: { ref: "clip.mp4" }, meta: { time: "2026-06-20T10:00:00Z" } });
  // a crop record has no media.ref of its own but cites the face record
  const crop = makeRecord({ verb: "crop", format: "json", payload: { source_record: face.id }, meta: { time: "2026-06-20T10:03:00Z" } });
  const groups = groupTimeline([face, crop]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].counts, { face: 1, crop: 1 });
});

test("groupTimeline: meta.run wins — a whole sweep collapses to one group", () => {
  const a = makeRecord({ verb: "scan", format: "json", payload: { url: "u1" }, media: { ref: "a.mp4" }, meta: { time: "2026-06-20T10:00:00Z", run: "run_abc" } });
  const b = makeRecord({ verb: "watch", format: "json", payload: { content: "z" }, media: { ref: "b.mp4" }, meta: { time: "2026-06-20T10:01:00Z", run: "run_abc" } });
  const groups = groupTimeline([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "sweep");
  assert.match(groups[0].title, /^sweep run_abc/);
});

test("groupTimeline: refless unrelated records stay singletons; order preserved", () => {
  const n1 = makeRecord({ verb: "note", format: "json", payload: { text: "a" }, meta: { time: "2026-06-20T10:00:00Z" } });
  const n2 = makeRecord({ verb: "note", format: "json", payload: { text: "b" }, meta: { time: "2026-06-20T10:01:00Z" } });
  const groups = groupTimeline([n1, n2]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.kind === "record"));
  assert.deepEqual(groups.map((g) => g.recordIds[0]), [n1.id, n2.id]);
});

test("groupSummary: verb ×n formatting", () => {
  const g = { key: "ref:x", kind: "artifact" as const, title: "x", counts: { watch: 1, crop: 3 }, recordIds: [] };
  assert.equal(groupSummary(g), "crop ×3, watch");
});
