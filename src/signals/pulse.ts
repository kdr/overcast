/**
 * Case pulse — the derived "how is this investigation doing" signal bundle that
 * status + brief render and wall's HUD reuses. Pure over the record store + state
 * registries (no I/O). The freshness primitives (sourceScanFreshness, latestTimed)
 * are the single source of truth for scan/monitor/brief recency — wall imports
 * them so its HUD can't drift from status.
 */
import { findingStatusMap, isMemoryRecord, isReady, recordTimeMs, type OvercastRecord } from "../record.js";
import { isRootFindingRecord } from "../verbs/finding.js";
import { buildThreads, threadsHeadline, type TargetThread } from "./threads.js";
import type { TargetEntry } from "../state/target.js";
import { isTargetClosed } from "../state/target.js";
import type { SourceEntry } from "../state/source.js";

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
}

function timeMs(r: OvercastRecord): number {
  const t = recordTimeMs(r);
  return Number.isNaN(t) ? NaN : t;
}

export interface ScanFreshness {
  source: string;
  time: string;
  ageSeconds: number;
}

/** Last successful scan per source label (payload.source), newest first. Ready
 *  rows only — a failed/cred-blocked sweep must not read as fresh. Excludes the
 *  op:pull_progress running-aggregate rows. Shared by wall's HUD and casePulse. */
export function sourceScanFreshness(records: OvercastRecord[], now: number): ScanFreshness[] {
  const scanTimes = new Map<string, number>();
  for (const r of records) {
    if (r.verb !== "scan" || !isReady(r)) continue;
    const p = payloadOf(r);
    if (p.op === "pull_progress") continue;
    const t = timeMs(r);
    if (Number.isNaN(t)) continue;
    const source = typeof p.source === "string" && p.source ? p.source : "scan";
    if (t > (scanTimes.get(source) ?? Number.NEGATIVE_INFINITY)) scanTimes.set(source, t);
  }
  return [...scanTimes.entries()]
    .map(([source, t]) => ({ source, time: new Date(t).toISOString(), ageSeconds: Math.max(0, (now - t) / 1000) }))
    .sort((a, b) => a.ageSeconds - b.ageSeconds);
}

/** Newest ready record of a verb + its parsed epoch-ms time. */
export function latestTimed(records: OvercastRecord[], verb: string): { rec: OvercastRecord; t: number } | undefined {
  let best: { rec: OvercastRecord; t: number } | undefined;
  for (const rec of records) {
    if (rec.verb !== verb || !isReady(rec)) continue;
    const t = timeMs(rec);
    if (Number.isNaN(t)) continue;
    if (!best || t > best.t) best = { rec, t };
  }
  return best;
}

/** One grabbed media item attributed to a source (capture provenance). */
export interface SourceMediaItem {
  /** capture record id */
  record: string;
  /** local media path (or the capture record id when no ref was stored) */
  ref: string;
  title?: string;
  /** ≥1 ready sense record exists over this media */
  sensed: boolean;
}

export interface SourceCoverage {
  id: string;
  spec: string;
  type: string;
  enabled: boolean;
  lastScanAgeSeconds: number | null;
  hits: number;
  captured: number;
  sensed: number;
  /** enabled source that has never produced a ready scan hit */
  gap: boolean;
  /** grabbed media attributed to this source, newest-first (capped) */
  media: SourceMediaItem[];
}

export interface TriageCounts {
  suggested: number;
  open: number;
  accepted: number;
  dismissed: number;
}

export interface CasePulse {
  headline: string;
  threads: TargetThread[];
  progress: {
    targets_total: number;
    targets_open: number;
    targets_answered: number;
    targets_dead: number;
    open_findings: number;
    accepted_findings: number;
    triage_pending: number;
  };
  triage: TriageCounts;
  coverage: SourceCoverage[];
  media: { captured: number; sensed: number; unsensed: number };
  freshness: {
    lastScans: ScanFreshness[];
    lastScanAgeSeconds: number | null;
    monitor: { time: string; ageSeconds: number; newItems: number } | null;
    briefAgeSeconds: number | null;
  };
  gaps: string[];
}

// One definition of "sensed/analyzed" media — the single source for every
// funnel that counts senses: this coverage funnel, the thread funnel
// (src/signals/threads.ts imports it), and the vscode extension's
// analyzed-media rollup (vscode/src/lib/analyzedMedia.ts mirrors it; keep that
// copy in lockstep or the funnel and the sidebar disagree about the same ref).
export const SENSE_VERBS = new Set(["watch", "listen", "see", "face", "image", "similar", "cluster", "audio", "voice", "crop", "enhance", "exif", "verify"]);

