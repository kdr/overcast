import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { OvercastRecord } from "../record.js";

export type HtmlTheme = "plain" | "csi";

export interface TimelineRecord {
  id: string;
  verb: string;
  state?: string;
  media?: { ref?: string; at?: number | [number, number] | string | null } | null;
  meta?: Record<string, unknown>;
  payload?: unknown;
  error?: string;
}

/** Record-derived brief header (see BriefSynthesis in verbs/read.ts): narrative
 *  TL;DR + coverage verdict + sources-checked + matches, rendered above the
 *  timeline so the export reads as a report, not a record dump. */
export interface TimelineSynthesis {
  tldr?: string;
  verdict: string;
  sources: Array<{ source: string; hits: number }>;
  findings: Array<{ id: string; status: string; text: string; confidence?: unknown; overlays?: string[] }>;
}

const VISUAL_EXT_RE = /\.(avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
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
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
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

/** The brief's narrative header: TL;DR banner (analyst note + coverage verdict)
 *  and sources-checked / matches panels. An explicit "none recorded" is rendered
 *  rather than omitting the panel — "we checked and found nothing" is a result. */
function renderSynthesis(syn: TimelineSynthesis | undefined): string {
  if (!syn) return "";
  const tldr = renderTldr({
    headline: syn.tldr ?? syn.verdict,
    findings: syn.tldr ? [syn.verdict] : [],
  });
  const sources = syn.sources.length
    ? `<ul>${syn.sources.map((s) => `<li><strong>${escapeHtml(s.source)}</strong> — ${s.hits} hit${s.hits === 1 ? "" : "s"}</li>`).join("")}</ul>`
    : `<p class="meta">none — no scan hits in scope</p>`;
  const findings = syn.findings.length
    ? `<ul class="findings">${syn.findings.map((f) => {
        const overlays = (f.overlays ?? []).map((ref) => imageTag(ref)).filter(Boolean).slice(0, 3).join("");
        return `<li><span class="id">${escapeHtml(f.id)}</span> <span class="state">[${escapeHtml(f.status)}]</span>${f.confidence != null ? ` <span class="meta">(confidence: ${escapeHtml(String(f.confidence))})</span>` : ""} ${escapeHtml(f.text)}${overlays ? `<div class="overlays" data-csi-overlays="true">${overlays}</div>` : ""}</li>`;
      }).join("")}</ul>`
    : `<p class="meta">none recorded</p>`;
  return `${tldr}
    <section class="grid" data-csi-synthesis="true" style="margin:0 0 18px">
      <section class="panel"><h2>Sources checked</h2>${sources}</section>
      <section class="panel"><h2>Matches &amp; findings</h2>${findings}</section>
    </section>`;
}

export function renderCsiStatusReport(report: StatusReport): string {
  const payload = report.payload;
  const chips = statusChips(payload);
  const tldr = renderTldr(payload.tldr);
  const context = renderContextSections(payload);
  const promoted = new Set(["tldr", "targets", "sources", "match_visualizations"]);
  const panels = Object.entries(payload).filter(([key]) => !promoted.has(key)).map(([key, value]) => renderStatusPanel(key, value)).join("\n");
  return csiShell(report.title, report.subtitle, `
    ${tldr}
    ${context}
    <section class="stats" aria-label="case status stats">
      ${chips}
    </section>
    <main class="grid" data-csi-status="true">
      ${panels}
    </main>
  `);
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

function csiShell(title: string, subtitle: string | undefined, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
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

function imageSrc(ref: string): string | undefined {
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
  const summary = record.error ? `error: ${record.error}` : summarizePayload(record.payload);
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
    const poster = typeof payload.thumb === "string" && /^https?:\/\//i.test(payload.thumb) ? payload.thumb : undefined;
    if (isVideoMediaRef(ref)) {
      const src = /^https?:\/\//i.test(ref) ? ref : existsSync(ref) ? pathToFileURL(ref).href : undefined;
      if (src) parts.push(`<video class="embed" controls preload="none"${poster ? ` poster="${escapeHtml(poster)}"` : ""} src="${escapeHtml(src)}"></video>`);
    } else if (/^https?:\/\//i.test(ref) && VISUAL_EXT_RE.test(ref)) {
      parts.push(`<img class="embed" alt="${escapeHtml(ref)}" src="${escapeHtml(ref)}">`);
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
  for (const key of ["content", "transcript", "text", "caption", "ocr", "title", "snippet", "summary"]) {
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
