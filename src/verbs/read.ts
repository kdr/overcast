// Phase 4 read-side verbs: ask (retrieve + cite over case memory) and brief
// (synthesize the case into a report, --export to md/html). Both read through
// the bound memory providers (fan-out); currently the local provider.

import { writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { makeRecord, memoryRecords, type OvercastRecord } from "../record.js";
import { mdToPlainHtml, normalizeHtmlTheme, recordToTimelineRecord, renderCsiTimelineReport } from "../report/html.js";
import { resolveMemory, fanOutAnswer, matchesMemoryProvider } from "../providers/memory/index.js";
import { parseSince } from "../providers/memory/local.js";
import { tcAsk } from "../providers/tinycloud/collection.js";
import { tinycloudBaseFromRun } from "../providers/tinycloud/envelope.js";
import { resolveIndexRef } from "../state/index.js";
import { badNumber } from "./validate.js";
import { providerEnv } from "../providers/provider-env.js";
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
    "Retrieves over bound case-search memory providers (local-grep always on; optional qmd) and answers " +
    "with citations to record.id and media.at. Plain ask uses local-grep; use --deep or --memory qmd after `setup memory qmd` for qmd-backed local semantic search.",
  args: [{ name: "question", summary: "The question to answer", required: true }],
  flags: [
    { name: "deep", summary: "Use a provider's semantic/deep search path when available (e.g. qmd)", type: "boolean" },
    { name: "index", summary: "Answer over a media-descriptions index (id/name) via tinycloud, not local memory", type: "string" },
    { name: "probe", summary: "With --index: semantic moment search (probe) instead of Q&A (ask)", type: "boolean" },
    { name: "scope", summary: "With --index --probe: file | segment", type: "string" },
    { name: "memory", summary: "Restrict to memory provider/backend ids (local-grep/local, qmd)", type: "string" },
    { name: "since", summary: "Time filter (e.g. 24h, 2026-06-01)", type: "string" },
    { name: "verb", summary: "Restrict to record kinds (comma list)", type: "string" },
    { name: "limit", summary: "Max local passages; with --index --probe, max probe results", type: "number" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "answer",
  providerKey: "ask",
  run: async (ctx) => {
    if (!ctx.input) {
      return [askError("ask requires a question")];
    }
    // a non-finite/non-positive/blank --limit is a user error, not a silent fall-back
    // to the default breadth — validated up front (via the SHARED validator) so BOTH
    // the local-memory and the --index paths reject it.
    const limitErr = badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number");
    if (limitErr) return [askError(limitErr)];
    // --probe/--scope only apply to a tinycloud index query (--index);
    // --scope only in probe mode. Gate on `== null` (truly omitted), so an empty
    // `--index=` still routes into the index branch below (which rejects
    // it) rather than being mistaken for a local-memory ask.
    if (ctx.opts.index == null && (ctx.opts.probe === true || ctx.opts.scope)) {
      return [askError("--probe/--scope only apply with --index (a media-descriptions index)")];
    }
    if (ctx.opts.scope != null && !String(ctx.opts.scope).trim()) {
      return [askError("--scope requires a value (file | segment)")];
    }
    if (ctx.opts.scope && ctx.opts.probe !== true) {
      return [askError("--scope only applies with --probe (probe = semantic moment search)")];
    }
    // --index: answer over a tinycloud media-descriptions index (the
    // index of a target's videos) instead of the local case memory. The id/name
    // resolves through the case mirror to the real tinycloud index id. Gate on
    // `!= null` so a PROVIDED-but-empty `--index=` is rejected here, not
    // silently treated as omitted (→ a local-memory ask).
    if (ctx.opts.index != null) {
      // tinycloud index Q&A supports --probe; --scope/--limit apply only
      // to probe. Reject unsupported flags instead of silently dropping them.
      if (ctx.opts.limit != null && ctx.opts.probe !== true) {
        return [askError("--limit with --index only applies with --probe (tinycloud ask does not support a limit flag)")];
      }
      // a tinycloud index ask/probe supports only --probe/--scope/--limit
      // (with --scope/--limit probe-only, above);
      // the local-memory flags (--deep/--memory/--verb) and the --since time
      // filter don't apply — reject them rather than silently ignoring them.
      const unsupported = (["deep", "memory", "verb", "since"] as const).filter(
        (f) => ctx.opts[f] != null && ctx.opts[f] !== false,
      );
      if (unsupported.length) {
        return [askError(`--${unsupported.join(", --")} ${unsupported.length > 1 ? "aren't" : "isn't"} supported with --index (it queries a tinycloud index, not local case memory)`)];
      }
      const value = String(ctx.opts.index).trim();
      if (!value) return [askError("--index requires an index id or name")];
      // resolve through the mirror: error on an ambiguous display name, and on a
      // mirrored index whose type isn't ask-able (ask/probe only read
      // media-descriptions). An unmirrored value is passed through as a raw id.
      const ref = resolveIndexRef(ctx.case, value);
      if (ref.error) return [askError(ref.error)];
      const entry = ref.entry;
      if (entry && entry.type !== "media-descriptions" && entry.type !== "unknown") {
        return [askError(`index ${entry.id} is type '${entry.type}', not media-descriptions — ask/probe only reads media-descriptions indexes (use \`face --match … --index\` for face-analysis, \`index entities\` for entities)`)];
      }
      const colId = entry?.id ?? value;
      const limit = ctx.opts.limit != null ? Number(ctx.opts.limit) : undefined;
      const rec = await tcAsk(ctx.input, colId, {
        probe: ctx.opts.probe === true,
        scope: ctx.opts.scope ? String(ctx.opts.scope) : undefined,
        limit,
        env: providerEnv(ctx.case.mediaDir),
        // honor a pinned tinycloud in the profile (same as the `index` verb),
        // not just OVERCAST_TINYCLOUD_CMD / `tinycloud` on PATH.
        base: tinycloudBaseFromRun(ctx.profile.providers?.index?.run ?? ctx.profile.providers?.collection?.run),
        signal: ctx.signal,
      });
      rec.meta = { ...rec.meta, case: ctx.case.dir };
      return [rec];
    }
    // an unparseable --since is a user error, not a silent "no time bound"
    if (ctx.opts.since && parseSince(String(ctx.opts.since)) == null) {
      return [askError(`invalid --since value: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
    }
    const available = resolveMemory(ctx.case, ctx.profile);
    let providers = available.filter((p) => matchesMemoryProvider(p, "local-grep"));
    if (ctx.opts.memory) {
      const ids = String(ctx.opts.memory).split(",").map((s) => s.trim()).filter(Boolean);
      providers = available.filter((p) => ids.some((id) => matchesMemoryProvider(p, id)));
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
    if (ctx.opts.deep === true) {
      providers = (ctx.opts.memory ? providers : available).filter((p) => typeof p.deepsearch === "function");
      if (providers.length === 0) {
        return [
          askError(
            "no semantic memory provider is configured for --deep " +
              "(run `overcast setup memory qmd` and `overcast case memory index rebuild --memory qmd`, or use plain `ask` for local-grep)",
          ),
        ];
      }
    }
    let answer;
    try {
      answer = await fanOutAnswer(providers, ctx.input, queryOpts(ctx), ctx.opts.deep === true);
    } catch (e) {
      return [askError((e as Error).message)];
    }
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
  records: OvercastRecord[];
}

/** Build a markdown brief from the case records (timeline + by-kind sections). */
function buildBrief(records: OvercastRecord[], caseName: string): BriefData {
  // Exclude read/meta and operational outputs (ask/brief/case/setup/doctor/etc.)
  // so briefs and memory search stay evidence-focused instead of citing setup
  // probes, doctor checks, or prior read envelopes as findings.
  records = memoryRecords(records);
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
  return { md: lines.join("\n"), counts, total: records.length, records: sorted };
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
    { name: "theme", summary: "HTML export theme: plain | csi", type: "string", choices: ["plain", "csi"], default: "plain" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "brief",
  providerKey: "brief",
  run: async (ctx) => {
    let records = ctx.case.records();
    // a provided-but-blank `--scope=` is a user error (it would otherwise fall
    // through to the positional / no-filter and silently emit the FULL brief),
    // consistent with ask/face/index rejecting blank flags.
    if (ctx.opts.scope != null && !String(ctx.opts.scope).trim()) {
      return [readError("brief", "--scope requires a value (since:<when> | verb:<kind>)")];
    }
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
    const theme = normalizeHtmlTheme(ctx.opts.theme);
    if (!theme) return [readError("brief", `invalid --theme '${ctx.opts.theme}' (expected plain or csi)`)];
    if (brief.total === 0) {
      return [
        makeRecord({
          verb: "brief",
          format: "md",
          payload: {
            report: brief.md,
            counts: brief.counts,
            total: 0,
            export: null,
            note: "no evidence records to brief; add watch/listen/see/face/scan/capture/note/finding records first",
          },
          meta: { transient: true },
          state: "pending",
        }),
      ];
    }

    let exported: string | undefined;
    if (ctx.opts.export) {
      const path = resolve(String(ctx.opts.export));
      const isHtml = extname(path).toLowerCase() === ".html";
      const html = theme === "csi"
        ? renderCsiTimelineReport({
            title: `Brief — ${info.name}`,
            subtitle: ctx.case.dir,
            kind: "brief",
            records: brief.records.map(recordToTimelineRecord),
            counts: brief.counts,
            total: brief.total,
          })
        : mdToPlainHtml(brief.md, `Brief — ${info.name}`);
      writeFileSync(path, isHtml ? html : brief.md, "utf8");
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
