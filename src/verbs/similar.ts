// `similar` verb: cross-modal semantic search over a local `basic-clip` CLIP DB.
// `similar add <image|video>` embeds + caches a member (videos are sampled and
// pooled); `similar match <image|video>` queries image→image; `similar search
// "<text>"` queries text→image. Deliberately local-only (OpenAI CLIP via
// open_clip); remote searchable video indexes stay under `index`/`ask`/`face`.

import { existsSync, mkdirSync } from "node:fs";
import { makeRecord, isReady, type OvercastRecord } from "../record.js";
import { addMember, findIndex, resolveIndexRef } from "../state/index.js";
import {
  localIndexDir,
  runLocalClip,
  readClipConfig,
  type ClipConfig,
} from "../providers/local/vision.js";
import { resolveVisualArg } from "./media-ref.js";
import { badNumber } from "./validate.js";
import { providerBinding } from "../providers/bindings.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerEnv } from "../providers/provider-env.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import type { Case } from "../case.js";
import type { VerbContext, VerbSpec } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "similar", format: "json", payload: { error: message }, error: message, state: "error" });
}

/** Resolve + validate a local basic-clip index the query/add targets. */
function localClipIndex(ctxCase: Case, value: unknown): { id?: string; error?: string } {
  const raw = value != null ? String(value).trim() : "";
  if (!raw) return { error: "--index requires a local basic-clip index id/name" };
  const r = resolveIndexRef(ctxCase, raw);
  if (r.error) return { error: r.error };
  const entry = r.entry ?? findIndex(ctxCase, raw);
  if (!entry) return { error: `unknown local basic-clip index: ${raw}` };
  if (entry.type !== "basic-clip") return { error: `index ${entry.id} is type '${entry.type}', not basic-clip` };
  if (entry.backend !== "local") return { error: `index ${entry.id} is not local; create one with \`index create <name> --type basic-clip --local\`` };
  return { id: entry.id };
}

/** Effective config for a query/add: index config.json overridden by CLI flags. */
function effectiveConfig(indexDir: string, opts: VerbContext["opts"]): ClipConfig {
  const cfg = readClipConfig(indexDir);
  const pooling = opts.pooling === "mean" || opts.pooling === "max" ? opts.pooling : cfg.pooling;
  const granularity = opts.granularity === "frame" || opts.granularity === "video" ? opts.granularity : cfg.granularity;
  const sampling = opts.sampling === "shots" || opts.sampling === "uniform" ? opts.sampling : cfg.sampling;
  return {
    pooling,
    granularity,
    sampling,
    window: opts.window != null ? Number(opts.window) : cfg.window,
    maxFrames: opts["max-frames"] != null ? Number(opts["max-frames"]) : cfg.maxFrames,
    fps: opts.fps != null ? Number(opts.fps) : cfg.fps,
  };
}

/** Segment-start seconds from a watch record's `payload.detailed.segments[]`. */
function segmentStarts(rec: OvercastRecord | undefined): number[] {
  const detailed = (rec?.payload as Record<string, unknown> | undefined)?.detailed as Record<string, unknown> | undefined;
  const segs = detailed?.segments;
  if (!Array.isArray(segs)) return [];
  const out: number[] = [];
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    const seg = s as Record<string, unknown>;
    const raw = seg.start_seconds ?? seg.start ?? seg.start_time;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n >= 0) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Shot markers for a video: reuse an existing `watch` record's segments; else
 *  invoke the bound watch provider once and hand the fresh record back so the
 *  caller RETURNS it (records are persisted by the verb runner — same contract as
 *  index add's ensureLocalWatchRecord). Any non-error watch evidence (ready OR
 *  pending) suppresses a new invocation: a pending watch is already paid for, and
 *  re-running it here would double-bill. Empty markers = uniform fallback. */
async function shotMarkers(ctx: VerbContext, ref: string): Promise<{ markers: number[]; watched?: OvercastRecord }> {
  const evidence = ctx.case.records().filter((r) => {
    if (r.verb !== "watch" || r.media?.ref !== ref) return false;
    const state = String(r.state ?? "ready");
    return state !== "error" && state !== "needs_credentials";
  });
  if (evidence.length) {
    return { markers: segmentStarts(evidence.find(isReady)) };
  }
  // No watch evidence yet — call the bound watch provider (as watchVerb does) to
  // obtain shot boundaries. Reuse-first avoids re-paying for an already-watched clip.
  const binding = providerBinding(ctx, "watch");
  const rec = isCustomBinding(binding)
    ? await runBoundProvider("watch", binding!, ref, { env: providerEnv(ctx.case.mediaDir), timeoutMs: 15 * 60_000, signal: ctx.signal })
    : await runWatch(ref, { run: binding?.run, signal: ctx.signal });
  rec.meta = { ...rec.meta, case: ctx.case.dir, triggered_by: "similar" };
  return { markers: isReady(rec) ? segmentStarts(rec) : [], watched: rec };
}

