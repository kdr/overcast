/**
 * Threads — a "line of investigation" is a target, viewed through the evidence,
 * findings, and notes linked to it. Pure derivation over the record store (no
 * I/O), so brief + status render the same struct.
 *
 * Linking (priority order):
 *  1. findings by payload.target_id === target.id, or payload.target === value —
 *     including a target_id stamped LATER by a review record (`finding accept
 *     --target …`), which overrides the root's own link;
 *  2. findings whose text names the target value (targetMatchesEvidence — so a
 *     manual finding that says "white van …" lands on the white-van line without
 *     an explicit stamp);
 *  3. name/prompt targets: evidence records whose text contains the value
 *     (the same matcher the text-target trigger uses);
 *  4. image targets: face/image/similar/cluster records referencing the value;
 *  5. notes tagged `thread:<tgt_id>` (the /debrief convention) — these feed the
 *     `narrative` field ONLY: the analyst's own commentary must not count as
 *     evidence/activity, or writing "this line is stale" would make it look active.
 *
 * Stage — the honest goal-progress ordinal (no fake %):
 *   answered / dead-end  ← analyst declared via `target close`
 *   corroborated         ← ≥1 accepted finding linked
 *   leads                ← ≥1 open/suggested finding linked
 *   collecting           ← ≥1 evidence record linked
 *   cold                 ← nothing linked yet
 */
import { findingStatusMap, isMemoryRecord, isReady, recordTimeMs, stripUrlTail, type OvercastRecord } from "../record.js";
import { SENSE_VERBS } from "./pulse.js";
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
  /** fixed-window daily bins (oldest→newest, last N days) of linked-record
   *  counts, for a sparkline — same window for every thread so cards compare */
  activityBins: number[];
  /** ids of the most recent linked records (evidence + findings), newest first */
  recentIds: string[];
  /** ids of the most recent linked EVIDENCE records (no findings), newest first —
   *  the "latest evidence" feed; recentIds mixes findings in and is capped, so a
   *  burst of findings would otherwise starve the evidence view */
  recentEvidenceIds: string[];
  /** ids of ALL linked root findings, newest first — the brief resolves + ranks
   *  these per thread (and derives the "unattached findings" complement) */
  findingIds: string[];
  /** a short "why" for a dead/answered line, else undefined */
  why?: string;
  /** newest `thread:<id>`-tagged note text — the analyst's line narrative from
   *  `/debrief`, surfaced on the brief/status thread cards */
  narrative?: string;
}

const MATCH_VERBS = new Set(["face", "image", "similar", "cluster", "audio"]);

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
}

function timeOf(r: OvercastRecord): number {
  const t = recordTimeMs(r);
  return Number.isNaN(t) ? 0 : t;
}

function baseName(ref: string): string {
  const parts = stripUrlTail(ref).split(/[\\/]/);
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
  if (target.kind === "image") {
    return MATCH_VERBS.has(rec.verb) && referencesImageTarget(rec, target.value);
  }
  return targetMatchesEvidence(target.value, payloadText(rec));
}

/** Latest LIVE target_id per root finding — the root's own stamp, or a review
 *  record's `finding accept --target …` stamp (keyed by finding_id). Append
 *  order = chronological, so last write wins, mirroring findingStatusMap.
 *  A stamp on a DISMISS row is audit metadata (which line the rejection was
 *  about) and never enters the map — otherwise it would sit inert while
 *  dismissed and then unexpectedly become live linkage if the finding is later
 *  accepted without --target. */
export function findingTargetMap(records: OvercastRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) {
    if (r.verb !== "finding") continue;
    const p = payloadOf(r);
    if (typeof p.target_id !== "string" || !p.target_id) continue;
    if (typeof p.finding_id === "string" && p.status === "dismissed") continue;
    const rootId = typeof p.finding_id === "string" ? p.finding_id : r.id;
    map.set(rootId, p.target_id);
  }
  return map;
}

