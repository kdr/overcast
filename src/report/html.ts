import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { envEnabled } from "../env.js";
import { PRIMARY_TEXT_FIELDS, recordStub, type OvercastRecord } from "../record.js";
// type-only: erased at compile time, so no runtime cycle with mission.ts
// (mission → components → html would otherwise loop)
import type { CoverageTableRow, ThreadCard, TriageRow } from "./mission.js";

export type HtmlTheme = "plain" | "csi";

/** Remote media in exported reports is OFF by default: an auto-opened report
 *  that fetches scraped thumbnails/videos beacons the analyst's IP to the
 *  investigated host. OVERCAST_REPORT_REMOTE_MEDIA=1 re-enables remote embeds. */
export function reportRemoteMediaEnabled(): boolean {
  return envEnabled("OVERCAST_REPORT_REMOTE_MEDIA");
}

/** CSP meta for the report HTML shells. `default-src 'none'` blocks every
 *  outbound load so an auto-opened report can't beacon the analyst to an
 *  investigated host; only inlined `data:` + local `file:` media (and, with the
 *  opt-in, remote http/https) are allowed. `style-src`/`script-src` cover the
 *  shells' inline `<style>`/`<script>` — `script` is passed only by the wall
 *  shell (the report shells run no scripts). One line guards every embed site. */
