/**
 * Finding triggers — the "does this evidence deserve the analyst's attention?"
 * layer. Pure functions over records: no I/O, no provider calls, offline-testable
 * (like report/wall.ts). Two trigger families share one dedup + policy gate:
 *
 * - text-target: a non-image target's phrase appears verbatim in a sensed
 *   payload (the original scan/monitor automation, moved here from verbs/osint.ts).
 * - score triggers: a face/image/similar/cluster match record clears its
 *   similarity threshold (face + similar + cluster scores are 0–100 percent,
 *   image is RANSAC inlier count — NOT 0–1 fractions).
 *
 * Policy (setup.findings.mode):
 * - "suggest" (default, incl. missing setup): all triggers fire, emitting root
 *   findings with status "suggested" — quarantined from memory/brief evidence
 *   until reviewed (finding accept/dismiss); a dismissed suggestion never
 *   re-fires for the same (kind, target, source) key.
 * - "review" (legacy): text-target only, status "open"; dismissed does NOT
 *   block re-creation (preserved pre-suggest semantics).
 * - "off": nothing fires.
 */
import { findingStatusMap, isMemoryRecord, type OvercastRecord } from "../record.js";
import { escapeRegex } from "../text.js";
import { makeFinding } from "../verbs/finding.js";
import { isTargetClosed, type TargetEntry } from "../state/target.js";
import type { CaseSetup, SetupFindingsPolicy, SetupFindingsThresholds } from "../state/setup.js";

export const DEFAULT_FINDINGS_MODE = "suggest";

/** Verbs whose payload is MACHINE-analyzed content a target phrase can surface
 *  in unexpectedly (watch/listen/see). Deliberately excludes:
 *   - scan hits / raw captures — enumeration metadata; one item must not lead
 *     from its hit AND again from its analyzed content (undedupable — different
 *     source_record + media.ref);
 *   - notes — analyst-authored input, not machine-discovered evidence. The
 *     `/debrief` `thread:`/`tldr` notes routinely name the target, and
 *     auto-suggesting a finding that cites the analyst's own narrative is pure
 *     triage noise. Analysts promote a note to a finding explicitly via
 *     `finding create`.
 *  This matches the pre-persist-hook chain reach (it only ran on sensed records). */
export const TEXT_TARGET_VERBS: ReadonlySet<string> = new Set(["watch", "listen", "see"]);

/** Fire floors (score triggers skip matches below these) and "high" confidence
 *  bands. face/similar/cluster/voice are 0–100 percent (voice is the anchored
 *  cosine rank score: 80 ≈ raw cosine 0.51, above the EER overlap region; 90 ≈
 *  0.60, strong same-speaker); image is RANSAC inlier count; audio is the
 *  fingerprint alignment margin (best-offset votes / next-best —
 *  provider-gated, so any match already cleared min-margin; a clean exact match
 *  scores 100s–1000s×, a sped/pitch-shifted copy ~1.2–1.7×). */
export interface TriggerThresholds {
  face: number;
  face_high: number;
  similar: number;
  similar_high: number;
  cluster: number;
  cluster_high: number;
  voice: number;
  voice_high: number;
  image_inliers: number;
  image_inliers_high: number;
  audio_margin: number;
  audio_margin_high: number;
}

export const DEFAULT_TRIGGER_THRESHOLDS: TriggerThresholds = {
  face: 75,
  face_high: 85,
  similar: 85,
  similar_high: 90,
  cluster: 70,
  cluster_high: 80,
  voice: 80,
  voice_high: 90,
  image_inliers: 1,
  image_inliers_high: 40,
  audio_margin: 1,
  audio_margin_high: 2,
};

/** The saved findings policy, with the missing-setup / missing-policy default
 *  applied: suggestions are on unless a case explicitly opted out. */
export function resolveFindingsPolicy(setup: CaseSetup | undefined): SetupFindingsPolicy {
  return setup?.findings ?? { mode: DEFAULT_FINDINGS_MODE };
}

export function payloadText(rec: OvercastRecord): string {
  if (typeof rec.payload === "string") return rec.payload;
  try {
    return JSON.stringify(rec.payload);
  } catch {
    return "";
  }
}

/** Whole-phrase, case-insensitive, word-boundaried match of a target value
 *  against serialized evidence text. Shared by triggers and thread linking. */
