/**
 * Mission board — the ONE markdown renderer for "where does this investigation
 * stand", shared by `brief` and `case status` so the two reports cannot drift
 * (they used to render near-identical thread/triage/coverage sections through
 * two codepaths with different formats). Pure over records + pulse structs, no
 * I/O — offline-unit-testable like report/wall.ts.
 *
 * The comprehension contract: a reader should get, in order,
 *   1. the verdict (analyst narrative first, machine coverage line demoted),
 *   2. per-line-of-investigation stories (question → answer so far → findings →
 *      latest evidence → next move),
 *   3. what still needs judgment (triage), and
 *   4. what was covered (one table, not three overlapping lists).
 */
import {
  collectVisualRefs,
  findingStatusMap,
  isReady,
  memoryRecords,
  recordStub,
  recordTimeMs,
  type OvercastRecord,
} from "../record.js";
import { isRootFindingRecord } from "../verbs/finding.js";
import { ACTIVITY_WINDOW_DAYS, THREAD_STAGE_LABEL, type TargetThread } from "../signals/threads.js";
import type { SourceCoverage } from "../signals/pulse.js";
import { fmtAge, sparkline } from "./components.js";

function payloadOf(r: OvercastRecord): Record<string, unknown> {
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : {};
}

// ---- findings ranking --------------------------------------------------------

export interface FindingRow {
  id: string;
  status: string;
  text: string;
  confidence?: unknown;
  overlays?: string[];
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** Accepted before open, then by confidence, then recency (rows arrive
 *  chronological; the reversed index keeps newest-wins within a tier). */
export function rankFindings<T extends { status: string; confidence?: unknown }>(findings: T[]): T[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const statusRank = (s: string) => (s === "accepted" ? 2 : s === "open" ? 1 : 0);
      const byStatus = statusRank(b.f.status) - statusRank(a.f.status);
      if (byStatus) return byStatus;
      const byConf = (CONFIDENCE_RANK[String(b.f.confidence ?? "").toLowerCase()] ?? 0) - (CONFIDENCE_RANK[String(a.f.confidence ?? "").toLowerCase()] ?? 0);
      if (byConf) return byConf;
      return b.i - a.i; // newer first
    })
    .map((x) => x.f);
}

// ---- verdict -----------------------------------------------------------------

export interface VerdictInput {
  /** analyst narrative (newest tldr note) — the human voice, leads when present */
  tldr?: string;
  /** machine coverage one-liner (always present) */
  verdict: string;
  /** pulse goal-progress headline */
  headline?: string;
  /** "since last brief (2h ago): +3 records …" */
  delta?: string;
}

/** The single-voice verdict block: analyst narrative as the statement, machine
 *  lines demoted to ONE italic meta line under it. No more three stacked
 *  unlabeled summaries. */
export function renderVerdictMd(v: VerdictInput): string[] {
  const lines = ["## Verdict", ""];
  lines.push(v.tldr?.trim() || v.verdict, "");
  const meta = [v.tldr?.trim() ? v.verdict : "", v.headline ?? "", v.delta ?? ""].filter(Boolean);
  if (meta.length) lines.push(`_${meta.join(" · ")}_`, "");
  return lines;
}

// ---- delta since last brief ----------------------------------------------------

/** "since last brief (2h ago): +N records, +M findings, +K suggestions" — the
 *  catch-up line for a recurring report. Undefined when no prior brief exists.
 *  Only REAL briefs count as the baseline (payload.report + synthesis); the
 *  monitor's mini-brief records don't reset the clock. */
