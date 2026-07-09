// `similar` verb: cross-modal semantic search over a local `basic-clip` CLIP DB.
// `similar add <image|video>` embeds + caches a member (videos are sampled and
// pooled); `similar match <image|video>` queries image→image; `similar search
// "<text>"` queries text→image. Deliberately local-only (OpenAI CLIP via
// open_clip); remote searchable video indexes stay under `index`/`ask`/`face`.

import { existsSync, mkdirSync } from "node:fs";
import { makeRecord, errRecord, isReady, type OvercastRecord } from "../record.js";
import { addMember, findIndex, resolveIndexRef } from "../state/index.js";
import {
  localIndexDir,
  runLocalClip,
  readClipConfig,
  type ClipConfig,
} from "../providers/local/vision.js";
import { runLocalClap, readClapConfig } from "../providers/local/audio.js";
import { resolveVideoArg, resolveVisualArg } from "./media-ref.js";
import { openBucket, provenanceCase, resolveIndexScope, stampArchive } from "../archive.js";
import { provenanceFromCapture, stampProvenance } from "./provenance.js";
import { badNumber } from "./validate.js";
import { providerBinding } from "../providers/bindings.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerEnv } from "../providers/provider-env.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import type { Case } from "../case.js";
import type { VerbContext, VerbSpec } from "../registry/types.js";

const err = (message: string): OvercastRecord => errRecord("similar", message);

/** Resolve + validate a local semantic index (basic-clip = CLIP images/video, or
 *  basic-clap = CLAP audio) the query/add targets. Returns the resolved type so
 *  the caller dispatches to the right provider + config defaults. */
function localClipIndex(ctxCase: Case, value: unknown): { id?: string; type?: "basic-clip" | "basic-clap"; error?: string } {
  const raw = value != null ? String(value).trim() : "";
  if (!raw) return { error: "--index requires a local semantic index (basic-clip|basic-clap) id/name" };
  const r = resolveIndexRef(ctxCase, raw);
  if (r.error) return { error: r.error };
  const entry = r.entry ?? findIndex(ctxCase, raw);
  if (!entry) return { error: `unknown local semantic index: ${raw}` };
  if (entry.type !== "basic-clip" && entry.type !== "basic-clap") return { error: `index ${entry.id} is type '${entry.type}', not basic-clip or basic-clap` };
  if (entry.backend !== "local") return { error: `index ${entry.id} is not local; create one with \`index create <name> --type ${entry.type} --local\`` };
  return { id: entry.id, type: entry.type };
}

/** Read a semantic index's persisted config with type-correct defaults. */
function readCfg(indexDir: string, type: "basic-clip" | "basic-clap"): ClipConfig {
  return type === "basic-clap" ? readClapConfig(indexDir) : readClipConfig(indexDir);
}