export function targetMatchesEvidence(target: string, text: string): boolean {
  const normalizedTarget = target.trim().replace(/\s+/g, " ");
  if (!normalizedTarget) return false;
  const phrase = normalizedTarget.split(" ").map(escapeRegex).join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${phrase}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

/** A cleared score trigger, ready to ride into the finding payload. */
export interface TriggerSignal {
  kind: "face-match" | "image-match" | "similar-match" | "cluster-identify" | "audio-match" | "voice-match" | "text-target";
  score?: number;
  threshold?: number;
  unit?: "percent" | "inliers" | "margin";
  /** the best-scoring moment (seconds or span) in the source media, if anchored */
  at?: number | [number, number];
  /** matched ref / person label — whatever names the other side of the match */
  matched?: string;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : [];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function atOf(entry: Obj): number | [number, number] | undefined {
  const a = entry.at;
  if (typeof a === "number") return a;
  if (Array.isArray(a) && typeof a[0] === "number" && typeof a[1] === "number") return [a[0], a[1]];
  return undefined;
}

/** Best (score, at, matched) across an array of match/face entries. */
function best(entries: Obj[], scoreKey: string): { score: number; at?: number | [number, number]; matched?: string } | undefined {
  let top: { score: number; at?: number | [number, number]; matched?: string } | undefined;
  for (const e of entries) {
    const s = num(e[scoreKey]);
    if (s === undefined) continue;
    if (!top || s > top.score) {
      const matched = typeof e.ref === "string" ? e.ref : typeof e.file === "string" ? e.file : typeof e.label === "string" ? e.label : undefined;
      top = { score: s, at: atOf(e), matched };
    }
  }
  return top;
}

function definedEntries(o: SetupFindingsThresholds | undefined): Partial<TriggerThresholds> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v === "number") out[k] = v;
  return out;
}

function resolvedThresholds(policy: SetupFindingsPolicy | undefined): TriggerThresholds {
  return { ...DEFAULT_TRIGGER_THRESHOLDS, ...definedEntries(policy?.thresholds) };
}

/** Extract a cleared score signal from a match-shaped record, or undefined when
 *  the record isn't a match op / nothing clears the floor. Tolerant of both the
 *  tinycloud and local (deepface / RANSAC / CLIP) payload shapes. */
export function extractSignal(rec: OvercastRecord, thresholds: TriggerThresholds): TriggerSignal | undefined {
  const p = obj(rec.payload);
  if (!p) return undefined;
  const op = typeof p.op === "string" ? p.op : undefined;

  if (rec.verb === "face" && op === "match") {
    // tinycloud + deepface-local both emit faces[] with similarity (0–100);
    // tinycloud also mirrors a compact moments[] projection.
    const top = best(arr(p.faces), "similarity") ?? best(arr(p.moments), "similarity");
    if (!top || top.score < thresholds.face) return undefined;
    return { kind: "face-match", score: top.score, threshold: thresholds.face, unit: "percent", at: top.at, matched: typeof p.reference === "string" ? p.reference : top.matched };
  }

  if (rec.verb === "image" && op === "match") {
    const top = best(arr(p.matches), "num_inliers");
    if (!top || top.score < thresholds.image_inliers) return undefined;
    return { kind: "image-match", score: top.score, threshold: thresholds.image_inliers, unit: "inliers", at: top.at, matched: top.matched };
  }

  if (rec.verb === "similar" && op === "match") {
    // image→image only; text→image `search` is too noisy to auto-suggest.
    const top = best(arr(p.matches), "similarity");
    if (!top || top.score < thresholds.similar) return undefined;
    return { kind: "similar-match", score: top.score, threshold: thresholds.similar, unit: "percent", at: top.at, matched: top.matched };
  }

  if (rec.verb === "cluster" && op === "identify") {
    // matches[] = one entry per probe detection, each ranking candidates[]
    // (existing people) by similarity — the lead is the best candidate overall.
    let top: { score: number; at?: number | [number, number]; matched?: string } | undefined;
    for (const m of arr(p.matches)) {
      const cand = best(arr(m.candidates), "similarity");
      if (cand && (!top || cand.score > top.score)) top = { ...cand, at: atOf(m) ?? cand.at };
    }
    if (!top || top.score < thresholds.cluster) return undefined;
    return { kind: "cluster-identify", score: top.score, threshold: thresholds.cluster, unit: "percent", at: top.at, matched: top.matched };
  }

  if (rec.verb === "voice" && (op === "match" || op === "search")) {
    // windowed/diarized/search all emit matches[] with similarity (0–100 rank
    // score); search fires too — unlike similar's text search, a voice search is
    // reference-audio-driven over curated members, exactly the lead we want.
    const top = best(arr(p.matches), "similarity");
    if (!top || top.score < thresholds.voice) return undefined;
    return { kind: "voice-match", score: top.score, threshold: thresholds.voice, unit: "percent", at: top.at, matched: typeof p.reference === "string" ? p.reference : top.matched };
  }

  if (rec.verb === "audio" && op === "match") {
    // Shazam-style fingerprint match: the provider already gates on min-votes /
    // -ratio / -margin, so any entry in matches[] is a confident hit (like a
    // RANSAC image match). Rank by `margin` (best-offset votes over next-best);
    // `offset_seconds` is the alignment offset, not a query anchor, so no at.
    const top = best(arr(p.matches), "margin");
    if (!top || top.score < thresholds.audio_margin) return undefined;
    return { kind: "audio-match", score: top.score, threshold: thresholds.audio_margin, unit: "margin", matched: top.matched };
  }

  return undefined;
}