/** Triage buckets over root findings, by effective (reviewed) status. */
export function triageCounts(records: OvercastRecord[]): TriageCounts {
  const statusMap = findingStatusMap(records);
  const out: TriageCounts = { suggested: 0, open: 0, accepted: 0, dismissed: 0 };
  for (const f of records.filter(isRootFindingRecord)) {
    const s = (statusMap.get(f.id) ?? "open") as keyof TriageCounts;
    if (s in out) out[s] += 1;
  }
  return out;
}

/** The set of media refs that have ≥1 ready sense record. */
function sensedRefs(records: OvercastRecord[]): Set<string> {
  const refs = new Set<string>();
  for (const r of records) {
    if (SENSE_VERBS.has(r.verb) && isReady(r) && r.media?.ref) refs.add(r.media.ref);
  }
  return refs;
}

/** Whether a scan hit's payload attributes to a configured source: exact match
 *  on the stamped source_id (the pipeline stamps it at enumerate time), else
 *  the platform-type fallback ONLY when that type has a single configured
 *  source — legacy/adhoc hits mustn't read "never scanned" without
 *  over-attributing an ambiguous hit to every same-type source. The ONE
 *  attribution rule, shared by buildCoverage and unattributedScanHits so the
 *  coverage table's configured and ad-hoc rows can never double-count a hit. */
function hitMatchesSource(p: Record<string, unknown>, src: { id: string; type: string }, uniqueOfType: boolean): boolean {
  if (typeof p.source_id === "string") return p.source_id === src.id;
  return uniqueOfType && typeof p.source === "string" && p.source === src.type;
}

/** Ready scan hits carrying a url (the swept set), excluding progress rows. */
function scanHitRecords(records: OvercastRecord[]): OvercastRecord[] {
  return records.filter((r) => {
    if (r.verb !== "scan" || !isReady(r)) return false;
    const p = payloadOf(r);
    if (p.op === "pull_progress") return false;
    return typeof p.url === "string" && p.url.length > 0;
  });
}

/** Swept hits NOT attributable to any configured source, rolled up by their
 *  scan label — the coverage table's ad-hoc rows. Complements buildCoverage's
 *  per-source rows via the SAME hitMatchesSource rule (label arithmetic would
 *  double-count a hit whose `source` label differs from its source's type). */
export function unattributedScanHits(records: OvercastRecord[], sources: Array<{ id: string; type: string }>): Array<{ source: string; hits: number }> {
  const typeCount = new Map<string, number>();
  for (const s of sources) typeCount.set(s.type, (typeCount.get(s.type) ?? 0) + 1);
  const bySource = new Map<string, number>();
  for (const r of scanHitRecords(records)) {
    const p = payloadOf(r);
    const attributed = sources.some((src) => hitMatchesSource(p, src, (typeCount.get(src.type) ?? 0) === 1));
    if (attributed) continue;
    const label = typeof p.source === "string" && p.source ? p.source : "unknown";
    bySource.set(label, (bySource.get(label) ?? 0) + 1);
  }
  return [...bySource].map(([source, hits]) => ({ source, hits }));
}

/** Per-source coverage funnel: configured sources joined to their scan hits,
 *  captures (via source_id → hit → capture provenance), and sensed media. */
