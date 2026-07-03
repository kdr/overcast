/**
 * Threads — a "line of investigation" is a target, viewed through the evidence,
 * findings, and notes linked to it. Pure derivation over the record store (no
 * I/O), so brief + status render the same struct.
 *
 * Linking (priority order, all derived — no new persisted links):
 *  1. findings by payload.target_id === target.id, or payload.target === value;
 *  2. name/prompt targets: evidence records whose text contains the value
 *     (targetMatchesEvidence — the same matcher the text-target trigger uses);
 *  3. image targets: face/image/similar/cluster records referencing the value;
 *  4. notes tagged `thread:<tgt_id>` (the /debrief convention).
 *
 * Stage — the honest goal-progress ordinal (no fake %):
 *   answered / dead-end  ← analyst declared via `target close`
 *   corroborated         ← ≥1 accepted finding linked
 *   leads                ← ≥1 open/suggested finding linked
 *   collecting           ← ≥1 evidence record linked
 *   cold                 ← nothing linked yet
 */
import { findingStatusMap, isMemoryRecord, isReady, type OvercastRecord } from "../record.js";
import { isRootFindingRecord } from "../verbs/finding.js";
import { targetMatchesEvidence, payloadText } from "./triggers.js";
import { targetStatus, type TargetEntry } from "../state/target.js";

export type ThreadStage = "answered" | "dead-end" | "corroborated" | "leads" | "collecting" | "cold";

/** Display labels for the thread stages — shared by brief + status renderers. */
export const THREAD_STAGE_LABEL: Record<ThreadStage, string> = {
  answered: "ANSWERED",
  "dead-end": "DEAD-END",
  corroborated: "CORROBORATED",
  leads: "LEADS",
  collecting: "COLLECTING",
  cold: "COLD",
};

export interface ThreadFindingCounts {
  suggested: number;
  open: number;
  accepted: number;
  dismissed: number;
}

export interface TargetThread {
  id: string;
  value: string;
  kind: TargetEntry["kind"];
  question?: string;
  status: "active" | "answered" | "dead-end";
  status_note?: string;
  stage: ThreadStage;
  /** per-evidence-verb counts of linked records (findings excluded) */
  evidence: Record<string, number>;
  /** rolled-up funnel numbers for the one-line thread summary */
  funnel: { scan: number; captures: number; senses: number; matches: number };
  findings: ThreadFindingCounts;
  /** newest linked-activity timestamp (ISO), or undefined when cold */
  lastActivity?: string;
  /** count of linked evidence records in the last 24h / 7d — the momentum read */
  recent: { day: number; week: number };
  /** ≤8 activity bins (oldest→newest) of linked-record counts, for a sparkline */
  activityBins: number[];
  /** ids of the most recent linked records (evidence + findings), newest first */
  recentIds: string[];
  /** a short "why" for a dead/answered line, else undefined */
  why?: string;
  /** newest `thread:<id>`-tagged note text — the analyst's line narrative from
   *  `/debrief`, surfaced on the brief/status thread cards */
  narrative?: string;
}

const SENSE_VERBS = new Set(["watch", "listen", "see", "face", "image", "similar", "cluster", "crop", "enhance"]);
const MATCH_VERBS = new Set(["face", "image", "similar", "cluster"]);

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
}