function highBandFor(kind: TriggerSignal["kind"], thresholds: TriggerThresholds): number | undefined {
  if (kind === "face-match") return thresholds.face_high;
  if (kind === "similar-match") return thresholds.similar_high;
  if (kind === "cluster-identify") return thresholds.cluster_high;
  if (kind === "image-match") return thresholds.image_inliers_high;
  if (kind === "audio-match") return thresholds.audio_margin_high;
  if (kind === "voice-match") return thresholds.voice_high;
  return undefined;
}

function baseName(ref: string): string {
  const parts = ref.split(/[\\/]/);
  return parts[parts.length - 1] || ref;
}

function mediaName(rec: OvercastRecord): string {
  return rec.media?.ref ? baseName(rec.media.ref) : `${rec.verb} record ${rec.id}`;
}

/** Link a score signal to an image target by reference-path match (exact value
 *  or same basename) so the suggestion lands on the analyst's declared line. */
function linkImageTarget(targets: TargetEntry[], candidates: Array<string | undefined>): TargetEntry | undefined {
  const norm = (s: string) => baseName(s).toLowerCase();
  for (const t of targets) {
    if (t.kind !== "image") continue;
    for (const c of candidates) {
      if (c && (t.value === c || norm(t.value) === norm(c))) return t;
    }
  }
  return undefined;
}

function suggestionText(rec: OvercastRecord, sig: TriggerSignal, target?: TargetEntry): string {
  const where = mediaName(rec);
  const forTarget = target ? ` for target '${target.value}'` : "";
  if (sig.kind === "face-match") return `Reference face${forTarget} matched at ${sig.score?.toFixed(1)}% similarity in ${where}`;
  if (sig.kind === "image-match") return `Image fingerprint${forTarget} matched (${sig.score} inliers) in ${where}`;
  if (sig.kind === "similar-match") return `Visual similarity ${sig.score?.toFixed(1)}% to ${sig.matched ? baseName(sig.matched) : "indexed media"}${forTarget} in ${where}`;
  if (sig.kind === "cluster-identify") return `Probe face matches known person${sig.matched ? ` '${sig.matched}'` : ""} at ${sig.score?.toFixed(1)}% in ${where}`;
  if (sig.kind === "audio-match") return `Audio fingerprint${forTarget} matched${sig.matched ? ` ${baseName(sig.matched)}` : ""} (${sig.score?.toFixed(1)}× margin) in ${where}`;
  if (sig.kind === "voice-match") return `Reference voice${sig.matched ? ` ${baseName(sig.matched)}` : ""}${forTarget} matched at ${sig.score?.toFixed(1)} similarity in ${where} — corroborate (a cloned/synthetic voice can score high)`;
  return `Automated match${forTarget} in ${rec.verb} record ${rec.id}`;
}

function signalKindOf(payload: Obj): string {
  const sig = obj(payload.signal);
  if (sig && typeof sig.kind === "string") return sig.kind;
  const trigger = typeof payload.trigger === "string" ? payload.trigger : "";
  if (trigger.startsWith("signal:")) return trigger.slice("signal:".length);
  // pre-signal automation and manual findings: treated as text-target-shaped
  return "text-target";
}

/** Whether an equivalent finding already exists (store + this pass), so the
 *  analyst is never nagged twice for the same lead. For suggestions a dismissed
 *  row blocks re-fire; legacy review mode keeps its refire-after-dismiss shape. */
function hasEquivalentFinding(
  records: OvercastRecord[],
  statusMap: Map<string, string>,
  q: { kind: string; target: string; sourceRecord: OvercastRecord; dismissedBlocks: boolean },
): boolean {
  return records.some((rec) => {
    if (rec.verb !== "finding" || !rec.payload || typeof rec.payload !== "object") return false;
    const payload = rec.payload as Obj;
    if (typeof payload.finding_id === "string") return false;
    if (!q.dismissedBlocks && (statusMap.get(rec.id) ?? "open") === "dismissed") return false;
    const sameSource = payload.source_record === q.sourceRecord.id;
    const sameMedia = !!q.sourceRecord.media?.ref && rec.media?.ref === q.sourceRecord.media.ref;
    if (!sameSource && !sameMedia) return false;
    // any finding already citing this exact record covers it, whatever the kind
    // (e.g. an analyst finding on an image-match record beats a re-suggestion).
    if (sameSource && q.kind !== "text-target") return true;
    if (signalKindOf(payload) !== q.kind) return false;
    return String(payload.target ?? "") === q.target;
  });
}