/** Effective config for a query/add: index config.json overridden by CLI flags. */
function effectiveConfig(indexDir: string, opts: VerbContext["opts"], type: "basic-clip" | "basic-clap"): ClipConfig {
  const cfg = readCfg(indexDir, type);
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
    // prefer the NEWEST ready record that actually carries segments — a video
    // may have been re-watched with better segmentation, and an early
    // segmentless (e.g. speech-only) record must not mask a later one that has
    // shot boundaries. Records are append-ordered, so scan in reverse.
    for (const r of evidence.filter(isReady).reverse()) {
      const markers = segmentStarts(r);
      if (markers.length) return { markers };
    }
    return { markers: [] };
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
  summary: "Find images/video moments or audio by visual, audio, or text similarity in a local CLIP (basic-clip) or CLAP (basic-clap) index.",
  description:
    "`similar add <image|video> --index <basic-clip-index>` embeds and caches a reference in a local CLIP DB " +
    "(videos are frame-sampled and pooled); a `basic-clap` index instead embeds audio (or a video's audio track) with CLAP. " +
    "`similar match <image|video|audio> --index <id>` ranks members by image→image (CLIP) or audio→audio (CLAP) similarity; " +
    "`similar search \"<text>\" --index <id>` ranks members by text→image (CLIP) or text→audio (CLAP) similarity. " +
    "Runs OpenAI CLIP / LAION CLAP locally; scores are cosine×100 (0–100).",
  args: [
    { name: "action", summary: "add | match | search", required: true, choices: ["add", "match", "search"] },
    { name: "input", summary: "image/video/audio path, URL, record id (add/match) — or a text query (search)", required: false, variadic: true },
  ],
  flags: [
    { name: "index", summary: "local basic-clip (CLIP) or basic-clap (CLAP audio) index id/name", type: "string" },
    { name: "to", summary: "alias for --index when adding", type: "string" },
    { name: "min-similarity", summary: "match/search: similarity floor (0–100)", type: "number" },
    { name: "limit", summary: "match/search: max results", type: "number" },
    { name: "offset", summary: "match/search: result offset", type: "number" },
    { name: "pooling", summary: "match: pool the query's frames/windows by max | mean (members follow the index config)", type: "string", choices: ["max", "mean"] },
    { name: "granularity", summary: "video (one vector per file) | frame (moments — video frames, or 10s audio windows for basic-clap) — set at `index create`; members always follow the index config", type: "string", choices: ["video", "frame"] },
    { name: "sampling", summary: "basic-clip only — match query video: uniform windows | shots (tinycloud watch boundaries); members follow the index config", type: "string", choices: ["uniform", "shots"] },
    { name: "window", summary: "seconds per uniform sampling window (basic-clip video) or audio chunk (basic-clap)", type: "number" },
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
      return [err("usage: similar <add|match|search> <image|video|audio|text> --index <local-basic-clip|basic-clap-index>")];
    }
    if ((action === "add" || action === "match") && ctx.rest.length > 1) {
      return [err(`similar ${action}: expected exactly one input; got ${ctx.rest.length}`)];
    }
    const indexValue = ctx.opts.index ?? ctx.opts.to;
    // `--index archive:<bucket>/<index>` targets a BUCKET's semantic index (see
    // image/audio): DB + members live in the bucket, evidence in the case.
    const scoped = resolveIndexScope(ctx.case, indexValue != null ? String(indexValue) : "", ctx.home);
    if (scoped.error) return [err(`similar ${action}: ${scoped.error}`)];
    const scope = scoped.scope;
    const idx = localClipIndex(scope, indexValue == null ? indexValue : scoped.value);
    if (idx.error) return [err(`similar ${action}: ${idx.error}`)];
    const type = idx.type!;
    const isClap = type === "basic-clap";

    const numErr =
      // cosine×100 legitimately ranges [-100, 100]; a negative floor lets you
      // retrieve low/negative-scoring matches (CLAP text→audio in particular
      // scores near/below zero even for the right clip). Default stays 0.
      badNumber(ctx.opts, "min-similarity", (n) => n >= -100 && n <= 100, "-100–100") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number") ??
      badNumber(ctx.opts, "window", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "fps", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "max-frames", (n) => n > 0, "a positive number");
    if (numErr) return [err(`similar ${action}: ${numErr}`)];

    // frame-sampling flags are CLIP-video only; a CLAP (audio) index chunks by
    // --window seconds and has no shots/fps/max-frames concept, so reject them
    // outright rather than silently ignoring.
    if (isClap) {
      const badFlag = ["fps", "max-frames", "sampling"].find((f) => ctx.opts[f] != null);
      if (badFlag) return [err(`similar ${action}: --${badFlag} doesn't apply to a basic-clap (audio) index — audio is embedded in --window second chunks`)];
    }

    const indexDir = localIndexDir(scope, idx.id!);
    // member embeddings follow the PERSISTED index config — a per-add override
    // would persist a config_hash queries (keyed on config.json) never reuse, so
    // reject the flags outright rather than silently ignoring them.
    if (action === "add") {
      const flag = ["pooling", "granularity", "sampling", "window", "fps", "max-frames"].find((f) => ctx.opts[f] != null);
      if (flag) return [err(`similar add: --${flag} doesn't apply per-add — member embedding follows the index config; set it at \`index create --type ${type}\``)];
    }
    const cfg = action === "add" ? readCfg(indexDir, type) : effectiveConfig(indexDir, ctx.opts, type);

    const queryOpts = {
      minSimilarity: ctx.opts["min-similarity"] != null ? Number(ctx.opts["min-similarity"]) : undefined,
      limit: ctx.opts.limit != null ? Number(ctx.opts.limit) : undefined,
      offset: ctx.opts.offset != null ? Number(ctx.opts.offset) : undefined,
    };

    // ---- search (text → image/audio) ----
    if (action === "search") {
      const text = ctx.rest.join(" ").trim();
      if (!text) return [err("similar search requires a text query")];
      const rec = isClap
        ? await runLocalClap(scope, text, { indexId: idx.id!, op: "search", pooling: cfg.pooling, granularity: cfg.granularity, window: cfg.window, ...queryOpts, signal: ctx.signal })
        : await runLocalClip(scope, text, { indexId: idx.id!, op: "search", pooling: cfg.pooling, granularity: cfg.granularity, sampling: cfg.sampling, window: cfg.window, maxFrames: cfg.maxFrames ?? undefined, fps: cfg.fps ?? undefined, ...queryOpts, signal: ctx.signal });
      return [stampArchive(rec, scoped.bucket, ctx.case.dir)];
    }

    // ---- add / match (both take a media arg: image/video for CLIP, audio/video for CLAP) ----
    const arg = ctx.rest[0];
    if (!arg) return [err(`similar ${action} requires an ${isClap ? "audio/video" : "image/video"} input`)];
    const q = isClap
      ? { ...resolveVideoArg(ctx.case, arg, `similar ${action}`, { home: ctx.home }), kind: "video" as const }
      : resolveVisualArg(ctx.case, arg, `similar ${action}`, { home: ctx.home });
    if (q.error) return [err(q.error)];
    if (!/^https?:\/\//i.test(q.ref!) && !existsSync(q.ref!)) return [err(`similar ${action}: input not found: ${q.ref}`)];

    // ---- CLAP (audio) path: no frame/shot machinery ----
    if (isClap) {
      if (action === "add") {
        mkdirSync(indexDir, { recursive: true });
        const rec = await runLocalClap(scope, q.ref!, { indexId: idx.id!, op: "add", pooling: cfg.pooling, granularity: cfg.granularity, window: cfg.window, signal: ctx.signal });
        if (isReady(rec)) {
          const entry = findIndex(scope, idx.id!);
          if (!entry?.members.some((m) => m.ref === q.ref)) addMember(scope, idx.id!, { ref: q.ref!, recordId: q.recordId });
        }
        return [stampArchive(rec, scoped.bucket, ctx.case.dir)];
      }
      const rec = await runLocalClap(scope, q.ref!, { indexId: idx.id!, op: "match", pooling: cfg.pooling, granularity: cfg.granularity, window: cfg.window, ...queryOpts, signal: ctx.signal });
      stampProvenance(rec, provenanceFromCapture(provenanceCase(ctx.case, q.archive, ctx.home), q.ref));
      return [stampArchive(rec, scoped.bucket, ctx.case.dir)];
    }

    // ---- CLIP (image/video) path ----
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

    // shot markers only apply to video sampling; resolve them in TS so the local
    // clip provider stays pure-CLIP (no tinycloud coupling). A freshly-run watch
    // record is returned alongside the similar record so it persists as case
    // evidence (otherwise every later shots-sampled run would re-pay the watch).
    let framesAt: number[] | undefined;
    let watched: OvercastRecord | undefined;
    if (q.kind === "video" && cfg.sampling === "shots") {
      // an archive-ref query's shot markers come from (and file to) the BUCKET:
      // the watch evidence lives with the media so other cases reuse it, and a
      // bucket-owned record would be dropped by the case persist seam anyway.
      const shotCase = q.archive ? openBucket(q.archive, ctx.home).bucket?.case : undefined;
      if (q.archive && !shotCase) {
        // the bucket vanished mid-command — fall back to uniform sampling
        // rather than paying for (and mis-filing) watch evidence in the case
      } else {
        const shots = await shotMarkers(shotCase ? { ...ctx, case: shotCase } : ctx, q.ref!);
        if (shots.markers.length) framesAt = shots.markers;
        watched = shots.watched;
        if (watched && shotCase) {
          shotCase.writeRecord(watched);
          watched.meta = { ...watched.meta, persisted: true };
        }
      }
    }

    if (action === "add") {
      mkdirSync(indexDir, { recursive: true });
      const rec = await runLocalClip(scope, q.ref!, { ...baseOpts, op: "add", framesAt });
      // register the member only after the embed SUCCEEDED (mirrors index add's
      // accepted() gate) — a failed embed must not leave a vectorless member that
      // match/search would silently skip.
      if (isReady(rec)) {
        const entry = findIndex(scope, idx.id!);
        if (!entry?.members.some((m) => m.ref === q.ref)) {
          addMember(scope, idx.id!, { ref: q.ref!, recordId: q.recordId });
        }
      }
      stampArchive(rec, scoped.bucket, ctx.case.dir);
      return watched ? [rec, watched] : [rec];
    }

    const rec = await runLocalClip(scope, q.ref!, { ...baseOpts, ...queryOpts, op: "match", framesAt });
    stampArchive(rec, scoped.bucket, ctx.case.dir);
    return watched ? [rec, watched] : [rec];
  },
};
