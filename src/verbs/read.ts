// Phase 4 read-side verbs: ask (retrieve + cite over case memory) and brief
// (synthesize the case into a report, --export to md/html). Both read through
// the bound memory providers (fan-out); currently the local provider.

import { writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { makeRecord, isMetaRecord, type OvercastRecord } from "../record.js";
import { resolveMemory, fanOutAnswer } from "../providers/memory/index.js";
import { parseSince } from "../providers/memory/local.js";
import type { QueryOpts } from "../providers/memory/types.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function readError(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
}
const askError = (m: string): OvercastRecord => readError("ask", m);

function queryOpts(ctx: VerbContext): QueryOpts {
  const opts: QueryOpts = {};
  if (ctx.opts.verb) opts.verbs = String(ctx.opts.verb).split(",").map((s) => s.trim());
  if (ctx.opts.since) opts.since = String(ctx.opts.since);
  // only apply a positive, finite limit — a 0 / NaN (non-numeric) limit would
  // otherwise slice everything away and report no matches.
  if (ctx.opts.limit != null) {
    const n = Number(ctx.opts.limit);
    if (Number.isFinite(n) && n > 0) opts.limit = n;
  }
  return opts;
}

// ---- ask -------------------------------------------------------------------

export const askVerb: VerbSpec = {
  name: "ask",
  group: "read",
  summary: "Natural-language query over the case memory; answers with record.id + media.at citations.",
  description:
    "Retrieves over the bound memory providers (fan-out; local always on) and answers with citations " +
    "to record.id and media.at. --deep forces agentic deepsearch (cloudglue, when bound).",
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
      return [askError("ask requires a question")];
    }
    // an unparseable --since is a user error, not a silent "no time bound"
    if (ctx.opts.since && parseSince(String(ctx.opts.since)) == null) {
      return [askError(`invalid --since value: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
    }
    // a non-finite/non-positive --limit is a user error, not a silent fall-back to
    // the default recall breadth (matches scan/case/monitor).
    if (ctx.opts.limit != null) {
      const n = Number(ctx.opts.limit);
      if (!Number.isFinite(n) || n <= 0) {
        return [askError(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
      }
    }
    const available = resolveMemory(ctx.case, ctx.profile);
    let providers = available;
    if (ctx.opts.memory) {
      const ids = new Set(String(ctx.opts.memory).split(",").map((s) => s.trim()));
      providers = available.filter((p) => ids.has(p.id));
      // none matched → surface the real problem instead of "No records match"
      if (providers.length === 0) {
        return [
          askError(
            `no memory providers match --memory ${ctx.opts.memory} ` +
              `(available: ${available.map((p) => p.id).join(", ") || "none"})`,
          ),
        ];
      }
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
  // Exclude read/meta outputs (ask/brief/case) — they restate or duplicate
  // primary records and would otherwise show up as noisy "findings" (e.g. a
  // `case memory get` page slice) and inflate the counts. Same boundary as
  // memory retrieval (isMetaRecord), so brief and search stay consistent.
  records = records.filter((r) => !isMetaRecord(r));
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.verb] = (counts[r.verb] ?? 0) + 1;

  // sort dated records chronologically; undated records go LAST, preserving
  // their original insertion order (decorate-sort-undecorate for stability).
  const sorted = records
    .map((r, i) => {
      const parsed = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
      return { r, i, t: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed };
    })
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.r);

  const lines: string[] = [];
  lines.push(`# Brief — ${caseName}`, "");
  lines.push(`**Records:** ${records.length}`, "");
  lines.push("## Summary by kind", "");
  for (const [verb, n] of Object.entries(counts).sort()) lines.push(`- \`${verb}\`: ${n}`);
  lines.push("", "## Timeline / findings", "");
  for (const r of sorted) {
    const at = r.media?.at != null ? ` @${Array.isArray(r.media.at) ? r.media.at.join("-") : r.media.at}s` : "";
    const ref = r.media?.ref ? ` (${r.media.ref})` : "";
    lines.push(`### \`${r.verb}\` ${r.id}${at}${ref}`, "");
    if (r.error) {
      lines.push(`> error: ${r.error}`, "");
      continue;
    }
    // Embedded record content is DATA, not markup — fence it so a line inside it
    // that starts with #/##/###/- isn't reparsed as a heading or list item (both
    // md viewers and our html exporter honor the fence). Use a fence longer than
    // any backtick run in the body so the content can't close it early.
    const body = briefBody(r);
    const fence = fenceFor(body);
    lines.push(fence, body, fence, "");
  }
  return { md: lines.join("\n"), counts, total: records.length };
}

// Brief is an export artifact: embed each record's primary field IN FULL (not a
// 160-char stub — the bug that made `brief --export` a useless record list).
const BRIEF_PRIMARY_FIELDS = ["content", "transcript", "text", "caption", "ocr", "title", "snippet"];

/** A code fence longer than any backtick run in `body`, so the body can't close
 *  it prematurely (≥3 backticks). */
function fenceFor(body: string): string {
  let max = 0;
  for (const m of body.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}

function briefBody(rec: OvercastRecord): string {
  if (typeof rec.payload === "string") return rec.payload.trim() || "(empty)";
  const p = rec.payload as Record<string, unknown>;
  for (const k of BRIEF_PRIMARY_FIELDS) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
    // a non-string primary value (number/boolean) must not be lost
    if (typeof v === "number" || typeof v === "boolean") return `${k}: ${v}`;
  }
  // no primary text field — list what the payload carries
  return `payload: ${Object.keys(p).join(", ") || "(empty)"}`;
}

function mdToHtml(md: string, title: string): string {
  // minimal, dependency-free md→html for the export artifact
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out: string[] = [];
  let fence: string | null = null; // the opening fence string while inside a code block
  for (const line of md.split("\n")) {
    if (fence == null && /^`{3,}\s*$/.test(line)) {
      fence = line.trim();
      out.push("<pre>");
      continue;
    }
    if (fence != null) {
      // inside a fence: everything is escaped literal data, closed only by the
      // exact matching fence — embedded #/-/``` are NOT treated as markup.
      if (line.trim() === fence) {
        out.push("</pre>");
        fence = null;
      } else {
        out.push(esc(line));
      }
      continue;
    }
    if (/^### /.test(line)) out.push(`<h3>${esc(line.slice(4))}</h3>`);
    else if (/^# /.test(line)) out.push(`<h1>${esc(line.slice(2))}</h1>`);
    else if (/^## /.test(line)) out.push(`<h2>${esc(line.slice(3))}</h2>`);
    else if (/^- /.test(line)) out.push(`<li>${esc(line.slice(2))}</li>`);
    else if (line.trim() === "") out.push("");
    else out.push(`<p>${esc(line)}</p>`);
  }
  const body = out.join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{background:#08120c;color:#c6f7d5;font-family:ui-monospace,monospace;max-width:840px;margin:2rem auto;padding:1rem}
h1,h2{color:#ffc400}code{color:#00ff7f}li{margin:2px 0}
pre{white-space:pre-wrap;word-break:break-word;background:#0d1f14;padding:8px;border-radius:4px}</style></head><body>
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
    // scope filter: since:<when> | verb:<kind>. Scope may arrive via --scope or
    // as a positional argument (the prompt system passes it positionally).
    const scope = (ctx.opts.scope ? String(ctx.opts.scope) : ctx.input ?? "").trim();
    if (scope) {
      const m = scope.match(/^(since|verb):(.+)$/);
      if (!m) {
        return [readError("brief", `invalid --scope '${scope}' (expected since:<when> or verb:<kind>)`)];
      }
      const value = m[2].trim(); // tolerate `verb: watch` / `since: 24h`
      if (m[1] === "verb") {
        records = records.filter((r) => r.verb === value);
      } else {
        // since:<when> — an unparseable value is a user error, not a no-op.
        const cutoff = parseSince(value);
        if (cutoff == null) {
          return [readError("brief", `invalid scope since:${value} (try 24h, 7d, or 2026-06-01)`)];
        }
        // keep records at/after the cutoff (undated records are kept, since we
        // can't prove they're stale).
        records = records.filter((r) => {
          const t = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
          return Number.isNaN(t) || t >= cutoff;
        });
      }
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
