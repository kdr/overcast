// Phase 4 read-side verbs: ask (retrieve + cite over case memory) and brief
// (synthesize the case into a report, --export to md/html). Both read through
// the bound memory providers (fan-out); v1 ships the local provider.

import { writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { makeRecord, type OvercastRecord } from "../record.js";
import { resolveMemory, fanOutAnswer } from "../providers/memory/index.js";
import type { QueryOpts } from "../providers/memory/types.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function queryOpts(ctx: VerbContext): QueryOpts {
  const opts: QueryOpts = {};
  if (ctx.opts.verb) opts.verbs = String(ctx.opts.verb).split(",").map((s) => s.trim());
  if (ctx.opts.since) opts.since = String(ctx.opts.since);
  if (ctx.opts.limit != null) opts.limit = Number(ctx.opts.limit);
  return opts;
}

// ---- ask -------------------------------------------------------------------

export const askVerb: VerbSpec = {
  name: "ask",
  group: "read",
  summary: "Natural-language query over the case memory; answers with record.id + media.at citations.",
  description:
    "Retrieves over the bound memory providers (fan-out; local always on) and answers with citations " +
    "to record.id and media.at. --deep forces agentic deepsearch (cloudglue, Phase 5).",
  args: [{ name: "question", summary: "The question to answer", required: true }],
  flags: [
    { name: "deep", summary: "Agentic semantic search (cloudglue)", type: "boolean" },
    { name: "memory", summary: "Restrict to specific memory provider ids", type: "string" },
    { name: "since", summary: "Time filter (e.g. 24h, 2026-06-01)", type: "string" },
    { name: "verb", summary: "Restrict to record kinds (comma list)", type: "string" },
    { name: "limit", summary: "Max passages", type: "number" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "answer",
  providerKey: "ask",
  run: async (ctx) => {
    if (!ctx.input) {
      return [makeRecord({ verb: "ask", format: "json", payload: { error: "ask requires a question" }, error: "ask requires a question", state: "error" })];
    }
    let providers = resolveMemory(ctx.case, ctx.profile);
    if (ctx.opts.memory) {
      const ids = new Set(String(ctx.opts.memory).split(",").map((s) => s.trim()));
      providers = providers.filter((p) => ids.has(p.id));
    }
    const answer = await fanOutAnswer(providers, ctx.input, queryOpts(ctx), ctx.opts.deep === true);
    return [
      makeRecord({
        verb: "ask",
        format: "md",
        payload: { text: answer.text, citations: answer.citations, question: ctx.input },
        meta: { provider: providers.map((p) => p.id).join(","), case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};

// ---- brief -----------------------------------------------------------------

interface BriefData {
  md: string;
  counts: Record<string, number>;
  total: number;
}

/** Build a markdown brief from the case records (timeline + by-kind sections). */
function buildBrief(records: OvercastRecord[], caseName: string): BriefData {
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.verb] = (counts[r.verb] ?? 0) + 1;

  // sort by time when available (records without time keep insertion order)
  const sorted = [...records].sort((a, b) => {
    const ta = a.meta?.time ? Date.parse(String(a.meta.time)) : 0;
    const tb = b.meta?.time ? Date.parse(String(b.meta.time)) : 0;
    return ta - tb;
  });

  const lines: string[] = [];
  lines.push(`# Brief — ${caseName}`, "");
  lines.push(`**Records:** ${records.length}`, "");
  lines.push("## Summary by kind", "");
  for (const [verb, n] of Object.entries(counts).sort()) lines.push(`- \`${verb}\`: ${n}`);
  lines.push("", "## Timeline / findings", "");
  for (const r of sorted) {
    const at = r.media?.at != null ? ` @${Array.isArray(r.media.at) ? r.media.at.join("-") : r.media.at}s` : "";
    const ref = r.media?.ref ? ` (${r.media.ref})` : "";
    let head = "";
    if (typeof r.payload === "string") head = r.payload.slice(0, 160);
    else {
      const p = r.payload as Record<string, unknown>;
      head =
        (p.title as string) ||
        (p.content as string)?.slice?.(0, 160) ||
        (p.text as string)?.slice?.(0, 160) ||
        Object.keys(p).join(", ");
    }
    lines.push(`- **${r.verb}** \`${r.id}\`${at}${ref}: ${String(head).replace(/\s+/g, " ").trim()}`);
  }
  return { md: lines.join("\n"), counts, total: records.length };
}

function mdToHtml(md: string, title: string): string {
  // minimal, dependency-free md→html for the export artifact
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = md
    .split("\n")
    .map((line) => {
      if (/^# /.test(line)) return `<h1>${esc(line.slice(2))}</h1>`;
      if (/^## /.test(line)) return `<h2>${esc(line.slice(3))}</h2>`;
      if (/^- /.test(line)) return `<li>${esc(line.slice(2))}</li>`;
      if (line.trim() === "") return "";
      return `<p>${esc(line)}</p>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{background:#08120c;color:#c6f7d5;font-family:ui-monospace,monospace;max-width:840px;margin:2rem auto;padding:1rem}
h1,h2{color:#ffc400}code{color:#00ff7f}li{margin:2px 0}</style></head><body>
${body}
</body></html>`;
}

export const briefVerb: VerbSpec = {
  name: "brief",
  group: "read",
  summary: "Synthesize the case records into a report (timeline + findings); --export to md/html.",
  description:
    "Produces a structured report from accumulated records. --export writes a shareable md/html " +
    "artifact (format inferred from the file extension).",
  args: [],
  flags: [
    { name: "scope", summary: "Filter, e.g. since:24h or verb:watch", type: "string" },
    { name: "export", summary: "Write a report file (.md or .html)", type: "string" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "brief",
  providerKey: "brief",
  run: async (ctx) => {
    let records = ctx.case.records();
    // simple scope filter: since:<when> | verb:<kind>
    const scope = ctx.opts.scope ? String(ctx.opts.scope) : "";
    const m = scope.match(/^(since|verb):(.+)$/);
    if (m) {
      if (m[1] === "verb") records = records.filter((r) => r.verb === m[2]);
      // since handled loosely; the local provider's since logic is reused by ask
    }
    const info = ctx.case.exists() ? ctx.case.info() : { name: "case" };
    const brief = buildBrief(records, info.name);

    let exported: string | undefined;
    if (ctx.opts.export) {
      const path = resolve(String(ctx.opts.export));
      const isHtml = extname(path).toLowerCase() === ".html";
      writeFileSync(path, isHtml ? mdToHtml(brief.md, `Brief — ${info.name}`) : brief.md, "utf8");
      exported = path;
    }

    return [
      makeRecord({
        verb: "brief",
        format: "md",
        payload: { report: brief.md, counts: brief.counts, total: brief.total, export: exported ?? null },
        meta: { case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};