export interface EvaluateTriggerOpts {
  /** just-produced records to evaluate (findings/errors are skipped) */
  fresh: OvercastRecord[];
  /** the case store (post-write is fine) — dedup looks here */
  existing: OvercastRecord[];
  /** records accumulating in the same pass but not yet persisted */
  pending?: OvercastRecord[];
  targets: TargetEntry[];
  policy: SetupFindingsPolicy | undefined;
  /** chain context label (e.g. "scan:watch") recorded on the finding */
  via?: string;
}

/** Evaluate all finding triggers over fresh records. Returns the new finding
 *  records to persist (empty when mode is off / nothing clears a threshold). */
export function evaluateTriggers(opts: EvaluateTriggerOpts): OvercastRecord[] {
  const mode = opts.policy?.mode ?? DEFAULT_FINDINGS_MODE;
  if (mode !== "review" && mode !== "suggest") return [];
  const thresholds = resolvedThresholds(opts.policy);
  // closed lines (answered/dead-end) are no longer actively pursued, so they
  // must not accumulate new suggested findings — same invariant scanLocalCase /
  // primaryTarget enforce. A score match on media still fires unlinked (the
  // match is intrinsically interesting), it just isn't attributed to a dead line.
  const targets = opts.targets.filter((t) => !isTargetClosed(t));
  const out: OvercastRecord[] = [];
  // Hoisted once per evaluation (NOT per candidate): the store copy and the
  // finding-status map are O(N); rebuilding them per matching record made a
  // scan --pull pass O(F × N). Freshly pushed findings are appended to `all`
  // and applied to `statusMap` so dedup still sees same-pass findings.
  const all: OvercastRecord[] = [...opts.existing, ...(opts.pending ?? [])];
  const statusMap = findingStatusMap(all);
  const pushFinding = (rec: OvercastRecord) => {
    out.push(rec);
    all.push(rec);
    const p = rec.payload as Record<string, unknown>;
    if (typeof p?.status === "string") statusMap.set(rec.id, p.status);
  };

  for (const rec of opts.fresh) {
    // only true evidence records are trigger SOURCES — never operational/meta
    // records (prebrief/target/setup/…), whose payloads echo the target value
    // and would otherwise self-match the text-target trigger.
    if (rec.verb === "finding" || !isMemoryRecord(rec)) continue;

    // text-target: only content-bearing evidence (analyzed media + analyst
    // notes), NOT scan enumeration hits or raw captures. The old chain ran the
    // text trigger on the SENSED record only; the persist hook now sees every
    // record, so without this gate a target phrase in a scan-hit title AND in the
    // watch content of the same item would emit two leads (different source_record
    // + media.ref, so dedup can't fold them). Multi-sense-on-one-clip still folds
    // via the shared media.ref in hasEquivalentFinding.
    const haystack = payloadText(rec);
    for (const target of TEXT_TARGET_VERBS.has(rec.verb) ? targets : []) {
      if (target.kind === "image") continue;
      if (!targetMatchesEvidence(target.value, haystack)) continue;
      if (hasEquivalentFinding(all, statusMap, { kind: "text-target", target: target.value, sourceRecord: rec, dismissedBlocks: mode === "suggest" })) continue;
      pushFinding(
        makeFinding({
          text: `Automated match for target '${target.value}' in ${rec.verb} record ${rec.id}`,
          target: target.value,
          targetId: target.id,
          sourceRecord: rec,
          trigger: mode === "suggest" ? "signal:text-target" : opts.via ?? "automation",
          status: mode === "suggest" ? "suggested" : "open",
          signal: mode === "suggest" ? { kind: "text-target", ...(opts.via ? { via: opts.via } : {}) } : undefined,
          confidence: mode === "suggest" ? "medium" : undefined,
        }),
      );
    }

    // score triggers: suggest mode only.
    if (mode !== "suggest") continue;
    const sig = extractSignal(rec, thresholds);
    if (!sig) continue;
    const target = linkImageTarget(targets, [
      obj(rec.payload)?.reference as string | undefined,
      sig.matched,
    ]);
    if (hasEquivalentFinding(all, statusMap, { kind: sig.kind, target: target?.value ?? "", sourceRecord: rec, dismissedBlocks: true })) continue;
    const high = highBandFor(sig.kind, thresholds);
    pushFinding(
      makeFinding({
        text: suggestionText(rec, sig, target),
        target: target?.value ?? "",
        targetId: target?.id,
        sourceRecord: rec,
        trigger: `signal:${sig.kind}`,
        status: "suggested",
        signal: { ...sig, ...(opts.via ? { via: opts.via } : {}) },
        confidence: high !== undefined && (sig.score ?? 0) >= high ? "high" : "medium",
        at: sig.at,
      }),
    );
  }
  return out;
}