export const similarVerb: VerbSpec = {
  name: "similar",
  group: "sense",
  summary: "Find images/video moments by visual or text similarity in a local CLIP (basic-clip) index.",
  description:
    "`similar add <image|video> --index <basic-clip-index>` embeds and caches a reference in a local CLIP DB " +
    "(videos are frame-sampled and pooled). " +
    "`similar match <image|video> --index <id>` ranks members by image→image similarity; " +
    "`similar search \"<text>\" --index <id>` ranks members by text→image similarity. " +
    "Runs OpenAI CLIP locally (open_clip); scores are cosine×100 (0–100).",
  args: [
    { name: "action", summary: "add | match | search", required: true },
    { name: "input", summary: "image/video path, URL, record id (add/match) — or a text query (search)", required: false, variadic: true },
  ],
  flags: [
    { name: "index", summary: "local basic-clip index id/name", type: "string" },
    { name: "to", summary: "alias for --index when adding", type: "string" },
    { name: "min-similarity", summary: "match/search: similarity floor (0–100)", type: "number" },
    { name: "limit", summary: "match/search: max results", type: "number" },
    { name: "offset", summary: "match/search: result offset", type: "number" },
    { name: "pooling", summary: "video: pool frame embeddings by max | mean (default index config)", type: "string", choices: ["max", "mean"] },
    { name: "granularity", summary: "video: video (one vector/video) | frame (one vector/frame → moments)", type: "string", choices: ["video", "frame"] },
    { name: "sampling", summary: "video: uniform windows | shots (tinycloud watch boundaries)", type: "string", choices: ["uniform", "shots"] },
    { name: "window", summary: "video: seconds per uniform sampling window", type: "number" },
    { name: "fps", summary: "video: frame sampling rate; --max-frames can cap it", type: "number" },
    { name: "max-frames", summary: "video: frame sample count/cap", type: "number" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "similar.match",
  providerKey: "similar",
  run: async (ctx) => {
    const action = ctx.input;
    if (action !== "add" && action !== "match" && action !== "search") {
      return [err("usage: similar <add|match|search> <image|video|text> --index <local-basic-clip-index>")];
    }
    const indexValue = ctx.opts.index ?? ctx.opts.to;
    const idx = localClipIndex(ctx.case, indexValue);
    if (idx.error) return [err(`similar ${action}: ${idx.error}`)];

    const numErr =
      badNumber(ctx.opts, "min-similarity", (n) => n >= 0 && n <= 100, "0–100") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number") ??
      badNumber(ctx.opts, "window", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "fps", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "max-frames", (n) => n > 0, "a positive number");
    if (numErr) return [err(`similar ${action}: ${numErr}`)];

    const indexDir = localIndexDir(ctx.case, idx.id!);
    const cfg = effectiveConfig(indexDir, ctx.opts);

    // ONE shared opts block for all three actions. Every op must carry the FULL
    // effective sampling config: the Python side keys its embedding cache on it
    // (config_hash), so an op that omitted sampling/window/fps would miss the
    // cache and silently re-embed members with defaults.
    const baseOpts = {
      indexId: idx.id!,
      pooling: cfg.pooling,
      granularity: cfg.granularity,
      sampling: cfg.sampling,
      window: cfg.window,
      maxFrames: cfg.maxFrames ?? undefined,
      fps: cfg.fps ?? undefined,
      signal: ctx.signal,
    };
    const queryOpts = {
      minSimilarity: ctx.opts["min-similarity"] != null ? Number(ctx.opts["min-similarity"]) : undefined,
      limit: ctx.opts.limit != null ? Number(ctx.opts.limit) : undefined,
      offset: ctx.opts.offset != null ? Number(ctx.opts.offset) : undefined,
    };

    // ---- search (text → image) ----
    if (action === "search") {
      const text = ctx.rest.join(" ").trim();
      if (!text) return [err("similar search requires a text query")];
      const rec = await runLocalClip(ctx.case, text, { ...baseOpts, ...queryOpts, op: "search" });
      return [rec];
    }

    // ---- add / match (both take a visual arg) ----
    const arg = ctx.rest[0];
    if (!arg) return [err(`similar ${action} requires an image/video input`)];
    const q = resolveVisualArg(ctx.case, arg, `similar ${action}`);
    if (q.error) return [err(q.error)];
    if (!/^https?:\/\//i.test(q.ref!) && !existsSync(q.ref!)) return [err(`similar ${action}: input not found: ${q.ref}`)];

    // shot markers only apply to video sampling; resolve them in TS so the local
    // clip provider stays pure-CLIP (no tinycloud coupling). A freshly-run watch
    // record is returned alongside the similar record so it persists as case
    // evidence (otherwise every later shots-sampled run would re-pay the watch).
    let framesAt: number[] | undefined;
    let watched: OvercastRecord | undefined;
    if (q.kind === "video" && cfg.sampling === "shots") {
      const shots = await shotMarkers(ctx, q.ref!);
      if (shots.markers.length) framesAt = shots.markers;
      watched = shots.watched;
    }

    if (action === "add") {
      mkdirSync(indexDir, { recursive: true });
      const rec = await runLocalClip(ctx.case, q.ref!, { ...baseOpts, op: "add", framesAt });
      // register the member only after the embed SUCCEEDED (mirrors index add's
      // accepted() gate) — a failed embed must not leave a vectorless member that
      // match/search would silently skip.
      if (isReady(rec)) {
        const entry = findIndex(ctx.case, idx.id!);
        if (!entry?.members.some((m) => m.ref === q.ref)) {
          addMember(ctx.case, idx.id!, { ref: q.ref!, recordId: q.recordId });
        }
      }
      return watched ? [rec, watched] : [rec];
    }

    const rec = await runLocalClip(ctx.case, q.ref!, { ...baseOpts, ...queryOpts, op: "match", framesAt });
    return watched ? [rec, watched] : [rec];
  },
};