function findingLinksTarget(finding: OvercastRecord, target: TargetEntry, stampedTargetId: string | undefined): boolean {
  // an explicit stamp (root or review row) is authoritative — for AND against:
  // a finding stamped onto line A must not also text-match onto line B.
  if (stampedTargetId) return stampedTargetId === target.id;
  const p = payloadOf(finding);
  // a declared target VALUE is authoritative both ways too — a trigger lead
  // attributed to line A must not also text-match onto line B.
  const declared = typeof p.target === "string" ? p.target : "";
  if (declared) return declared === target.value;
  // completely unattributed: fall back to the text matcher for HUMAN findings
  // only ("a manual finding that names the target value lands on its line").
  // Machine suggestion copy embeds media basenames (mediaName), so a name
  // target whose value appears in a FILENAME would false-link a score lead.
  const trigger = typeof p.trigger === "string" ? p.trigger : "";
  if (trigger && trigger !== "human") return false;
  return typeof p.text === "string" && targetMatchesEvidence(target.value, p.text);
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

/** Days spanned by the activity sparkline — shared so renderers can label it. */
export const ACTIVITY_WINDOW_DAYS = 7;

/** Bucket linked-record timestamps into fixed DAILY bins over the last
 *  `bins` days (oldest→newest). A fixed window makes two threads' sparklines
 *  directly comparable — the old first-activity→now scaling didn't. Activity
 *  older than the window simply doesn't show (a dormant line reads flat). */
function activityBins(times: number[], now: number, bins = ACTIVITY_WINDOW_DAYS): number[] {
  const out = new Array(bins).fill(0);
  const start = now - bins * DAY_MS;
  for (const t of times) {
    if (t <= start || t > now) continue;
    const idx = Math.min(bins - 1, Math.floor((t - start) / DAY_MS));
    out[idx] += 1;
  }
  return out;
}

/** Build the per-target thread views. `now` is injectable for deterministic tests. */
export function buildThreads(records: OvercastRecord[], targets: TargetEntry[], now = Date.now()): TargetThread[] {
  const statusMap = findingStatusMap(records);
  const targetMap = findingTargetMap(records);
  // a stamp is only authoritative when it resolves to a LIVE target — a stale
  // stamp (target since removed) falls back to value/text matching.
  const liveTargetIds = new Set(targets.map((t) => t.id));
  const findings = records.filter(isRootFindingRecord);
  // non-finding evidence candidates (memory-eligible, excludes operational/meta)
  const evidence = records.filter((r) => r.verb !== "finding" && isMemoryRecord(r));

  return targets.map((target) => {
    const status = targetStatus(target);
    // thread-tagged notes are the analyst's narrative ABOUT the line — surfaced
    // as `narrative`, but never counted as evidence/activity (see header).
    const narrativeNotes = evidence.filter((r) => noteTaggedForThread(r, target.id));
    const linkedEvidence = evidence.filter((r) => !noteTaggedForThread(r, target.id) && evidenceLinksTarget(r, target));
    const linkedFindings = findings.filter((f) => {
      const stamp = targetMap.get(f.id);
      return findingLinksTarget(f, target, stamp && liveTargetIds.has(stamp) ? stamp : undefined);
    });

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

    // activity = linked evidence + LIVE linked findings (leads count as
    // activity; a DISMISSED lead is triage noise — it stays in the audit count
    // above but must not make a cold line read "last activity 5m ago")
    const liveFindings = linkedFindings.filter((f) => (statusMap.get(f.id) ?? "open") !== "dismissed");
    const activity = [...linkedEvidence, ...liveFindings];
    const times = activity.map(timeOf);
    const lastMs = times.length ? Math.max(...times) : 0;
    const recentDay = times.filter((t) => t > 0 && now - t <= DAY_MS).length;
    const recentWeek = times.filter((t) => t > 0 && now - t <= WEEK_MS).length;

    const recentIds = [...activity]
      .sort((a, b) => timeOf(b) - timeOf(a))
      .slice(0, 8)
      .map((r) => r.id);

    const recentEvidenceIds = [...linkedEvidence]
      .sort((a, b) => timeOf(b) - timeOf(a))
      .slice(0, 8)
      .map((r) => r.id);

    const stage = stageFor(status, counts, linkedEvidence.length);
    const why = status === "active"
      ? undefined
      : target.status_note ?? (status === "answered" ? "closed as answered" : "closed as dead end");

    // newest `thread:<id>` note = the analyst's line narrative (from /debrief)
    const narrative = [...narrativeNotes]
      .sort((a, b) => timeOf(b) - timeOf(a))
      .map((r) => {
        const t = payloadOf(r).text;
        return typeof t === "string" && t.trim() ? t.trim() : undefined;
      })
      .find(Boolean);

    const findingIds = [...linkedFindings].sort((a, b) => timeOf(b) - timeOf(a)).map((f) => f.id);

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
      recentEvidenceIds,
      findingIds,
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