export function reportCsp(opts: { script?: boolean } = {}): string {
  const remote = reportRemoteMediaEnabled() ? " https: http:" : "";
  const directives = [
    "default-src 'none'",
    `img-src data: file:${remote}`,
    `media-src data: file:${remote}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
  ];
  if (opts.script) directives.splice(3, 0, "script-src 'unsafe-inline'");
  return `<meta http-equiv="Content-Security-Policy" content="${directives.join("; ")}">`;
}

/** Placeholder shown in place of a remote `<img>`/`<video>` when remote media is
 *  off — the CSP already blocks the fetch; this says WHY and how to opt in. */
function remoteBlockedEmbed(ref: string): string {
  return `<div class="embed remote-blocked" title="${escapeHtml(ref)}">remote media not loaded (set OVERCAST_REPORT_REMOTE_MEDIA=1 to embed) — ${escapeHtml(ref)}</div>`;
}

export interface TimelineRecord {
  id: string;
  verb: string;
  state?: string;
  media?: { ref?: string; at?: number | [number, number] | string | null } | null;
  meta?: Record<string, unknown>;
  payload?: unknown;
  error?: string;
  /** local poster-frame path for a video preview (extracted at export time) so
   *  the player can stay preload="none" — set by attachVideoPosters. */
  poster?: string;
}

/** Record-derived brief header (see BriefSynthesis in verbs/read.ts): narrative
 *  TL;DR + coverage verdict + thread cards + triage + the coverage table,
 *  rendered above the timeline so the export tells the SAME story as the
 *  markdown brief (both build from the shared mission models). */
export interface TimelineSynthesis {
  tldr?: string;
  verdict: string;
  /** the honest goal-progress line (pulse headline), shown under the verdict */
  headline?: string;
  /** "since last brief (2h ago): +N records …" catch-up line */
  delta?: string;
  sources: Array<{ source: string; hits: number }>;
  /** UNATTACHED findings — linked ones render inside their thread card */
  findings: Array<{ id: string; status: string; text: string; confidence?: unknown; overlays?: string[] }>;
  /** lines of investigation — per-target thread cards (shared mission model) */
  threads?: ThreadCard[];
  /** suggested leads awaiting triage, with their deciding context */
  triage?: TriageRow[];
  /** the single coverage table (configured funnel + ad-hoc swept rows) */
  coverage?: CoverageTableRow[];
}

const VISUAL_EXT_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;
// deliberately NOT a bare `path`/`img` — the image-match payload carries
// `db_img_path` (the reference frame) and `query_path` (a temp frame that's
// deleted after the run); only the rendered `match_draw_path` overlay and real
// crop/thumbnail evidence should surface.
const VISUAL_KEY_RE = /(?:draw|overlay|visual|thumbnail|thumb|crop|image)/i;

/** Collect visualization image refs from a record payload — match-draw overlays,
 *  crops, thumbnails: data URIs, or image-extension paths under a visual-ish key
 *  (`match_draw_path`, `crop`, `thumbnail`, …). Shared by briefs and `case
 *  status` so overlays surface identically in both. */
export function collectVisualRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const visit = (v: unknown, key = ""): void => {
    if (typeof v === "string") {
      if (/^data:image\//i.test(v) || (VISUAL_EXT_RE.test(v) && VISUAL_KEY_RE.test(key))) refs.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, key);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) visit(child, k);
    }
  };
  visit(value);
  return [...refs];
}

export interface TimelineReport {
  title: string;
  subtitle?: string;
  records: TimelineRecord[];
  counts?: Record<string, number>;
  total?: number;
  kind?: string;
  synthesis?: TimelineSynthesis;
}

export interface StatusReport {
  title: string;
  subtitle?: string;
  payload: Record<string, unknown>;
}

export function normalizeHtmlTheme(value: unknown): HtmlTheme | undefined {
  if (value == null) return "plain";
  const theme = String(value).trim().toLowerCase();
  if (theme === "plain" || theme === "csi") return theme;
  return undefined;
}

export function isHtmlExportPath(path: string): boolean {
  return extname(path).toLowerCase() === ".html";
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mdToPlainHtml(md: string, title: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    if (fence == null && /^`{3,}\s*$/.test(line)) {
      fence = line.trim();
      out.push("<pre>");
      continue;
    }
    if (fence != null) {
      if (line.trim() === fence) {
        out.push("</pre>");
        fence = null;
      } else {
        out.push(escapeHtml(line));
      }
      continue;
    }
    if (/^### /.test(line)) out.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    else if (/^# /.test(line)) out.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    else if (/^## /.test(line)) out.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    else if (/^- /.test(line)) out.push(`<li>${escapeHtml(line.slice(2))}</li>`);
    else if (line.trim() === "") out.push("");
    else out.push(`<p>${escapeHtml(line)}</p>`);
  }
  const body = out.join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">${reportCsp()}<title>${escapeHtml(title)}</title>
<style>body{background:#08120c;color:#c6f7d5;font-family:ui-monospace,monospace;max-width:840px;margin:2rem auto;padding:1rem}
h1,h2{color:#ffc400}code{color:#00ff7f}li{margin:2px 0}
pre{white-space:pre-wrap;word-break:break-word;background:#0d1f14;padding:8px;border-radius:4px}</style></head><body>
${body}
</body></html>`;
}

export function renderCsiTimelineReport(report: TimelineReport): string {
  const counts = report.counts ?? countByVerb(report.records);
  const total = report.total ?? report.records.length;
  const cards = report.records.map((record, index) => renderTimelineCard(record, index)).join("\n");
  const countChips = Object.entries(counts).sort().map(([verb, count]) => `<span class="chip cyan">${escapeHtml(verb)} ${count}</span>`).join("");
  return csiShell(report.title, report.subtitle, `
    ${renderSynthesis(report.synthesis)}
    <section class="stats" aria-label="case report stats">
      <div><span class="label">MODE</span><strong>${escapeHtml(report.kind ?? "timeline")}</strong></div>
      <div><span class="label">RECORDS</span><strong>${total}</strong></div>
      <div class="chips">${countChips || `<span class="chip amber">no records</span>`}</div>
    </section>
    <main class="timeline" data-csi-timeline="true">
      ${cards || `<article class="card empty"><span class="label">EMPTY</span><p>No records matched this report.</p></article>`}
    </main>
  `);
}

/** One findings <ul> (id + status + confidence + text + overlay proofs). */
function findingListHtml(findings: TimelineSynthesis["findings"]): string {
  return `<ul class="findings">${findings.map((f) => {
    const overlays = (f.overlays ?? []).map((ref) => imageTag(ref)).filter(Boolean).slice(0, 3).join("");
    return `<li><span class="id">${escapeHtml(f.id)}</span> <span class="state">[${escapeHtml(f.status)}]</span>${f.confidence != null ? ` <span class="meta">(confidence: ${escapeHtml(String(f.confidence))})</span>` : ""} ${escapeHtml(f.text)}${overlays ? `<div class="overlays" data-csi-overlays="true">${overlays}</div>` : ""}</li>`;
  }).join("")}</ul>`;
}

/** The coverage panel body: the single table (configured funnel + ad-hoc swept
 *  rows), falling back to the swept-source list when nothing is configured. */
function coverageTableHtml(coverage: CoverageTableRow[] | undefined, sources: TimelineSynthesis["sources"]): string {
  if (coverage?.length) {
    const rows = coverage.map((r) => {
      const label = r.label.replace(/\*\*|_/g, ""); // md emphasis → plain for html
      return `<tr><td>${escapeHtml(label)}</td><td${r.gap ? ` class="bad"` : ""}>${escapeHtml(r.lastScan)}</td><td>${escapeHtml(r.hits)}</td><td>${escapeHtml(r.captured)}</td><td>${escapeHtml(r.sensed)}</td></tr>`;
    }).join("");
    return `<table class="coverage" data-csi-coverage="true"><thead><tr><th>source</th><th>last scan</th><th>hits</th><th>captured</th><th>sensed</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  if (sources.length) {
    return `<ul>${sources.map((s) => `<li><strong>${escapeHtml(s.source)}</strong> — ${s.hits} hit${s.hits === 1 ? "" : "s"}</li>`).join("")}</ul>`;
  }
  return `<p class="meta">none — no scan hits in scope</p>`;
}

/** The brief's narrative header: TL;DR banner (analyst note leading, machine
 *  verdict + headline + delta demoted to meta lines), thread cards, triage, and
 *  the coverage / unattached-findings panels. An explicit "none recorded" is
 *  rendered rather than omitting a panel — "we checked and found nothing" is a
 *  result. */
function renderSynthesis(syn: TimelineSynthesis | undefined): string {
  if (!syn) return "";
  const tldrNext = [syn.tldr ? syn.verdict : "", syn.headline ?? "", syn.delta ?? ""].filter(Boolean);
  const tldr = renderTldr({
    headline: syn.tldr ?? syn.verdict,
    findings: tldrNext,
  });
  const hasThreads = !!syn.threads?.length;
  const findings = syn.findings.length
    ? `${hasThreads ? `<p class="meta">not linked to a line of investigation</p>` : ""}${findingListHtml(syn.findings)}`
    : `<p class="meta">${hasThreads ? "none — every finding is linked to a line above" : "none recorded"}</p>`;
  return `${tldr}
    ${renderThreadCards(syn.threads)}
    ${renderTriagePanel(syn.triage)}
    <section class="grid" data-csi-synthesis="true" style="margin:0 0 18px">
      <section class="panel"><h2>Coverage</h2>${coverageTableHtml(syn.coverage, syn.sources)}</section>
      <section class="panel"><h2>${hasThreads ? "Other findings" : "Key findings"}</h2>${findings}</section>
    </section>`;
}

/** Lines of investigation — a card grid of target threads: stage chip, activity
 *  sparkline (fixed window), question → answer-so-far → linked findings → latest
 *  evidence → NEXT. Renders the SAME ThreadCard model as the markdown, so the
 *  export and the terminal tell one story. Dead-end cards dim. */
function renderThreadCards(threads: TimelineSynthesis["threads"]): string {
  if (!threads || !threads.length) return "";
  const toneFor = (stage: string) => (stage === "DEAD-END" ? "bad" : stage === "ANSWERED" ? "cyan" : stage === "CORROBORATED" || stage === "LEADS" ? "amber" : "");
  const cards = threads.map((t) => {
    const dim = t.dimmed ? ' style="opacity:.55"' : "";
    const chip = `<span class="chip ${toneFor(t.stage)}">${escapeHtml(t.stage)}</span>`;
    const c = t.findingCounts;
    const countBits = [c.accepted ? `${c.accepted} accepted` : "", c.open ? `${c.open} open` : "", c.suggested ? `${c.suggested} suggested` : ""].filter(Boolean).join(" · ");
    // overlay proofs ride each finding row, exactly like the markdown path — the
    // geometric evidence stays WITH its line of investigation
    const findingRows = t.findings.map((f) => {
      const overlays = (f.overlays ?? []).map((ref) => imageTag(ref)).filter(Boolean).slice(0, 3).join("");
      return `<li><span class="id">${escapeHtml(f.id)}</span> <span class="state">[${escapeHtml(f.status)}]</span> ${escapeHtml(f.text)}${overlays ? `<div class="overlays" data-csi-overlays="true">${overlays}</div>` : ""}</li>`;
    }).join("");
    const latestRows = t.latest.map((l) => `<li><span class="id">${escapeHtml(l.id)}</span> ${escapeHtml(l.verb)}${l.at ? ` ${escapeHtml(l.at)}` : ""}${l.age ? ` <span class="meta">(${escapeHtml(l.age)} ago)</span>` : ""} — ${escapeHtml(l.stub)}</li>`).join("");
    // counts render even without resolved rows — the status export builds cards
    // from the raw payload (no record store), so counts are all it has
    const findingsBlock = findingRows
      ? `<p class="meta">findings${countBits ? ` (${escapeHtml(countBits)})` : ""}:</p><ul class="findings">${findingRows}</ul>`
      : countBits
        ? `<p class="meta">findings: ${escapeHtml(countBits)}</p>`
        : "";
    return `<article class="context-card"${dim}>
      <span class="label">TARGET</span>
      <p><strong>${escapeHtml(t.value)}</strong> ${chip}${t.spark ? ` <span class="cyan">${escapeHtml(t.spark)}</span> <span class="meta">${escapeHtml(t.sparkWindow)}</span>` : ""}</p>
      ${t.question ? `<p class="meta">? ${escapeHtml(t.question)}</p>` : ""}
      ${t.answer ? `<p>${escapeHtml(t.answer)}</p>` : ""}
      ${findingsBlock}
      <p class="meta">${escapeHtml(t.funnel)}${t.lastActivityAge ? ` · last activity ${escapeHtml(t.lastActivityAge)} ago` : ""}</p>
      ${latestRows ? `<ul class="findings">${latestRows}</ul>` : ""}
      ${t.closed ? `<p class="meta">closed: ${escapeHtml(t.closed)}</p>` : t.next ? `<p class="meta">NEXT: ${escapeHtml(t.next)}</p>` : ""}
    </article>`;
  }).join("");
  return `<section style="margin:0 0 18px"><h2 style="margin:0 0 8px">Lines of investigation</h2><section class="context">${cards}</section></section>`;
}

/** `total` is the true backlog count (may exceed the rows passed, which are
 *  capped for the payload); the heading and overflow line use it so the header
 *  never claims more than it lists without an "…and N more" hint. Each row shows
 *  its deciding context (score + provenance excerpt) inline. */
function renderTriagePanel(triage: TimelineSynthesis["triage"], total?: number): string {
  if (!triage || !triage.length) return "";
  const count = total ?? triage.length;
  const shown = triage.slice(0, 5);
  const rows = shown.map((t) => {
    const score = t.score != null ? ` <span class="cyan">(score ${escapeHtml(String(t.score))})</span>` : "";
    const excerpt = t.excerpt ? `<div class="meta">“${escapeHtml(t.excerpt)}”${t.url ? ` — ${escapeHtml(t.url)}` : ""}</div>` : t.url ? `<div class="meta">${escapeHtml(t.url)}</div>` : "";
    return `<li><span class="id">${escapeHtml(t.id)}</span>${t.confidence != null ? ` <span class="amber">[${escapeHtml(String(t.confidence))}]</span>` : ""}${score} ${escapeHtml(t.text)}${excerpt}<div class="meta">accept: overcast finding accept ${escapeHtml(t.id)} [--target &lt;id&gt;] · dismiss: overcast finding dismiss ${escapeHtml(t.id)}</div></li>`;
  }).join("");
  const more = count > shown.length
    ? `<li class="meta">…and ${count - shown.length} more (overcast finding list --state suggested)</li>`
    : "";
  return `<section class="panel" style="margin:0 0 18px"><h2>Triage — ${count} awaiting review</h2><ul class="findings">${rows}${more}</ul></section>`;
}

export function renderCsiStatusReport(report: StatusReport): string {
  const payload = report.payload;
  const chips = statusChips(payload);
  const mission = payload.mission as { headline?: string; progress?: Record<string, number> } | undefined;
  const nextActions = Array.isArray(payload.next_actions) ? (payload.next_actions as string[]) : [];
  // mission headline banner (falls back to the legacy tldr for older payloads)
  const tldr = mission?.headline
    ? renderTldr({ headline: mission.headline, next: nextActions })
    : renderTldr(payload.tldr);
  const missionThreads = statusThreads(payload);
  const threads = renderThreadCards(missionThreads);
  // the true backlog count (mission.progress.triage_pending) may exceed the
  // capped rows in payload.triage — pass it so the heading doesn't undercount.
  const triagePending = typeof mission?.progress?.triage_pending === "number" ? mission.progress.triage_pending : undefined;
  const triage = renderTriagePanel(statusTriageRows(payload), triagePending);
  const coverage = renderCoveragePanel(payload);
  const context = renderContextSections(payload);
  // demote operational detail (store/setup/memory/registries) into a collapsed
  // panel grid below the mission board.
  const demoted = new Set(["tldr", "mission", "threads", "coverage", "triage", "gaps", "freshness", "next_actions", "progress", "targets", "sources", "match_visualizations"]);
  const panels = Object.entries(payload).filter(([key]) => !demoted.has(key)).map(([key, value]) => renderStatusPanel(key, value)).join("\n");
  return csiShell(report.title, report.subtitle, `
    ${tldr}
    <section class="stats" aria-label="case status stats">
      ${chips}
    </section>
    ${threads}
    <section class="grid" style="margin:0 0 18px">${triage}${coverage}</section>
    ${context}
    <details data-csi-status="true"><summary>store &amp; setup detail</summary><div class="grid">
      ${panels}
    </div></details>
  `);
}

/** Map status payload threads → the shared thread-card model. The status
 *  payload carries the raw TargetThread structs; without the record store at
 *  render time the resolved finding/latest rows stay empty (the brief export
 *  and the terminal md render the full cards from records). */
function statusThreads(payload: Record<string, unknown>): TimelineSynthesis["threads"] {
  const threads = Array.isArray(payload.threads) ? (payload.threads as Array<Record<string, unknown>>) : [];
  const label: Record<string, string> = { answered: "ANSWERED", "dead-end": "DEAD-END", corroborated: "CORROBORATED", leads: "LEADS", collecting: "COLLECTING", cold: "COLD" };
  return threads.map((th) => {
    const f = th.funnel as { scan: number; captures: number; senses: number; matches: number } | undefined;
    const fnd = th.findings as { accepted?: number; open?: number; suggested?: number } | undefined;
    const bins = Array.isArray(th.activityBins) ? (th.activityBins as number[]) : [];
    const active = th.status === "active";
    const counts = { accepted: fnd?.accepted ?? 0, open: fnd?.open ?? 0, suggested: fnd?.suggested ?? 0 };
    let next: string | undefined;
    if (active && th.stage === "cold") next = "no evidence yet — scan/capture toward this line";
    else if (active && counts.suggested) next = `triage ${counts.suggested} suggested finding${counts.suggested === 1 ? "" : "s"}`;
    return {
      value: String(th.value ?? ""),
      stage: label[String(th.stage)] ?? String(th.stage ?? "").toUpperCase(),
      spark: sparklineFrom(bins),
      sparkWindow: `${bins.length}d`, // daily bins, so length == window days
      funnel: f ? `scan ${f.scan} → capture ${f.captures} → sense ${f.senses} → match ${f.matches}` : "",
      question: typeof th.question === "string" ? th.question : undefined,
      answer: typeof th.narrative === "string" ? th.narrative : undefined,
      findings: [],
      findingCounts: counts,
      latest: [],
      next,
      closed: !active && typeof th.why === "string" ? th.why : undefined,
      dimmed: !active,
    };
  });
}

function statusTriageRows(payload: Record<string, unknown>): TimelineSynthesis["triage"] {
  const triage = Array.isArray(payload.triage) ? (payload.triage as Array<Record<string, unknown>>) : [];
  if (!triage.length) return undefined;
  return triage.map((t) => ({
    id: String(t.id ?? ""),
    text: String(t.text ?? ""),
    confidence: t.confidence,
    score: typeof t.score === "number" ? t.score : undefined,
    excerpt: typeof t.excerpt === "string" ? t.excerpt : undefined,
    url: typeof t.url === "string" ? t.url : undefined,
  }));
}

function renderCoveragePanel(payload: Record<string, unknown>): string {
  const coverage = Array.isArray(payload.coverage) ? (payload.coverage as Array<Record<string, unknown>>) : [];
  const gaps = Array.isArray(payload.gaps) ? (payload.gaps as string[]) : [];
  if (!coverage.length && !gaps.length) return "";
  // same table shape as the brief's coverage panel (coverageTableHtml), built
  // from the raw SourceCoverage rows the status payload carries.
  const rows = coverage.length
    ? `<table class="coverage" data-csi-coverage="true"><thead><tr><th>source</th><th>last scan</th><th>hits</th><th>captured</th><th>sensed</th></tr></thead><tbody>${coverage.map((c) => {
        const age = typeof c.lastScanAgeSeconds === "number" ? fmtAgeHtml(c.lastScanAgeSeconds) : c.gap ? "⚠ never" : "—";
        return `<tr><td>${escapeHtml(String(c.spec))}${c.enabled ? "" : ` <span class="meta">(disabled)</span>`}</td><td${c.gap ? ` class="bad"` : ""}>${escapeHtml(age)}</td><td>${escapeHtml(String(c.hits))}</td><td>${escapeHtml(String(c.captured))}</td><td>${escapeHtml(String(c.sensed))}</td></tr>`;
      }).join("")}</tbody></table>`
    : `<p class="meta">no sources configured</p>`;
  const rest = gaps.filter((g) => !g.endsWith("enabled but never scanned")).slice(0, 5);
  const gapList = rest.length ? `<p class="meta">Gaps:</p><ul class="findings">${rest.map((g) => `<li class="amber">${escapeHtml(g)}</li>`).join("")}</ul>` : "";
  return `<section class="panel"><h2>Coverage</h2>${rows}${gapList}</section>`;
}

/** Compact age for the status coverage table (avoids a components import cycle
 *  in html.ts, mirroring sparklineFrom). */
function fmtAgeHtml(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/** Local sparkline (avoids a components import cycle in html.ts). */
function sparklineFrom(bins: number[]): string | undefined {
  if (!bins.length) return undefined;
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...bins);
  if (max <= 0) return blocks[0].repeat(bins.length);
  return bins.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join("");
}

export interface ClusterGalleryPerson {
  cluster_id: string;
  label?: string | null;
  size?: number;
  sample_crops?: string[];
  at_span?: [number, number] | null;
  sources?: string[];
}

export interface ClusterGalleryReport {
  title: string;
  subtitle?: string;
  clusters: ClusterGalleryPerson[];
  /** whole-store totals — `clusters` may be a page; when provided these drive
   *  the stats so the gallery never understates an off-page person. */
  total?: number;
  named?: number;
  /** face rows in the store — with zero people this flips the empty-state hint
   *  to `cluster recluster` (the op that rebuilds groups from stored rows). */
  storedFaces?: number;
  model?: string | null;
}

/** A self-contained "contact sheet" of the people in a face-cluster index: one
 *  card per person, each with a few base64-embedded face crops, size, time span,
 *  and sources. Reuses the CSI shell + imageSrc so it matches brief/status HTML. */
export function renderClusterGallery(report: ClusterGalleryReport): string {
  const total = report.total ?? report.clusters.length;
  const named = report.named ?? report.clusters.filter((c) => c.label).length;
  const cards = report.clusters.map(renderPersonCard).join("");
  const truncated = total > report.clusters.length
    ? `<article class="context-card"><span class="label">MORE</span><p>showing ${report.clusters.length} of ${total} people — see <code>cluster list</code></p></article>`
    : "";
  return csiShell(report.title, report.subtitle, `
    <section class="stats" aria-label="face cluster stats">
      <div><span class="label">PEOPLE</span><strong>${total}</strong></div>
      <div><span class="label">NAMED</span><strong>${named}</strong></div>
      <div><span class="label">MODEL</span><strong>${escapeHtml(report.model ?? "—")}</strong></div>
    </section>
    <section class="context" data-cluster-gallery="true">
      ${cards || ((report.storedFaces ?? 0) > 0
        ? `<article class="context-card"><span class="label">EMPTY</span><p>${report.storedFaces} stored face${report.storedFaces === 1 ? "" : "s"} but no people — run <code>cluster recluster</code> to rebuild the groups.</p></article>`
        : `<article class="context-card"><span class="label">EMPTY</span><p>No people yet — ingest media with <code>cluster add</code>.</p></article>`)}${truncated}
    </section>
  `);
}

function renderPersonCard(cl: ClusterGalleryPerson): string {
  const title = cl.label || cl.cluster_id;
  const thumbStyle = "height:76px;width:76px;object-fit:cover;border:1px solid var(--line);border-radius:4px;margin:2px;background:#020504";
  const thumbs = (cl.sample_crops ?? [])
    .map((c) => {
      const src = imageSrc(c);
      return src ? `<img alt="${escapeHtml(cl.cluster_id)}" src="${escapeHtml(src)}" style="${thumbStyle}">` : "";
    })
    .join("");
  const span = Array.isArray(cl.at_span) ? `${cl.at_span[0]}s–${cl.at_span[1]}s` : "";
  const sources = (cl.sources ?? []).map((s) => s.split("/").pop() ?? s);
  const meta = [`${cl.size ?? 0} face${cl.size === 1 ? "" : "s"}`, span, ...sources].filter(Boolean).join(" · ");
  return `<article class="context-card">
    <span class="label">PERSON</span>
    <p><strong>${escapeHtml(title)}</strong>${cl.label ? ` <span class="k">${escapeHtml(cl.cluster_id)}</span>` : ""}</p>
    <div style="display:flex;flex-wrap:wrap;gap:2px;margin:8px 0">${thumbs || `<span class="meta">no crops</span>`}</div>
    ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
  </article>`;
}

/** One fanned-out enhance artifact for the split-op gallery — a separated track
 *  (audio + optional spectrogram) or a segmented instance (cutout/mask image). */
export interface EnhanceGalleryItem {
  kind: string; // track | cutout | mask
  ref: string;
  label?: string;
  score?: number;
  speechSeconds?: number;
  segments?: number;
  spectrogram?: string; // local png path (tracks); generated by the caller
  transcript?: string;
}
export interface EnhanceGalleryReport {
  op: string; // "separate" | "segment"
  title: string;
  subtitle?: string;
  sourceRef?: string; // the original media (separate: playable "mixed" track)
  overlaps?: Array<{ at: [number, number]; speakers: string[] }>;
  model?: string;
  caveat?: string; // honest-provenance note surfaced in the gallery (op-specific: ela=lead-not-proof, panorama=distortion)
  items: EnhanceGalleryItem[];
}

/** file:// URL for a local media file (audio/spectrogram), or undefined if gone.
 *  Audio isn't inlined as a data URI (tracks are large); the gallery is opened
 *  locally so a file:// ref plays fine. */
function localMediaUrl(ref: string): string | undefined {
  return existsSync(ref) ? pathToFileURL(ref).href : undefined;
}

/** Render a self-contained HTML gallery for an `enhance` split-op parent: per-track
 *  audio players + spectrograms for `separate`, or per-instance cutouts/masks for
 *  `segment`. Reuses the csi shell so it matches `cluster view` / `brief --csi`. */
export function renderEnhanceGallery(r: EnhanceGalleryReport): string {
  const isSep = r.op === "separate";
  const stats = `<section class="stats" aria-label="enhance split-op stats">
    <div><span class="label">OP</span><strong>${escapeHtml(r.op)}</strong></div>
    <div><span class="label">${isSep ? "TRACKS" : "INSTANCES"}</span><strong>${r.items.length}</strong></div>
    <div><span class="label">MODEL</span><strong>${escapeHtml(r.model ?? "—")}</strong></div>
    ${isSep && r.overlaps?.length ? `<div><span class="label">CROSS-TALK</span><strong>${r.overlaps.length}</strong></div>` : ""}
  </section>`;

  const origUrl = isSep && r.sourceRef ? localMediaUrl(r.sourceRef) : undefined;
  // the original may be a VIDEO (separate ran on a clip); browsers won't play a
  // video's audio inside an <audio> element, so use <video> for it (you still
  // hear the mix, and can see who's speaking). Per-speaker tracks are always WAV.
  const origIsVideo = !!r.sourceRef && /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(r.sourceRef);
  const origMedia = origUrl
    ? origIsVideo
      ? `<video class="embed" controls preload="none" src="${escapeHtml(origUrl)}"></video>`
      : `<audio controls preload="none" src="${escapeHtml(origUrl)}" style="width:100%"></audio>`
    : "";
  const origCard = origUrl
    ? `<article class="card"><div class="card-head"><span class="verb">ORIGINAL</span><span class="media">mixed</span></div>${origMedia}</article>`
    : "";

  const cards = r.items.map((it) => {
    const name = escapeHtml((it.label || it.kind).toUpperCase());
    const bits = [
      it.score != null ? `<span class="state">${it.score.toFixed(2)}</span>` : "",
      it.speechSeconds != null ? `<span class="media">${it.speechSeconds}s speech${it.segments != null ? ` · ${it.segments} seg` : ""}</span>` : "",
    ].join("");
    const head = `<div class="card-head"><span class="verb">${name}</span>${bits}</div>`;
    if (isSep) {
      const a = localMediaUrl(it.ref);
      const player = a ? `<audio controls preload="none" src="${escapeHtml(a)}" style="width:100%"></audio>` : `<p class="meta">track file missing</p>`;
      const spec = it.spectrogram ? (imageSrc(it.spectrogram) ?? (localMediaUrl(it.spectrogram))) : undefined;
      const specImg = spec ? `<img class="embed" alt="spectrogram for ${name}" src="${escapeHtml(spec)}">` : "";
      const tx = it.transcript ? `<p class="summary">${escapeHtml(it.transcript)}</p>` : "";
      return `<article class="card">${head}${player}${specImg}${tx}</article>`;
    }
    const src = imageSrc(it.ref);
    const img = src ? `<img class="embed" alt="${name}" src="${src}">` : `<p class="meta">image missing: ${escapeHtml(it.ref.split("/").pop() ?? it.ref)}</p>`;
    return `<article class="card">${head}${img}</article>`;
  }).join("");

  const overlaps = isSep && r.overlaps?.length
    ? `<section class="panel"><h2>Cross-talk regions</h2><div class="chips">${r.overlaps
        .map((o) => `<span class="chip amber">${o.at[0]}–${o.at[1]}s · ${escapeHtml((o.speakers ?? []).join(" / "))}</span>`)
        .join("")}</div></section>`
    : "";

  const empty = r.items.length === 0
    ? `<section class="panel"><p class="meta">No ${isSep ? "tracks" : "instances"} to show.</p></section>` : "";

  // surface the parent record's honest-provenance caveat (ela/panorama are
  // heuristic leads) prominently in the gallery, not just in the JSON record.
  const caveat = r.caveat
    ? `<section class="panel" style="border-color:var(--amber);box-shadow:0 0 24px rgba(255,209,102,.15)"><h2 style="color:var(--amber)">Caveat</h2><p class="summary">${escapeHtml(r.caveat)}</p></section>`
    : "";

  return csiShell(r.title, r.subtitle, `${stats}${caveat}${overlaps}${empty}<section class="grid">${origCard}${cards}</section>`);
}

export interface ReconstructGalleryView {
  ref: string;
  rotate?: number; // azimuth degrees
  elevate?: number;
  zoom?: number;
}
export interface ReconstructGalleryReport {
  op: string; // "view" | "sweep"
  title: string;
  subtitle?: string;
  /** the non-negotiable speculative banner — rendered loud, never omitted */
  caveat: string;
  sourceRef?: string; // the real captured frame the reconstruction started from
  model?: string;
  views: ReconstructGalleryView[];
  sheet?: string; // sweep contact-sheet png
  turntable?: string; // sweep turntable mp4
}

/** Render a self-contained HTML gallery for a `reconstruct` view/sweep parent:
 *  the REAL source frame beside every synthesized camera stop (az/el/zoom
 *  labeled), plus the sweep's contact sheet and turntable video. The caveat
 *  banner leads the page — synthesized imagery must never read as a capture. */
export function renderReconstructGallery(r: ReconstructGalleryReport): string {
  const banner = `<section class="panel" style="border-color:var(--amber)"><p class="summary" style="color:var(--amber);text-transform:uppercase">⚠ ${escapeHtml(r.caveat)}</p></section>`;
  const stats = `<section class="stats" aria-label="reconstruct stats">
    <div><span class="label">OP</span><strong>${escapeHtml(r.op)}</strong></div>
    <div><span class="label">SYNTHESIZED STOPS</span><strong>${r.views.length}</strong></div>
    <div><span class="label">MODEL</span><strong>${escapeHtml(r.model ?? "—")}</strong></div>
  </section>`;

  const origSrc = r.sourceRef ? imageSrc(r.sourceRef) : undefined;
  const origCard = origSrc
    ? `<article class="card"><div class="card-head"><span class="verb">SOURCE</span><span class="media">captured frame (real)</span></div><img class="embed" alt="source frame" src="${origSrc}"></article>`
    : "";

  const camBits = (v: ReconstructGalleryView) =>
    [
      v.rotate !== undefined ? `<span class="state">az ${Math.round(v.rotate)}°</span>` : "",
      v.elevate !== undefined ? `<span class="cyan">el ${Math.round(v.elevate)}°</span>` : "",
      v.zoom !== undefined ? `<span class="media">zoom ${v.zoom}</span>` : "",
    ].join("");
  const viewCards = r.views.map((v, i) => {
    const src = imageSrc(v.ref);
    const img = src
      ? `<img class="embed" alt="synthesized view ${i + 1}" src="${src}">`
      : `<p class="meta">image missing: ${escapeHtml(v.ref.split("/").pop() ?? v.ref)}</p>`;
    return `<article class="card"><div class="card-head"><span class="verb">SYNTHESIZED</span>${camBits(v)}</div>${img}</article>`;
  }).join("");

  const sheetSrc = r.sheet ? imageSrc(r.sheet) : undefined;
  const sheetCard = sheetSrc
    ? `<section class="panel"><h2>Sweep contact sheet</h2><img class="embed" style="max-width:100%;max-height:none" alt="sweep contact sheet" src="${sheetSrc}"></section>`
    : "";
  const turnUrl = r.turntable ? localMediaUrl(r.turntable) : undefined;
  const turnCard = turnUrl
    ? `<section class="panel"><h2>Turntable</h2><video class="embed" controls loop preload="none" src="${escapeHtml(turnUrl)}"></video></section>`
    : "";

  const empty = r.views.length === 0
    ? `<section class="panel"><p class="meta">No synthesized views to show.</p></section>` : "";

  return csiShell(r.title, r.subtitle, `${banner}${stats}${empty}<section class="grid">${origCard}${viewCards}</section>${sheetCard}${turnCard}`);
}

function csiShell(title: string, subtitle: string | undefined, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${reportCsp()}<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#050708;--panel:#0b1214;--panel2:#10181b;--line:#1f3a3b;--green:#5cff96;--cyan:#38e8ff;--amber:#ffd166;--magenta:#ff4fd8;--text:#d8ffe4;--muted:#8aa69d;--bad:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#10241b 0,#050708 34rem);color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.45}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 48px}.top{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:18px}
h1{margin:0;color:var(--green);font-size:28px;letter-spacing:0;text-transform:uppercase}.subtitle{color:var(--muted);margin-top:6px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:0 0 18px}.stats>div,.panel,.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:6px;box-shadow:0 0 0 1px rgba(92,255,150,.04),0 0 24px rgba(56,232,255,.06)}
.stats>div{padding:10px 12px}.label{display:block;color:var(--muted);font-size:10px;text-transform:uppercase}.stats strong{display:block;color:var(--amber);font-size:20px;margin-top:3px}.chips{display:flex;gap:6px;flex-wrap:wrap;align-content:center}
.chip{display:inline-flex;align-items:center;min-height:22px;padding:2px 7px;border:1px solid var(--line);border-radius:999px;color:var(--green);background:#07100c}.cyan{color:var(--cyan)}.amber{color:var(--amber)}.magenta{color:var(--magenta)}.bad{color:var(--bad)}
.timeline{position:relative;display:grid;gap:10px}.timeline:before{content:"";position:absolute;left:10px;top:0;bottom:0;width:1px;background:linear-gradient(var(--cyan),var(--magenta));opacity:.45}
.card{position:relative;margin-left:28px;padding:12px 14px}.card:before{content:"";position:absolute;left:-23px;top:18px;width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 14px var(--green)}
.card-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.id{color:var(--cyan)}.verb{color:var(--green);font-weight:700}.state{color:var(--amber)}.media{color:var(--magenta)}
.summary{white-space:pre-wrap;word-break:break-word;color:#dfffe9}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}.panel{padding:12px 14px}
.tldr{margin:0 0 18px;padding:14px 16px;background:linear-gradient(180deg,#0c1712,#10181b);border:1px solid var(--line);border-radius:6px;box-shadow:0 0 30px rgba(92,255,150,.08)}.tldr p{margin:6px 0 10px;color:#e6ffed;font-size:15px}.tldr ul{margin:8px 0 0;padding-left:18px}.tldr li{margin:4px 0;color:#d8ffe4}.tldr .next li{color:var(--amber)}
.context{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin:0 0 18px}.context-card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:6px;padding:10px 12px}.context-card img{width:100%;max-height:180px;object-fit:contain;background:#020504;border:1px solid var(--line);border-radius:4px;margin:8px 0}.context-card p{margin:6px 0;color:#dfffe9;word-break:break-word}.context-card .meta{color:var(--muted);font-size:12px}
h2{margin:0 0 8px;color:var(--cyan);font-size:15px;text-transform:uppercase;letter-spacing:0}.kv{display:grid;grid-template-columns:minmax(90px,150px) 1fr;gap:4px 10px}.k{color:var(--muted)}.v{word-break:break-word}
details{margin-top:8px;border-top:1px solid var(--line);padding-top:8px}summary{cursor:pointer;color:var(--amber)}pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;color:#c7ffd8;background:#06100b;padding:8px;border-radius:4px}
video.embed,img.embed,.embed-wrap img{display:block;width:100%;max-width:560px;max-height:340px;object-fit:contain;background:#020504;border:1px solid var(--line);border-radius:4px;margin:10px 0 2px}
.overlay{margin:8px 0 2px}.overlay img{display:block;width:100%;max-width:640px;object-fit:contain;background:#020504;border:1px solid var(--magenta);border-radius:4px}.overlay figcaption{color:var(--magenta);font-size:11px;text-transform:uppercase;margin-top:3px}
.findings li{margin:6px 0}.findings .overlays{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 4px}.findings .overlays img{width:100%;max-width:320px;object-fit:contain;background:#020504;border:1px solid var(--magenta);border-radius:4px}
table.coverage{width:100%;border-collapse:collapse;margin:4px 0}table.coverage th{color:var(--muted);font-size:10px;text-transform:uppercase;text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid var(--line)}table.coverage td{padding:5px 8px 5px 0;border-bottom:1px solid rgba(31,58,59,.5);word-break:break-word}table.coverage td+td,table.coverage th+th{text-align:right;white-space:nowrap}table.coverage td:first-child,table.coverage th:first-child{text-align:left}
</style></head><body><div class="wrap" data-overcast-theme="csi"><header class="top"><h1>${escapeHtml(title)}</h1>${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}</header>${body}</div></body></html>`;
}

function renderContextSections(payload: Record<string, unknown>): string {
  const targets = Array.isArray(payload.targets) ? payload.targets as Record<string, unknown>[] : [];
  const sources = Array.isArray(payload.sources) ? payload.sources as Record<string, unknown>[] : [];
  const matches = Array.isArray(payload.match_visualizations) ? payload.match_visualizations as Record<string, unknown>[] : [];
  const cards = [
    ...targets.slice(0, 6).map((item) => contextCard("TARGET", item, item.image)),
    ...sources.slice(0, 6).map((item) => contextCard("SOURCE", item)),
    ...matches.slice(0, 6).map((item) => contextCard("MATCH", item, item.ref)),
  ].join("");
  return cards ? `<section class="context" data-csi-context="true">${cards}</section>` : "";
}

function contextCard(kind: string, item: Record<string, unknown>, imageRef?: unknown): string {
  const title = item.name ?? item.value ?? item.ref ?? item.id ?? kind;
  const desc = item.description ?? "";
  const img = imageTag(imageRef);
  const meta = [item.kind, item.type, item.state].filter(Boolean).join(" / ");
  return `<article class="context-card">
    <span class="label">${escapeHtml(kind)}</span>
    <p><strong>${escapeHtml(title)}</strong></p>
    ${desc ? `<p>${escapeHtml(desc)}</p>` : ""}
    ${img}
    ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ""}
  </article>`;
}

function imageTag(ref: unknown): string {
  if (typeof ref !== "string" || !ref.trim()) return "";
  const src = imageSrc(ref.trim());
  return src ? `<img alt="${escapeHtml(ref)}" src="${escapeHtml(src)}">` : "";
}

/** A local image ref → inline `data:` URI (or a passed-through `data:image/…`),
 *  or undefined when it isn't a readable local image. Shared by the report shells
 *  and the `map` verb's marker thumbnails. */
export function imageSrc(ref: string): string | undefined {
  if (/^data:image\//i.test(ref)) return ref;
  if (!existsSync(ref)) return undefined;
  const mime = imageMime(ref);
  if (!mime) return undefined;
  try {
    return `data:${mime};base64,${readFileSync(ref).toString("base64")}`;
  } catch {
    return undefined;
  }
}

function imageMime(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    case ".avif": return "image/avif";
    case ".svg": return "image/svg+xml"; // audio-match alignment overlays
    default: return undefined;
  }
}

function renderTldr(value: unknown): string {
  if (value == null || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  const headline = typeof obj.headline === "string" ? obj.headline : "";
  const findings = Array.isArray(obj.findings) ? obj.findings.map(String) : [];
  const next = Array.isArray(obj.next) ? obj.next.map(String) : [];
  return `<section class="tldr" data-csi-tldr="true">
    <span class="label">TL;DR</span>
    ${headline ? `<p>${escapeHtml(headline)}</p>` : ""}
    ${findings.length ? `<ul>${findings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    ${next.length ? `<ul class="next">${next.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
  </section>`;
}

function renderTimelineCard(record: TimelineRecord, index: number): string {
  const state = record.state ?? "ready";
  const media = record.media?.ref ? `${record.media.ref}${record.media.at != null ? ` @${Array.isArray(record.media.at) ? record.media.at.join("-") : record.media.at}` : ""}` : "";
  // primary text (newlines preserved for the pre-wrap card), else the shared
  // verb-aware stub — a capture card says "captured dock0.mp4", not a key dump
  const text = summarizePayload(record.payload);
  const stub = () => recordStub({
    verb: record.verb,
    payload: (record.payload ?? {}) as OvercastRecord["payload"],
    media: typeof record.media?.ref === "string" ? { ref: record.media.ref } : undefined,
    error: record.error,
  }, 480);
  const summary = record.error ? `error: ${record.error}` : text.startsWith("payload: ") ? stub() : text;
  const details = safeJson({ payload: record.payload, meta: record.meta, media: record.media });
  return `<article class="card" data-record-id="${escapeHtml(record.id)}">
    <div class="card-head">
      <span class="label">#${index + 1}</span><span class="verb">${escapeHtml(record.verb)}</span><span class="id">${escapeHtml(record.id)}</span><span class="state">${escapeHtml(state)}</span>${media ? `<span class="media">${escapeHtml(media)}</span>` : ""}
    </div>
    <div class="summary">${escapeHtml(summary)}</div>
    ${mediaEmbed(record)}
    <details><summary>record details</summary><pre>${escapeHtml(details)}</pre></details>
  </article>`;
}

const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|ogv|3gp)$/i;

/** Whether a media ref points at playable video — a direct video URL (X's CDN
 *  serves extensionless variants under video.twimg.com) or a local video file. */
function isVideoMediaRef(ref: string): boolean {
  if (/^https?:\/\//i.test(ref)) {
    const path = ref.replace(/[?#].*$/, "");
    return VIDEO_EXT_RE.test(path) || /^https?:\/\/video\.twimg\.com\//i.test(ref);
  }
  return VIDEO_EXT_RE.test(ref);
}

/** Inline player/preview for a record's media: remote video URLs embed as-is,
 *  local video files via file:// (the `view` verb convention — the export is
 *  opened locally), local images as data URIs, remote images by URL. A scan
 *  hit's `thumb` doubles as the video poster so cards preview without loading. */
function mediaEmbed(record: TimelineRecord): string {
  const parts: string[] = [];
  const payload = typeof record.payload === "object" && record.payload != null ? (record.payload as Record<string, unknown>) : {};
  const ref = record.media?.ref;
  if (typeof ref === "string" && ref.trim()) {
    // Remote embeds beacon the analyst's IP to the investigated host on open, so
    // they're OFF unless OVERCAST_REPORT_REMOTE_MEDIA=1 (the CSP enforces this too).
    const remoteOk = reportRemoteMediaEnabled();
    // poster preference: an extracted local poster frame (record.poster), else a
    // remote thumb (only when remote media is allowed). A poster lets us keep
    // preload="none" — the browser never opens the (possibly huge) video until the
    // user clicks play, so a page full of clips loads and plays instantly.
    const posterSrc = record.poster ? imageSrc(record.poster) : undefined;
    const remoteThumb = typeof payload.thumb === "string" && /^https?:\/\//i.test(payload.thumb) ? payload.thumb : undefined;
    const poster = posterSrc ?? (remoteOk ? remoteThumb : undefined);
    if (isVideoMediaRef(ref)) {
      const remote = /^https?:\/\//i.test(ref);
      if (remote && !remoteOk) {
        parts.push(remoteBlockedEmbed(ref));
      } else {
        const src = remote ? ref : existsSync(ref) ? pathToFileURL(ref).href : undefined;
        if (src) {
          parts.push(`<video class="embed" controls preload="none"${poster ? ` poster="${escapeHtml(poster)}"` : ""} src="${escapeHtml(src)}"></video>`);
        }
      }
    } else if (/^https?:\/\//i.test(ref) && VISUAL_EXT_RE.test(ref)) {
      parts.push(remoteOk ? `<img class="embed" alt="${escapeHtml(ref)}" src="${escapeHtml(ref)}">` : remoteBlockedEmbed(ref));
    } else {
      const t = imageTag(ref);
      if (t) parts.push(`<div class="embed-wrap">${t}</div>`);
    }
  }
  // match-draw overlays live in the payload (image/face match records), not
  // media.ref — surface them so a match card shows the geometric proof, not just
  // the source video.
  if (record.verb === "image" || record.verb === "face") {
    for (const overlay of collectVisualRefs(payload).slice(0, 3)) {
      const t = imageTag(overlay);
      if (t) parts.push(`<figure class="overlay">${t}<figcaption>match overlay</figcaption></figure>`);
    }
  }
  return parts.join("");
}

function renderStatusPanel(key: string, value: unknown): string {
  const rows = flatRows(value).slice(0, 12);
  const kv = rows.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join("");
  return `<section class="panel"><h2>${escapeHtml(key)}</h2><div class="kv">${kv || `<span class="k">value</span><span class="v">${escapeHtml(summaryValue(value))}</span>`}</div><details><summary>details</summary><pre>${escapeHtml(safeJson(value))}</pre></details></section>`;
}

function statusChips(payload: Record<string, unknown>): string {
  const records = valueAt(payload, ["store", "records"]);
  const targets = valueAt(payload, ["registries", "targets"]);
  const sources = valueAt(payload, ["registries", "sources"]);
  const indexes = valueAt(payload, ["registries", "indexes"]);
  return [
    `<div><span class="label">INITIALIZED</span><strong>${escapeHtml(valueAt(payload, ["initialized"]) ?? "false")}</strong></div>`,
    `<div><span class="label">RECORDS</span><strong>${escapeHtml(records ?? 0)}</strong></div>`,
    `<div class="chips"><span class="chip cyan">targets ${escapeHtml(targets ?? 0)}</span><span class="chip amber">sources ${escapeHtml(sources ?? 0)}</span><span class="chip magenta">indexes ${escapeHtml(indexes ?? 0)}</span></div>`,
  ].join("");
}

function countByVerb(records: TimelineRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.verb] = (counts[r.verb] ?? 0) + 1;
  return counts;
}

export function summarizePayload(payload: unknown): string {
  if (payload == null) return "(empty)";
  if (typeof payload === "string") return payload.length > 480 ? `${payload.slice(0, 480)}...` : payload;
  if (typeof payload !== "object") return String(payload);
  const obj = payload as Record<string, unknown>;
  // the SHARED primary-text precedence (record.ts) — summary first, so match
  // records show their result line, not a key dump
  for (const key of PRIMARY_TEXT_FIELDS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.length > 480 ? `${value.slice(0, 480)}...` : value;
  }
  return Object.keys(obj).length ? `payload: ${Object.keys(obj).join(", ")}` : "(empty)";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function flatRows(value: unknown, prefix = ""): Array<[string, string]> {
  if (value == null || typeof value !== "object") return [[prefix || "value", summaryValue(value)]];
  if (Array.isArray(value)) return [["count", String(value.length)], ...value.slice(0, 6).map((v, i): [string, string] => [`${prefix}${i}`, summaryValue(v)])];
  const rows: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v as Record<string, unknown>);
      rows.push([key, keys.length ? keys.join(", ") : "{}"]);
    } else {
      rows.push([key, summaryValue(v)]);
    }
  }
  return rows;
}

function summaryValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value != null && typeof value === "object") return Object.keys(value as Record<string, unknown>).join(", ") || "{}";
  return String(value ?? "");
}

function valueAt(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function recordToTimelineRecord(record: OvercastRecord): TimelineRecord {
  return {
    id: record.id,
    verb: record.verb,
    state: record.state ?? "ready",
    media: record.media ?? null,
    meta: record.meta,
    payload: record.payload,
    error: record.error ?? undefined,
  };
}