export function briefDelta(records: OvercastRecord[], now = Date.now()): string | undefined {
  let last = Number.NEGATIVE_INFINITY;
  for (const r of records) {
    if (r.verb !== "brief" || !isReady(r)) continue;
    const p = payloadOf(r);
    if (typeof p.report !== "string" || p.synthesis == null) continue;
    const t = recordTimeMs(r);
    if (!Number.isNaN(t) && t > last) last = t;
  }
  if (!Number.isFinite(last)) return undefined;
  const newer = (r: OvercastRecord) => {
    const t = recordTimeMs(r);
    return !Number.isNaN(t) && t > last;
  };
  const evidence = memoryRecords(records).filter((r) => r.verb !== "finding" && newer(r)).length;
  const statusMap = findingStatusMap(records);
  const newRoots = records.filter((r) => isRootFindingRecord(r) && newer(r));
  const effective = (f: OvercastRecord) => statusMap.get(f.id) ?? "open";
  const suggestions = newRoots.filter((f) => effective(f) === "suggested").length;
  // only live evidence counts as "+N findings" — a post-brief create+dismiss is
  // a rejection, not new evidence, and must not inflate the catch-up line
  const findings = newRoots.filter((f) => effective(f) === "accepted" || effective(f) === "open").length;
  const parts: string[] = [];
  if (evidence) parts.push(`+${evidence} record${evidence === 1 ? "" : "s"}`);
  if (findings) parts.push(`+${findings} finding${findings === 1 ? "" : "s"}`);
  if (suggestions) parts.push(`+${suggestions} suggestion${suggestions === 1 ? "" : "s"}`);
  const age = fmtAge(Math.max(0, (now - last) / 1000));
  return `since last brief (${age} ago): ${parts.length ? parts.join(", ") : "nothing new"}`;
}

/** Match-draw overlay refs per root finding id — from the finding's own payload
 *  and from the image/face/audio match record it cites via source_record (the
 *  geometric proof / alignment plot). Built over the FULL record set and every
 *  status: suggested leads render inside thread cards and the triage panel, so
 *  their proofs must attach too (dismissed rows are filtered at render time and
 *  never surface their overlays). The ONE overlay source for brief synthesis,
 *  thread cards, and case status — md and html can't drift. */
export function findingOverlays(records: OvercastRecord[]): Map<string, string[]> {
  const byId = new Map(records.map((r) => [r.id, r]));
  const out = new Map<string, string[]>();
  for (const r of records) {
    if (!isRootFindingRecord(r)) continue;
    const p = payloadOf(r);
    const overlays = new Set(collectVisualRefs(p));
    const src = typeof p.source_record === "string" ? byId.get(p.source_record) : undefined;
    if (src && (src.verb === "image" || src.verb === "face" || src.verb === "audio")) {
      for (const ref of collectVisualRefs(src.payload)) overlays.add(ref);
    }
    if (overlays.size) out.set(r.id, [...overlays].slice(0, 3));
  }
  return out;
}

// ---- threads (lines of investigation) ----------------------------------------

export interface ThreadRenderContext {
  /** full record lookup for resolving latest-evidence + finding rows */
  byId: Map<string, OvercastRecord>;
  /** effective reviewed status per root finding */
  statusByFinding: Map<string, string>;
  /** match-draw overlay refs per finding id (the geometric/alignment proof
   *  images) — embedded under the finding's row when present */
  overlaysByFinding?: Map<string, string[]>;
  now?: number;
}

/** One newest-evidence row on a thread card. */
export interface EvidenceLineModel {
  id: string;
  verb: string;
  /** "@12-18s" media anchor, when present */
  at?: string;
  /** "5d" age, when the record is dated */
  age?: string;
  stub: string;
}

/** Renderer-agnostic card model for one line of investigation — the md section
 *  and the CSI HTML card both render from this, so they tell the same story. */
export interface ThreadCard {
  value: string;
  stage: string;
  spark?: string;
  /** sparkline window label, e.g. "7d" */
  sparkWindow: string;
  question?: string;
  /** the analyst's narrative for the line (thread:<id> note) */
  answer?: string;
  /** resolved + ranked linked findings (capped) */
  findings: Array<FindingRow & { effectiveStatus: string }>;
  findingCounts: { accepted: number; open: number; suggested: number };
  funnel: string;
  lastActivityAge?: string;
  /** newest linked evidence rows */
  latest: EvidenceLineModel[];
  next?: string;
  /** close reason for an answered/dead-end line */
  closed?: string;
  dimmed: boolean;
}

function findingRowOf(rec: OvercastRecord, effectiveStatus: string): FindingRow & { effectiveStatus: string } {
  const p = payloadOf(rec);
  return {
    id: rec.id,
    status: effectiveStatus,
    effectiveStatus,
    text: typeof p.text === "string" ? p.text : "",
    confidence: p.confidence,
  };
}

