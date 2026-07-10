// Phase 4 read-side verbs: ask (retrieve + cite over case memory) and brief
// (synthesize the case into a report, --export to md/html). Both read through
// the bound memory providers (fan-out); currently the local provider.

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findingStatusMap, makeRecord, memoryRecords, PRIMARY_TEXT_FIELDS, recordStub, recordTimeMs, type OvercastRecord } from "../record.js";
import { isHtmlExportPath, mdToPlainHtml, normalizeHtmlTheme, recordToTimelineRecord, renderCsiTimelineReport, type TimelineRecord, type TimelineSynthesis } from "../report/html.js";
import { briefDelta, coverageTableRows, findingOverlays, rankFindings, renderCoverageMd, renderThreadsMd, renderTriageMd, renderVerdictMd, sweptSources, threadCard, triageRows, type ThreadRenderContext } from "../report/mission.js";
import { casePulse, unattributedScanHits, type CasePulse } from "../signals/pulse.js";
import { groupTimeline, groupSummary } from "../signals/rollup.js";
import { listTargets } from "../state/target.js";
import { listSources } from "../state/source.js";
import { loadSetup } from "../state/setup.js";
import { posterFrame } from "../media/ffmpeg.js";
import { resolveMemory, fanOutAnswer, matchesMemoryProvider } from "../providers/memory/index.js";
import { parseSince } from "../providers/memory/local.js";
import { tcAsk } from "../providers/tinycloud/collection.js";
import { tinycloudBaseFromRun } from "../providers/tinycloud/envelope.js";
import { resolveIndexRef } from "../state/index.js";
import { openBucket, resolveIndexScope, stampArchive } from "../archive.js";
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
    { name: "archive", summary: "Answer over a global archive BUCKET's memory instead of this case (composable with --deep/--memory)", type: "string" },
    { name: "index", summary: "Answer over a media-descriptions index (id/name, or archive:<bucket>/<index>) via tinycloud, not local memory", type: "string" },
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
    // --archive <bucket>: run the SAME local-memory ask, but over the bucket's
    // store + bound backends (buckets are case-shaped, so local-grep/qmd work
    // unchanged). Exclusive with --index — a bucket's REMOTE index is addressed
    // as `--index archive:<bucket>/<index>` instead.
    let memoryCase = ctx.case;
    let archiveBucket: string | undefined;
    if (ctx.opts.archive != null) {
      const name = String(ctx.opts.archive).trim();
      if (!name) return [askError("--archive requires a bucket name")];
      if (ctx.opts.index != null) {
        return [askError("--archive and --index are mutually exclusive — use `--index archive:<bucket>/<index>` to ask a bucket's media-descriptions index")];
      }
      const { bucket, error } = openBucket(name, ctx.home);
      if (!bucket) return [askError(error!)];
      memoryCase = bucket.case;
      archiveBucket = name;
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
      // `--index archive:<bucket>/<index>` resolves through the BUCKET's mirror.
      const scoped = resolveIndexScope(ctx.case, value, ctx.home);
      if (scoped.error) return [askError(scoped.error)];
      // resolve through the mirror: error on an ambiguous display name, and on a
      // mirrored index whose type isn't ask-able (ask/probe only read
      // media-descriptions). An unmirrored value is passed through as a raw id.
      const ref = resolveIndexRef(scoped.scope, scoped.value);
      if (ref.error) return [askError(ref.error)];
      const entry = ref.entry;
      if (entry && entry.type !== "media-descriptions" && entry.type !== "unknown") {
        return [askError(`index ${entry.id} is type '${entry.type}', not media-descriptions — ask/probe only reads media-descriptions indexes (use \`face --match … --index\` for face-analysis, \`index entities\` for entities)`)];
      }
      const colId = entry?.id ?? scoped.value;
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
      return [stampArchive(rec, scoped.bucket, ctx.case.dir)];
    }
    // an unparseable --since is a user error, not a silent "no time bound"
    if (ctx.opts.since && parseSince(String(ctx.opts.since)) == null) {
      return [askError(`invalid --since value: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
    }
    // pass `deep` so the opt-in cloud tier (Cloudglue collection) is resolved ONLY
    // for `ask --deep` — a plain ask never sees it (no silent cloud spend).
    const available = resolveMemory(memoryCase, ctx.profile, { deep: ctx.opts.deep === true, signal: ctx.signal });
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
        // Distinguish "Cloudglue genuinely failed to activate" from "Cloudglue
        // resolved fine but the user filtered it out with --memory". Only the
        // former should blame Cloudglue. Presence in `available` is the signal:
        // resolveMemory registers the cloudglue provider ONLY when it actually
        // activated (opted in + keyed + a resolvable collection).
        const cloudglueOptedIn = loadSetup(memoryCase)?.memory?.cloudglue != null;
        const cloudgluePresent = available.some((p) => matchesMemoryProvider(p, "cloudglue"));
        // Opted in AND genuinely inactive (no cloudglue provider resolved) — the
        // real fix is the Cloudglue setup, NOT qmd. A bare "run setup memory qmd"
        // would misdirect; resolveMemory already wrote the specific reason to stderr.
        if (cloudglueOptedIn && !cloudgluePresent) {
          return [
            askError(
              "the Cloudglue cloud tier is opted in for --deep but inactive " +
                "(check CLOUDGLUE_API_KEY and ensure a media-descriptions index is attached/pinned — " +
                "the specific reason was written to stderr); " +
                "or run `overcast setup memory qmd` for local semantic search, or use plain `ask` for local-grep",
            ),
          ];
        }
        // Cloudglue DID resolve into `available` but `--memory` excluded it — say
        // so instead of the qmd misdirection or (wrongly) blaming Cloudglue.
        if (cloudgluePresent && ctx.opts.memory) {
          return [
            askError(
              `--memory ${ctx.opts.memory} excluded the Cloudglue cloud tier (the only --deep provider available); ` +
                "drop --memory (or include cloudglue) to use it, run `overcast setup memory qmd` for local semantic search, " +
                "or use plain `ask` for local-grep",
            ),
          ];
        }
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
        payload: {
          text: answer.text,
          citations: answer.citations,
          question: ctx.input,
          // cited record ids live in the BUCKET's store — carry where to page
          // them (`case memory get <id> --case <dir>`), or they'd 404 here.
          ...(archiveBucket ? { archive: { bucket: archiveBucket, dir: memoryCase.dir } } : {}),
        },
        meta: { provider: providers.map((p) => p.id).join(","), case: ctx.case.dir, ...(archiveBucket ? { archive: archiveBucket } : {}) },
        state: "ready",
      }),
    ];
  },
};

// ---- brief -----------------------------------------------------------------

const REPORT_VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|ogv|3gp)$/i;

/** Extract a small local poster frame for each local video timeline record that
 *  lacks one, so the HTML player can preview without preload="metadata" opening
 *  the (possibly huge) file. Remote videos are skipped (they carry a `thumb`
 *  poster from the source, or would need a download); failures degrade to no
 *  poster. Best-effort and cached — never throws. */
async function attachVideoPosters(records: TimelineRecord[], mediaDir: string): Promise<void> {
  const posterDir = join(mediaDir, "posters");
  for (const r of records) {
    const ref = r.media?.ref;
    if (r.poster || typeof ref !== "string" || !ref) continue;
    if (/^https?:\/\//i.test(ref)) continue; // remote: source thumb or skip
    const payload = typeof r.payload === "object" && r.payload != null ? (r.payload as Record<string, unknown>) : {};
    if (typeof payload.thumb === "string" && payload.thumb.trim()) continue; // already has a poster source
    if (!REPORT_VIDEO_RE.test(ref) || !existsSync(ref)) continue;
    const poster = await posterFrame(ref, posterDir);
    if (poster) r.poster = poster;
  }
}

interface BriefData {
  md: string;
  counts: Record<string, number>;
  total: number;
  records: OvercastRecord[];
  synthesis: BriefSynthesis;
}

/** Deterministic, record-derived report header: what was checked, what matched,
 *  and the narrative verdict — so an exported brief reads as an investigation
 *  report ("checked these sources, found these matches / found none"), not a
 *  bare record dump. The narrative TL;DR comes from the newest `tldr`-tagged
 *  note; everything else is aggregated from evidence records. No LLM involved. */
export interface BriefSynthesis {
  /** newest note tagged `tldr` (the analyst/agent narrative), if any */
  tldr?: string;
  /** auto-derived one-line coverage + outcome (always present) */
  verdict: string;
  /** scan coverage rollup: hits per source actually swept */
  sources: Array<{ source: string; hits: number }>;
  captures: number;
  /** face / image / see checks run against captured media */
  media_checks: number;
  /** root findings (open/accepted) — the recorded matches/verdicts */
  findings: Array<{ id: string; status: string; text: string; confidence?: unknown; overlays?: string[] }>;
}

function briefSynthesis(records: OvercastRecord[], statusByFinding: Map<string, string>, overlaysByFinding: Map<string, string[]>): BriefSynthesis {
  const p = (r: OvercastRecord): Record<string, unknown> =>
    typeof r.payload === "object" && r.payload != null ? (r.payload as Record<string, unknown>) : {};
  // swept-source rollup via the shared helper so the verdict's hit counts always
  // reconcile with the coverage table's.
  const sources = sweptSources(records);
  const totalHits = sources.reduce((n, s) => n + s.hits, 0);
  const captures = records.filter((r) => r.verb === "capture" && r.state !== "error").length;
  // media checks = actual suspect analysis (image match / face / see), NOT the
  // `image add` fingerprint steps that build the reference index — counting those
  // would inflate the escalation count before any suspect is checked.
  const mediaChecks = records.filter((r) =>
    ["face", "image", "see"].includes(r.verb) && r.state !== "error" && !(r.verb === "image" && p(r).op === "add"),
  ).length;
  const findings = records
    .filter((r) => {
      if (r.verb !== "finding" || r.state === "error") return false;
      const pay = p(r);
      return typeof pay.finding_id !== "string" && typeof pay.status === "string" && typeof pay.text === "string";
    })
    .map((r) => {
      const pay = p(r);
      // reviewed status (accepted/open), not the root record's initial "open"
      const row: BriefSynthesis["findings"][number] = { id: r.id, status: statusByFinding.get(r.id) ?? String(pay.status), text: String(pay.text) };
      if (pay.confidence != null) row.confidence = pay.confidence;
      // match-draw overlays come from the SHARED map (findingOverlays) — the
      // geometric proof for image/face, the offset-alignment plot for audio.
      const overlays = overlaysByFinding.get(r.id);
      if (overlays?.length) row.overlays = overlays;
      return row;
    });
  // newest tldr-tagged note wins (records arrive chronologically sorted)
  let tldr: string | undefined;
  for (const r of records) {
    if (r.verb !== "note" || r.state === "error") continue;
    const pay = p(r);
    const tags = Array.isArray(pay.tags) ? pay.tags.map((t) => String(t).toLowerCase()) : [];
    if (tags.includes("tldr") && typeof pay.text === "string" && pay.text.trim()) tldr = pay.text.trim();
  }
  const s = (n: number) => (n === 1 ? "" : "s");
  const parts = [`${sources.length} source${s(sources.length)} checked (${totalHits} hit${s(totalHits)})`];
  if (captures) parts.push(`${captures} capture${s(captures)}`);
  if (mediaChecks) parts.push(`${mediaChecks} media check${s(mediaChecks)}`);
  const verdict = findings.length
    ? `${parts.join(", ")} — ${findings.length} finding${s(findings.length)} recorded`
    : `${parts.join(", ")} — no findings recorded`;
  return { tldr, verdict, sources, captures, media_checks: mediaChecks, findings };
}

// thread / triage / coverage / verdict sections render through the SHARED
// mission-board renderer (src/report/mission.ts) — one codepath for brief AND
// case status, so the two reports can't drift.

/** Build a markdown brief from the case records. Short (default) tells the
 *  story — verdict, per-line-of-investigation threads (question → answer →
 *  findings → latest evidence → next), triage with deciding context, ONE
 *  coverage table — then a newest-first record trail; `full` swaps the trail
 *  for the verbatim chronological record dump (audit artifact). */
function buildBrief(records: OvercastRecord[], caseName: string, opts: { pulse: CasePulse; full: boolean; caseRecords?: OvercastRecord[]; now?: number }): BriefData {
  const now = opts.now ?? Date.now();
  // case-wide record set (unscoped): a --scope window must not hide pending
  // triage leads NOR drop out-of-window accept/dismiss review rows (which would
  // make an accepted finding read stale `[open]`). Falls back to `records` when
  // not provided (direct callers pass the full set).
  const caseRecords = opts.caseRecords ?? records;
  // reviewed finding statuses come from the FULL case (review rows can land
  // outside the scope window), captured BEFORE memoryRecords drops them.
  const statusByFinding = findingStatusMap(caseRecords);
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
      const parsed = recordTimeMs(r);
      return { r, i, t: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed };
    })
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.r);

  // overlays over the FULL case set (any status, unscoped) — suggested leads in
  // thread cards and out-of-window accepted findings keep their proofs.
  const overlaysByFinding = findingOverlays(caseRecords);
  const synthesis = briefSynthesis(sorted, statusByFinding, overlaysByFinding);
  const threadCtx: ThreadRenderContext = { byId: new Map(caseRecords.map((r) => [r.id, r])), statusByFinding, overlaysByFinding, now };
  const delta = briefDelta(caseRecords, now);

  const lines: string[] = [];
  lines.push(`# Brief — ${caseName}`, "");
  lines.push(`_as of ${new Date(now).toISOString().replace("T", " ").replace(/\..*/, "Z")} · ${records.length} evidence record${records.length === 1 ? "" : "s"}_`, "");
  lines.push(...renderVerdictMd({ tldr: synthesis.tldr, verdict: synthesis.verdict, headline: opts.pulse.headline, delta }));

  lines.push(...renderThreadsMd(opts.pulse.threads, threadCtx));

  // Findings not attached to any line of investigation (all of them, when no
  // lines exist) — linked findings already render inside their thread above.
  const linkedIds = new Set(opts.pulse.threads.flatMap((t) => t.findingIds));
  const ranked = rankFindings(synthesis.findings);
  const unattached = ranked.filter((f) => !linkedIds.has(f.id));
  const heading = opts.pulse.threads.length ? "## Other findings" : "## Key findings";
  if (unattached.length || !opts.pulse.threads.length) {
    lines.push(heading, "");
    if (opts.pulse.threads.length) {
      lines.push("_not linked to a line of investigation — attribute with `overcast finding accept <id> --target <target>`_", "");
    }
    if (unattached.length) {
      for (const f of unattached.slice(0, 8)) {
        const conf = f.confidence != null ? ` (confidence: ${f.confidence})` : "";
        lines.push(`- \`${f.id}\` [${f.status}]${conf} ${f.text}`);
        for (const ref of f.overlays ?? []) lines.push(`  ![match overlay](${ref})`);
      }
      if (unattached.length > 8) lines.push(`- …and ${unattached.length - 8} more`);
    } else {
      lines.push("- none recorded");
    }
    lines.push("");
  }

  const triage = triageRows(caseRecords, statusByFinding);
  lines.push(...renderTriageMd(triage, triage.length));
  // the Coverage table reflects the STANDING case, like the pulse it joins
  // against — ad-hoc rows come from the record-level attribution rule
  // (unattributedScanHits), never label arithmetic, so a hit is counted exactly
  // once. The scoped rollup still drives the verdict line (synthesis.sources).
  lines.push(...renderCoverageMd(opts.pulse.coverage, unattributedScanHits(caseRecords, opts.pulse.coverage), opts.pulse.gaps));

  // Appendix: the record trail. Short = a compact NEWEST-FIRST index with
  // page-it pointers (catching up reads top-down); full = each record's primary
  // field embedded verbatim, chronological (the audit dump).
  if (opts.full) {
    lines.push("## Timeline / findings", "");
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
  } else {
    lines.push(`## Record trail — ${sorted.length} evidence record${sorted.length === 1 ? "" : "s"}`, "");
    lines.push("_newest first — read any in full with_ `overcast case memory get <id>` _· `brief --full` for the verbatim timeline_", "");
    // When a case fans out (many records per capture/sweep), group by media chain
    // so the trail reads as "one artifact, N looks" instead of dozens of rows.
    const byId = new Map(sorted.map((r) => [r.id, r]));
    const groups = groupTimeline(sorted);
    if (groups.length >= 12 && groups.length < sorted.length) {
      // newest-first by the group's NEWEST record (g.time) — reversing first-seen
      // order isn't enough: an old artifact that just received new senses must
      // surface at the top. Undated groups sort newest (can't be proven stale),
      // matching the ungrouped path; the sort is stable so ties keep group order.
      const newestFirst = [...groups].sort((a, b) => {
        const ta = a.time ? Date.parse(a.time) : Number.POSITIVE_INFINITY;
        const tb = b.time ? Date.parse(b.time) : Number.POSITIVE_INFINITY;
        return tb - ta;
      });
      for (const g of newestFirst) {
        const when = g.time ? g.time.replace("T", " ").replace(/\..*/, "") : "—";
        lines.push(`- **${g.title}** · ${when} — ${groupSummary(g)}`);
        // surface the group's most informative record inline as a one-liner
        const lead = g.recordIds.map((id) => byId.get(id)).find((r) => r && !r.error && r.verb !== "capture");
        if (lead) lines.push(`  - \`${lead.id}\` ${lead.verb}: ${recordStub(lead)}`);
      }
    } else {
      for (const r of [...sorted].reverse()) {
        const when = r.meta?.time ? String(r.meta.time).replace("T", " ").replace(/\..*/, "") : "—";
        const at = r.media?.at != null ? ` @${Array.isArray(r.media.at) ? r.media.at.join("-") : r.media.at}s` : "";
        lines.push(`- \`${r.id}\` **${r.verb}**${at} · ${when} — ${recordStub(r)}`);
      }
    }
    lines.push("");
  }
  return { md: lines.join("\n"), counts, total: records.length, records: sorted, synthesis };
}

/** Fold the pulse's headline + thread cards + triage + coverage into the CSI
 *  synthesis header so the exported HTML tells the same story as the markdown. */
function enrichSynthesis(syn: BriefSynthesis, pulse: CasePulse, records: OvercastRecord[], now = Date.now()): TimelineSynthesis {
  const statusByFinding = findingStatusMap(records);
  const overlaysByFinding = findingOverlays(records);
  const ctx: ThreadRenderContext = { byId: new Map(records.map((r) => [r.id, r])), statusByFinding, overlaysByFinding, now };
  const triage = triageRows(records, statusByFinding);
  const linkedIds = new Set(pulse.threads.flatMap((t) => t.findingIds));
  return {
    ...syn,
    // unattached findings only (linked ones render inside their thread card),
    // ranked + capped like the markdown so --export and the terminal agree.
    findings: rankFindings(syn.findings).filter((f) => !linkedIds.has(f.id)).slice(0, 8),
    headline: pulse.headline,
    delta: briefDelta(records, now),
    threads: pulse.threads.map((th) => threadCard(th, ctx)),
    triage: triage.length ? triage : undefined,
    // full-case ad-hoc rows, matching the markdown's standing coverage table
    // (records here is the UNSCOPED case set — see the brief run callsite)
    coverage: coverageTableRows(pulse.coverage, unattributedScanHits(records, pulse.coverage)),
  };
}

// Brief is an export artifact: embed each record's primary field IN FULL (not a
// 160-char stub — the bug that made `brief --export` a useless record list).
// PRIMARY_TEXT_FIELDS is the shared precedence list (record.ts) — `summary`
// first, so match records embed their result line, not a key dump.

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
  for (const k of PRIMARY_TEXT_FIELDS) {
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
    { name: "full", summary: "Include the full verbatim record timeline (audit dump) instead of the compact appendix", type: "boolean" },
    { name: "export", summary: "Write a report file (.md or .html)", type: "string" },
    { name: "theme", summary: "HTML export theme: plain | csi", type: "string", choices: ["plain", "csi"], default: "plain" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "brief",
  providerKey: "brief",
  run: async (ctx) => {
    const allRecords = ctx.case.records();
    let records = allRecords;
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
          const t = recordTimeMs(r);
          return Number.isNaN(t) || t >= cutoff;
        });
      }
    }
    const info = ctx.case.exists() ? ctx.case.info() : { name: "case" };
    // pulse reflects the STANDING investigation state (threads, coverage,
    // freshness) over the full case — computing it on scoped records would make
    // configured sources look never-scanned and lines read cold under
    // `--scope since:24h`. Only the brief body (synthesis + trail) is scoped.
    const pulse = casePulse({ records: allRecords, targets: listTargets(ctx.case), sources: listSources(ctx.case) });
    const brief = buildBrief(records, info.name, { pulse, full: ctx.opts.full === true, caseRecords: allRecords });
    const theme = normalizeHtmlTheme(ctx.opts.theme);
    if (!theme) return [readError("brief", `invalid --theme '${ctx.opts.theme}' (expected plain or csi)`)];
    // Pending only when the WHOLE case is empty — not merely when a --scope
    // window is. A scoped run over an active case still has a useful body
    // (threads/coverage/triage from the full-case pulse), so it renders + exports.
    if (memoryRecords(allRecords).length === 0) {
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
      const isHtml = isHtmlExportPath(path);
      let html: string;
      if (theme === "csi") {
        // short mode caps the timeline cards to the newest slice (the story lives
        // in the synthesis header); --full renders every evidence record.
        const timelineRecords = ctx.opts.full === true ? brief.records : brief.records.slice(-24);
        const timeline = timelineRecords.map(recordToTimelineRecord);
        // extract tiny poster frames for local video previews so the player can
        // stay preload="none" — a report full of large clips must not stall the
        // page loading video metadata (see attachVideoPosters).
        if (isHtml) await attachVideoPosters(timeline, ctx.case.mediaDir);
        html = renderCsiTimelineReport({
          title: `Brief — ${info.name}`,
          subtitle: ctx.case.dir,
          kind: "brief",
          records: timeline,
          counts: brief.counts,
          total: brief.total,
          synthesis: enrichSynthesis(brief.synthesis, pulse, allRecords),
        });
      } else {
        html = mdToPlainHtml(brief.md, `Brief — ${info.name}`);
      }
      writeFileSync(path, isHtml ? html : brief.md, "utf8");
      exported = path;
    }

    return [
      makeRecord({
        verb: "brief",
        format: "md",
        payload: { report: brief.md, counts: brief.counts, total: brief.total, synthesis: brief.synthesis, export: exported ?? null },
        meta: { case: ctx.case.dir },
        state: "ready",
      }),
    ];
  },
};