function buildCoverage(records: OvercastRecord[], sources: SourceEntry[], now: number): SourceCoverage[] {
  const sensed = sensedRefs(records);
  const captures = records.filter((r) => r.verb === "capture" && isReady(r));
  // how many enabled sources share each platform type (see hitMatchesSource)
  const typeCount = new Map<string, number>();
  for (const s of sources) typeCount.set(s.type, (typeCount.get(s.type) ?? 0) + 1);

  return sources.map((src) => {
    const uniqueOfType = (typeCount.get(src.type) ?? 0) === 1;
    const hitRecords = scanHitRecords(records).filter((r) => hitMatchesSource(payloadOf(r), src, uniqueOfType));
    const hitIds = new Set(hitRecords.map((r) => r.id));
    const captured = captures.filter((c) => {
      const p = payloadOf(c);
      return typeof p.source_record === "string" && hitIds.has(p.source_record);
    });
    const sensedCount = new Set(
      captured
        .map((c) => c.media?.ref ?? (typeof payloadOf(c).path === "string" ? (payloadOf(c).path as string) : undefined))
        .filter((ref): ref is string => !!ref && sensed.has(ref)),
    ).size;
    // The grabbed-media items behind the `captured` count, newest-first (the
    // sidebar's per-source media children). Capped: coverage rides every
    // status/brief payload.
    const hitTitleById = new Map(hitRecords.map((r) => [r.id, payloadOf(r).title]));
    const mediaItems: SourceMediaItem[] = captured
      .slice()
      .sort((a, b) => (timeMs(b) || 0) - (timeMs(a) || 0))
      .slice(0, 50)
      .map((c) => {
        const p = payloadOf(c);
        const ref = c.media?.ref ?? (typeof p.path === "string" ? p.path : c.id);
        const title = typeof p.title === "string" && p.title ? p.title : hitTitleById.get(p.source_record as string);
        return {
          record: c.id,
          ref,
          ...(typeof title === "string" && title ? { title } : {}),
          sensed: sensed.has(ref),
        };
      });
    // per-SOURCE freshness: newest of THIS source's own hit records (source_id),
    // not the platform-shared freshness — two x:@a / x:@b sources must not share
    // an age just because they're the same platform.
    const lastHitMs = Math.max(Number.NEGATIVE_INFINITY, ...hitRecords.map(timeMs).filter((t) => !Number.isNaN(t)));
    const age = Number.isFinite(lastHitMs) ? Math.max(0, (now - lastHitMs) / 1000) : null;
    return {
      id: src.id,
      spec: `${src.type}:${src.ref}`,
      type: src.type,
      enabled: src.enabled,
      lastScanAgeSeconds: age,
      hits: hitRecords.length,
      captured: captured.length,
      sensed: sensedCount,
      gap: src.enabled && hitRecords.length === 0,
      media: mediaItems,
    };
  });
}

export interface CasePulseInput {
  records: OvercastRecord[];
  targets: TargetEntry[];
  sources: SourceEntry[];
  now?: number;
}

/** Assemble the full case pulse. `now` injectable for deterministic tests. */
export function casePulse(input: CasePulseInput): CasePulse {
  const now = input.now ?? Date.now();
  const { records, targets, sources } = input;

  const threads = buildThreads(records, targets, now);
  const triage = triageCounts(records);
  const coverage = buildCoverage(records, sources, now);

  const captures = records.filter((r) => r.verb === "capture" && isReady(r));
  const sensed = sensedRefs(records);
  const capturedRefs = new Set(captures.map((c) => c.media?.ref ?? (typeof payloadOf(c).path === "string" ? (payloadOf(c).path as string) : c.id)));
  const sensedCaptured = [...capturedRefs].filter((ref) => sensed.has(ref)).length;

  const lastScans = sourceScanFreshness(records, now);
  const monitorLatest = latestTimed(records, "monitor");
  const briefLatest = latestTimed(records, "brief");
  const newItems = monitorLatest ? payloadOf(monitorLatest.rec).new_items : undefined;

  const gaps: string[] = [];
  for (const c of coverage) if (c.gap) gaps.push(`${c.spec} enabled but never scanned`);
  const unsensed = captures.length - sensedCaptured;
  if (unsensed > 0) gaps.push(`${unsensed} capture${unsensed === 1 ? "" : "s"} pulled but never sensed`);

  const answered = targets.filter((t) => t.status === "answered").length;
  const dead = targets.filter((t) => t.status === "dead-end").length;

  return {
    headline: threadsHeadline(threads, triage.suggested),
    threads,
    progress: {
      targets_total: targets.length,
      targets_open: targets.filter((t) => !isTargetClosed(t)).length,
      targets_answered: answered,
      targets_dead: dead,
      open_findings: triage.open,
      accepted_findings: triage.accepted,
      triage_pending: triage.suggested,
    },
    triage,
    coverage,
    media: { captured: captures.length, sensed: sensedCaptured, unsensed: Math.max(0, unsensed) },
    freshness: {
      lastScans,
      lastScanAgeSeconds: lastScans.length ? lastScans[0].ageSeconds : null,
      monitor: monitorLatest
        ? { time: new Date(monitorLatest.t).toISOString(), ageSeconds: Math.max(0, (now - monitorLatest.t) / 1000), newItems: typeof newItems === "number" ? newItems : 0 }
        : null,
      briefAgeSeconds: briefLatest ? Math.max(0, (now - briefLatest.t) / 1000) : null,
    },
    gaps,
  };
}