function atLabel(rec: OvercastRecord): string {
  if (rec.media?.at == null) return "";
  return ` @${Array.isArray(rec.media.at) ? rec.media.at.join("-") : rec.media.at}s`;
}

function ageOf(rec: OvercastRecord, now: number): string | undefined {
  const t = recordTimeMs(rec);
  return Number.isNaN(t) ? undefined : fmtAge(Math.max(0, (now - t) / 1000));
}

function evidenceLine(rec: OvercastRecord, now: number): EvidenceLineModel {
  const model: EvidenceLineModel = { id: rec.id, verb: rec.verb, stub: recordStub(rec, 140) };
  const at = atLabel(rec).trim();
  if (at) model.at = at;
  const age = ageOf(rec, now);
  if (age) model.age = age;
  return model;
}

/** "`rec_x` watch @12-18s (5d ago) — stub" */
export function evidenceLineMd(l: EvidenceLineModel): string {
  return `\`${l.id}\` ${l.verb}${l.at ? ` ${l.at}` : ""}${l.age ? ` (${l.age} ago)` : ""} — ${l.stub}`;
}

/** Build the render model for one thread. */
export function threadCard(th: TargetThread, ctx: ThreadRenderContext): ThreadCard {
  const now = ctx.now ?? Date.now();
  const resolvedFindings = th.findingIds
    .map((id) => ctx.byId.get(id))
    .filter((r): r is OvercastRecord => !!r)
    .map((r) => {
      const row = findingRowOf(r, ctx.statusByFinding.get(r.id) ?? String(payloadOf(r).status ?? "open"));
      const overlays = ctx.overlaysByFinding?.get(r.id);
      if (overlays?.length) row.overlays = overlays;
      return row;
    })
    // dismissed = rejected evidence: it stays linked for audit (thread counts in
    // threads.ts), but must never render back into the thread story after triage
    .filter((f) => f.effectiveStatus !== "dismissed");
  // chronological in, so rankFindings' recency tiebreak holds
  const ranked = rankFindings(resolvedFindings.slice().reverse());
  // counts come from the THREAD (threads.ts computed them from the same status
  // map, dismissed already excluded from a/o/s) — not from the resolved rows,
  // so a payload-only render (no record store, empty byId) still shows them.
  const counts = { accepted: th.findings.accepted, open: th.findings.open, suggested: th.findings.suggested };
  // latest evidence rides the evidence-only recency list — recentIds mixes
  // findings in and is capped, so a burst of findings would starve this section
  const latest = th.recentEvidenceIds
    .map((id) => ctx.byId.get(id))
    .filter((r): r is OvercastRecord => !!r)
    .slice(0, 2)
    .map((r) => evidenceLine(r, now));
  const lastMs = th.lastActivity ? Date.parse(th.lastActivity) : NaN;
  let next: string | undefined;
  if (th.status === "active") {
    if (th.stage === "cold") next = "no evidence yet — scan/capture toward this line";
    else if (counts.suggested) next = `triage ${counts.suggested} suggested finding${counts.suggested === 1 ? "" : "s"} (\`overcast finding list --state suggested\`)`;
  }
  return {
    value: th.value,
    stage: THREAD_STAGE_LABEL[th.stage],
    spark: sparkline(th.activityBins) || undefined,
    sparkWindow: `${ACTIVITY_WINDOW_DAYS}d`,
    question: th.question,
    answer: th.narrative,
    findings: ranked.slice(0, 3),
    findingCounts: counts,
    funnel: `scan ${th.funnel.scan} → capture ${th.funnel.captures} → sense ${th.funnel.senses} → match ${th.funnel.matches}`,
    lastActivityAge: Number.isNaN(lastMs) ? undefined : fmtAge(Math.max(0, (now - lastMs) / 1000)),
    latest,
    next,
    closed: th.status !== "active" ? th.why : undefined,
    dimmed: th.status !== "active",
  };
}

