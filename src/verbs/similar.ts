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
 *  invoke the bound watch provider once. Returns [] when none are available (the
 *  caller falls back to uniform sampling). */
async function shotMarkers(ctx: VerbContext, ref: string): Promise<number[]> {
  const existing = ctx.case
    .records()
    .find((r) => r.verb === "watch" && r.media?.ref === ref && isReady(r));
  const reused = segmentStarts(existing);
  if (reused.length) return reused;
  // No watch evidence yet — call the bound watch provider (as watchVerb does) to
  // obtain shot boundaries. Reuse-first avoids re-paying for an already-watched clip.
  const binding = providerBinding(ctx, "watch");
  const rec = isCustomBinding(binding)
    ? await runBoundProvider("watch", binding!, ref, { env: providerEnv(ctx.case.mediaDir), timeoutMs: 15 * 60_000, signal: ctx.signal })
    : await runWatch(ref, { run: binding?.run, signal: ctx.signal });
  return isReady(rec) ? segmentStarts(rec) : [];
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

    // ---- search (text → image) ----
    if (action === "search") {
      const text = ctx.rest.join(" ").trim();
      if (!text) return [err("similar search requires a text query")];
      const rec = await runLocalClip(ctx.case, text, {
        indexId: idx.id!,
        op: "search",
        minSimilarity: ctx.opts["min-similarity"] != null ? Number(ctx.opts["min-similarity"]) : undefined,
        limit: ctx.opts.limit != null ? Number(ctx.opts.limit) : undefined,
        offset: ctx.opts.offset != null ? Number(ctx.opts.offset) : undefined,
        pooling: cfg.pooling,
        granularity: cfg.granularity,
        signal: ctx.signal,
      });
      return [rec];
    }

    // ---- add / match (both take a visual arg) ----
    const arg = ctx.rest[0];
    if (!arg) return [err(`similar ${action} requires an image/video input`)];
    const q = resolveVisualArg(ctx.case, arg, `similar ${action}`);
    if (q.error) return [err(q.error)];
    if (!/^https?:\/\//i.test(q.ref!) && !existsSync(q.ref!)) return [err(`similar ${action}: input not found: ${q.ref}`)];

    // shot markers only apply to video sampling; resolve them in TS so the local
    // clip provider stays pure-CLIP (no tinycloud coupling).
    let framesAt: number[] | undefined;
    if (q.kind === "video" && cfg.sampling === "shots") {
      const markers = await shotMarkers(ctx, q.ref!);
      if (markers.length) framesAt = markers;
    }

    if (action === "add") {
      const entry = findIndex(ctx.case, idx.id!);
      const already = entry?.members.some((m) => m.ref === q.ref);
      mkdirSync(indexDir, { recursive: true });
      if (!already) addMember(ctx.case, idx.id!, { ref: q.ref!, recordId: q.recordId });
      const rec = await runLocalClip(ctx.case, q.ref!, {
        indexId: idx.id!,
        op: "add",
        pooling: cfg.pooling,
        granularity: cfg.granularity,
        sampling: cfg.sampling,
        window: cfg.window,
        maxFrames: cfg.maxFrames ?? undefined,
        fps: cfg.fps ?? undefined,
        framesAt,
        signal: ctx.signal,
      });
      return [rec];
    }

    const rec = await runLocalClip(ctx.case, q.ref!, {
      indexId: idx.id!,
      op: "match",
      minSimilarity: ctx.opts["min-similarity"] != null ? Number(ctx.opts["min-similarity"]) : undefined,
      limit: ctx.opts.limit != null ? Number(ctx.opts.limit) : undefined,
      offset: ctx.opts.offset != null ? Number(ctx.opts.offset) : undefined,
      pooling: cfg.pooling,
      granularity: cfg.granularity,
      sampling: cfg.sampling,
      window: cfg.window,
      maxFrames: cfg.maxFrames ?? undefined,
      fps: cfg.fps ?? undefined,
      framesAt,
      signal: ctx.signal,
    });
    return [rec];
  },
};
