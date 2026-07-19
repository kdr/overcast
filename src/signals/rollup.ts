/**
 * Timeline rollups — collapse a fan-out of records into digestible groups so a
 * brief's record trail reads as "one artifact, five looks" instead of dozens of
 * loose rows. Pure derivation, no I/O.
 *
 * Grouping precedence (each record joins the first that applies):
 *  1. shared media.ref → an "artifact" group (the clip/image + every sense/crop
 *     record on it), reusing the wall's ref-grouping idea;
 *  2. provenance source_record → fold a match/crop/finding into its parent
 *     artifact group when it cites one;
 *  3. otherwise a singleton "record" group.
 *
 * meta.run (a per-scan/monitor run id) is an OPTIONAL first key: when present it
 * wins, so a whole sweep collapses to one "sweep" group. Records without it fall
 * through to the media-chain rules — so this works today without stamping runs.
 */
import { recordTimeMs, stripUrlTail, type OvercastRecord } from "../record.js";

export interface TimelineGroup {
  key: string;
  kind: "sweep" | "artifact" | "record";
  title: string;
  /** per-verb counts inside the group */
  counts: Record<string, number>;
  /** newest record time in the group (ISO), or undefined */
  time?: string;
  /** ids of the grouped records, chronological */
  recordIds: string[];
}

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
}

function timeMs(r: OvercastRecord): number {
  const t = recordTimeMs(r);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function baseName(ref: string): string {
  const parts = stripUrlTail(ref).split(/[\\/]/);
  return parts[parts.length - 1] || ref;
}

/** The grouping key + kind for a record: run > media.ref > source_record > self. */
function keyFor(r: OvercastRecord, refByRecordId: Map<string, string>): { key: string; kind: TimelineGroup["kind"] } {
  const run = r.meta?.run;
  if (typeof run === "string" && run) return { key: `run:${run}`, kind: "sweep" };
  if (r.media?.ref) return { key: `ref:${r.media.ref}`, kind: "artifact" };
  const src = payloadOf(r).source_record;
  if (typeof src === "string" && refByRecordId.has(src)) return { key: `ref:${refByRecordId.get(src)}`, kind: "artifact" };
  return { key: `rec:${r.id}`, kind: "record" };
}

/** Group a chronological record list into digestible timeline groups. */
export function groupTimeline(records: OvercastRecord[]): TimelineGroup[] {
  // first pass: map record id → its media.ref, so a child citing a parent by
  // source_record can join the parent's artifact group.
  const refByRecordId = new Map<string, string>();
  for (const r of records) if (r.media?.ref) refByRecordId.set(r.id, r.media.ref);

  const groups = new Map<string, TimelineGroup>();
  const order: string[] = [];
  for (const r of records) {
    const { key, kind } = keyFor(r, refByRecordId);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind, title: titleFor(kind, key), counts: {}, recordIds: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.counts[r.verb] = (g.counts[r.verb] ?? 0) + 1;
    g.recordIds.push(r.id);
    const t = timeMs(r);
    if (Number.isFinite(t)) {
      const prev = g.time ? Date.parse(g.time) : Number.NEGATIVE_INFINITY;
      if (t > prev) g.time = new Date(t).toISOString();
    }
  }
  return order.map((k) => groups.get(k)!);
}

function titleFor(kind: TimelineGroup["kind"], key: string): string {
  if (kind === "sweep") return `sweep ${key.slice("run:".length)}`;
  if (kind === "artifact") return baseName(key.slice("ref:".length));
  return key.slice("rec:".length);
}

/** A one-line "verb ×n, verb ×n" summary of a group's contents. */
export function groupSummary(g: TimelineGroup): string {
  return Object.entries(g.counts)
    .sort()
    .map(([verb, n]) => (n === 1 ? verb : `${verb} ×${n}`))
    .join(", ");
}