/** One md finding row: `` `id` [status] (confidence) text `` */
export function findingLineMd(f: FindingRow): string {
  const conf = f.confidence != null ? ` (${f.confidence})` : "";
  return `\`${f.id}\` [${f.status}]${conf} ${f.text}`;
}

/** "## Lines of investigation" — one story block per thread. */
export function renderThreadsMd(threads: TargetThread[], ctx: ThreadRenderContext): string[] {
  const lines: string[] = ["## Lines of investigation", ""];
  if (!threads.length) {
    lines.push("- none — add a target with `overcast target add <value> --question \"…\"`", "");
    return lines;
  }
  for (const th of threads) {
    const card = threadCard(th, ctx);
    lines.push(`### ${card.value} — [${card.stage}]${card.spark ? ` \`${card.spark}\` ${card.sparkWindow}` : ""}`, "");
    if (card.question) lines.push(`- question: ${card.question}`);
    if (card.answer) lines.push(`- so far: ${card.answer}`);
    if (card.findings.length) {
      const c = card.findingCounts;
      const countBits = [c.accepted ? `${c.accepted} accepted` : "", c.open ? `${c.open} open` : "", c.suggested ? `${c.suggested} suggested` : ""].filter(Boolean);
      lines.push(`- findings (${countBits.join(" · ")}):`);
      for (const f of card.findings) {
        lines.push(`  - ${findingLineMd(f)}`);
        for (const ref of f.overlays ?? []) lines.push(`    ![match overlay](${ref})`);
      }
    }
    lines.push(`- evidence: ${card.funnel}${card.lastActivityAge ? ` · last activity ${card.lastActivityAge} ago` : ""}`);
    if (card.latest.length) {
      lines.push("- latest:");
      for (const l of card.latest) lines.push(`  - ${evidenceLineMd(l)}`);
    }
    if (card.closed) lines.push(`- closed: ${card.closed}`);
    else if (card.next) lines.push(`- NEXT: ${card.next}`);
    lines.push("");
  }
  return lines;
}

// ---- triage --------------------------------------------------------------------

export interface TriageRow {
  id: string;
  text: string;
  confidence?: unknown;
  /** trigger score (payload.signal.score) */
  score?: number;
  /** provenance excerpt from the cited source record — the deciding context */
  excerpt?: string;
  url?: string;
}

/** Suggested-lead rows, newest first, enriched with the deciding context (score,
 *  source excerpt/url) so a human can accept/dismiss without a second lookup.
 *  Shared by the brief, case status (md + JSON), and the CSI triage panel. */
export function triageRows(records: OvercastRecord[], statusByFinding: Map<string, string>): TriageRow[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  return records
    .filter((r) => isRootFindingRecord(r) && (statusByFinding.get(r.id) ?? "open") === "suggested")
    .sort((a, b) => recordTimeMs(b) - recordTimeMs(a))
    .map((r) => {
      const p = payloadOf(r);
      const sig = p.signal && typeof p.signal === "object" ? (p.signal as Record<string, unknown>) : {};
      const row: TriageRow = { id: r.id, text: String(p.text ?? ""), confidence: p.confidence };
      if (typeof sig.score === "number") row.score = sig.score;
      const src = typeof p.source_record === "string" ? byId.get(p.source_record) : undefined;
      if (src) {
        const sp = payloadOf(src);
        const excerpt = typeof sp.source_text === "string" && sp.source_text.trim() ? sp.source_text : recordStub(src, 140);
        if (excerpt && !excerpt.startsWith("payload:")) row.excerpt = excerpt.replace(/\s+/g, " ").trim().slice(0, 200);
        const url = typeof sp.source_url === "string" ? sp.source_url : typeof sp.url === "string" ? sp.url : undefined;
        if (url) row.url = url;
      }
      return row;
    });
}

/** "## Triage — N awaiting review" — each row with its deciding context and the
 *  exact review commands. `total` = true backlog (rows may be pre-capped). */
export function renderTriageMd(rows: TriageRow[], total = rows.length): string[] {
  if (!total) return [];
  const lines = [`## Triage — ${total} awaiting review`, ""];
  const shown = rows.slice(0, 5);
  for (const r of shown) {
    const conf = r.confidence != null ? ` [${r.confidence}]` : "";
    const score = r.score != null ? ` (score ${r.score})` : "";
    lines.push(`- \`${r.id}\`${conf}${score} ${r.text}`);
    if (r.excerpt) lines.push(`  - > ${r.excerpt}${r.url ? ` — ${r.url}` : ""}`);
    else if (r.url) lines.push(`  - source: ${r.url}`);
    lines.push(`  - accept: \`overcast finding accept ${r.id} [--target <id>]\` · dismiss: \`overcast finding dismiss ${r.id}\``);
  }
  if (total > shown.length) lines.push(`- …and ${total - shown.length} more (\`overcast finding list --state suggested\`)`);
  lines.push("");
  return lines;
}

// ---- coverage --------------------------------------------------------------------

/** Scan-hit rollup by source label (ready scans carrying a url) — the "what was
 *  actually swept" view. Shared by the brief verdict and the coverage table's
 *  ad-hoc rows so their hit counts always reconcile. */
export function sweptSources(records: OvercastRecord[]): Array<{ source: string; hits: number }> {
  const bySource = new Map<string, number>();
  for (const r of records) {
    if (r.verb !== "scan" || !isReady(r)) continue;
    const p = payloadOf(r);
    if (typeof p.url !== "string" || !p.url) continue;
    const src = String(p.source ?? "unknown");
    bySource.set(src, (bySource.get(src) ?? 0) + 1);
  }
  return [...bySource].map(([source, hits]) => ({ source, hits }));
}

export interface CoverageTableRow {
  label: string;
  lastScan: string;
  hits: string;
  captured: string;
  sensed: string;
  gap: boolean;
}

/** One coverage table from the two old overlapping views: configured sources
 *  (funnel + freshness + never-scanned flag) plus the ad-hoc rows for hits not
 *  attributable to any configured source — the same fact no longer appears
 *  twice. `adhoc` comes from unattributedScanHits (signals/pulse.ts), which
 *  shares buildCoverage's per-hit attribution rule: subtracting label totals
 *  here would double-count a hit whose scan label differs from its source's
 *  type. */
export function coverageTableRows(coverage: SourceCoverage[], adhoc: Array<{ source: string; hits: number }>): CoverageTableRow[] {
  const rows: CoverageTableRow[] = coverage.map((c) => ({
    label: `**${c.spec}**${c.enabled ? "" : " (disabled)"}`,
    lastScan: c.gap ? "⚠ never" : fmtAge(c.lastScanAgeSeconds),
    hits: String(c.hits),
    captured: String(c.captured),
    sensed: String(c.sensed),
    gap: c.gap,
  }));
  // the "(ad-hoc)" marker only means anything in CONTRAST to configured rows
  const suffix = coverage.length ? " _(ad-hoc)_" : "";
  for (const s of adhoc) {
    if (s.hits > 0) rows.push({ label: `${s.source}${suffix}`, lastScan: "—", hits: String(s.hits), captured: "—", sensed: "—", gap: false });
  }
  return rows;
}

/** "## Coverage" — the single table + non-source gaps. */
export function renderCoverageMd(coverage: SourceCoverage[], adhoc: Array<{ source: string; hits: number }>, gaps: string[]): string[] {
  const lines: string[] = ["## Coverage", ""];
  const rows = coverageTableRows(coverage, adhoc);
  if (rows.length) {
    lines.push("| source | last scan | hits | captured | sensed |");
    lines.push("| --- | --- | ---: | ---: | ---: |");
    for (const r of rows) lines.push(`| ${r.label} | ${r.lastScan} | ${r.hits} | ${r.captured} | ${r.sensed} |`);
    lines.push("");
  } else {
    lines.push("- no sources configured and no scan hits in scope", "");
  }
  // the table's ⚠ never column already flags never-scanned sources — only the
  // non-source gaps (e.g. captures never sensed) need bullets.
  const rest = gaps.filter((g) => !g.endsWith("enabled but never scanned"));
  if (rest.length) {
    lines.push("**Gaps:**");
    for (const g of rest.slice(0, 5)) lines.push(`- ${g}`);
    lines.push("");
  }
  return lines;
}