function timeOf(r: OvercastRecord): number {
  const t = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function baseName(ref: string): string {
  const parts = ref.replace(/[?#].*$/, "").split(/[\\/]/);
  return (parts[parts.length - 1] || ref).toLowerCase();
}

/** Does a match/reference record point at an image target's ref? */
function referencesImageTarget(rec: OvercastRecord, value: string): boolean {
  const p = payloadOf(rec);
  const candidates = [p.reference, p.query, p.input, p.file, rec.media?.ref].filter((x): x is string => typeof x === "string");
  const target = baseName(value);
  return candidates.some((c) => c === value || baseName(c) === target);
}

/** notes tagged `thread:<tgt_id>` — the /debrief per-thread narrative anchor. */
function noteTaggedForThread(rec: OvercastRecord, targetId: string): boolean {
  if (rec.verb !== "note") return false;
  const tags = payloadOf(rec).tags;
  return Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === `thread:${targetId.toLowerCase()}`);
}

/** Whether a (non-finding) evidence record links to a target. */
function evidenceLinksTarget(rec: OvercastRecord, target: TargetEntry): boolean {
  if (noteTaggedForThread(rec, target.id)) return true;
  if (target.kind === "image") {
    return MATCH_VERBS.has(rec.verb) && referencesImageTarget(rec, target.value);
  }
  return targetMatchesEvidence(target.value, payloadText(rec));
}

function findingLinksTarget(finding: OvercastRecord, target: TargetEntry): boolean {
  const p = payloadOf(finding);
  if (typeof p.target_id === "string" && p.target_id === target.id) return true;
  return typeof p.target === "string" && p.target.length > 0 && p.target === target.value;
}

function stageFor(status: "active" | "answered" | "dead-end", findings: ThreadFindingCounts, evidenceCount: number): ThreadStage {
  if (status === "answered") return "answered";
  if (status === "dead-end") return "dead-end";
  if (findings.accepted > 0) return "corroborated";
  if (findings.open > 0 || findings.suggested > 0) return "leads";
  if (evidenceCount > 0) return "collecting";
  return "cold";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Bucket linked-record timestamps into `bins` bins spanning first→now. */
function activityBins(times: number[], now: number, bins = 8): number[] {
  const out = new Array(bins).fill(0);
  const dated = times.filter((t) => t > 0);
  if (!dated.length) return out;
  const first = Math.min(...dated);
  const span = Math.max(now - first, 1);
  for (const t of dated) {
    const idx = Math.min(bins - 1, Math.floor(((t - first) / span) * bins));
    out[idx] += 1;
  }
  return out;
}

/** Build the per-target thread views. `now` is injectable for deterministic tests. */
export function buildThreads(records: OvercastRecord[], targets: TargetEntry[], now = Date.now()): TargetThread[] {
  const statusMap = findingStatusMap(records);
  const findings = records.filter(isRootFindingRecord);
  // non-finding evidence candidates (memory-eligible, excludes operational/meta)
  const evidence = records.filter((r) => r.verb !== "finding" && isMemoryRecord(r));

  return targets.map((target) => {
    const status = targetStatus(target);
    const linkedEvidence = evidence.filter((r) => evidenceLinksTarget(r, target));
    const linkedFindings = findings.filter((f) => findingLinksTarget(f, target));

    const counts: ThreadFindingCounts = { suggested: 0, open: 0, accepted: 0, dismissed: 0 };
    for (const f of linkedFindings) {
      const s = (statusMap.get(f.id) ?? "open") as keyof ThreadFindingCounts;
      if (s in counts) counts[s] += 1;
    }

    const evidenceByVerb: Record<string, number> = {};
    for (const r of linkedEvidence) evidenceByVerb[r.verb] = (evidenceByVerb[r.verb] ?? 0) + 1;

    const funnel = {
      scan: linkedEvidence.filter((r) => r.verb === "scan").length,
      captures: linkedEvidence.filter((r) => r.verb === "capture").length,
      senses: linkedEvidence.filter((r) => SENSE_VERBS.has(r.verb)).length,
      matches: linkedEvidence.filter((r) => MATCH_VERBS.has(r.verb)).length,
    };

    // activity = linked evidence + linked findings (leads count as activity)
    const activity = [...linkedEvidence, ...linkedFindings];
    const times = activity.map(timeOf);
    const lastMs = times.length ? Math.max(...times) : 0;
    const recentDay = times.filter((t) => t > 0 && now - t <= DAY_MS).length;
    const recentWeek = times.filter((t) => t > 0 && now - t <= WEEK_MS).length;

    const recentIds = [...activity]
      .sort((a, b) => timeOf(b) - timeOf(a))
      .slice(0, 8)
      .map((r) => r.id);

    const stage = stageFor(status, counts, linkedEvidence.length);
    const why = status === "active"
      ? undefined
      : target.status_note ?? (status === "answered" ? "closed as answered" : "closed as dead end");

    // newest `thread:<id>` note = the analyst's line narrative (from /debrief)
    const narrative = [...linkedEvidence]
      .filter((r) => noteTaggedForThread(r, target.id))
      .sort((a, b) => timeOf(b) - timeOf(a))
      .map((r) => {
        const t = payloadOf(r).text;
        return typeof t === "string" && t.trim() ? t.trim() : undefined;
      })
      .find(Boolean);

    return {
      id: target.id,
      value: target.value,
      kind: target.kind,
      question: target.question,
      status,
      status_note: target.status_note,
      stage,
      evidence: evidenceByVerb,
      funnel,
      findings: counts,
      lastActivity: lastMs ? new Date(lastMs).toISOString() : undefined,
      recent: { day: recentDay, week: recentWeek },
      activityBins: activityBins(times, now),
      recentIds,
      why,
      narrative,
    };
  });
}

/** A one-sentence progress read across all threads — the "how close to goal"
 *  line for status/brief headlines. */
export function threadsHeadline(threads: TargetThread[], triagePending: number): string {
  if (!threads.length) return triagePending ? `No lines of investigation yet; ${triagePending} suggestion${triagePending === 1 ? "" : "s"} awaiting triage` : "No lines of investigation yet";
  const active = threads.filter((t) => t.status === "active");
  const answered = threads.filter((t) => t.status === "answered").length;
  const dead = threads.filter((t) => t.status === "dead-end").length;
  const withLeads = active.filter((t) => t.stage === "leads" || t.stage === "corroborated").length;
  const parts: string[] = [];
  if (active.length) parts.push(`${active.length} line${active.length === 1 ? "" : "s"} active${withLeads ? ` (${withLeads} with leads)` : ""}`);
  if (answered) parts.push(`${answered} answered`);
  if (dead) parts.push(`${dead} dead-end`);
  if (triagePending) parts.push(`${triagePending} suggestion${triagePending === 1 ? "" : "s"} awaiting triage`);
  return parts.join(", ") || "No open lines of investigation";
}
