// `face` verb (sense): detect faces in a video, match a known face image
// against a video, or search/list faces across a face-analysis index.
// Backed by tinycloud (invariant #9, public verbs only); a custom provider can
// be bound via `setup provider face <spec>` like any sense. One verb resolves
// to one of four tinycloud face ops from the inputs given:
//   face <video>                      → detect   (who is in this video)
//   face <video> --match ref.jpg      → match    (find this person in the video)
//   face --match ref.jpg --index      → search   (find this person across the index)
//   face <video> --index <id>         → list     (stored detections for that video)

import { existsSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../record.js";
import { runFace, type FaceOp, type FaceParams } from "../providers/tinycloud/face.js";
import { tinycloudBaseFromRun, TC_SUBCOMMANDS, TINYCLOUD_TIMEOUT_MS } from "../providers/tinycloud/envelope.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { indexesByType, resolveIndexRef } from "../state/index.js";
import { findIndex } from "../state/index.js";
import { runLocalFace, type LocalFaceOp } from "../providers/local/vision.js";
import { resolveVideoArg } from "./media-ref.js";
import { badNumber } from "./validate.js";
import type { Case } from "../case.js";
import type { ProviderDescriptor } from "../profile.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "face", format: "json", payload: { error: message }, error: message, state: "error" });
}

const FACE_QUERY_IMAGE_RE = /\.(jpe?g|png)$/i;

function faceQueryImageError(ref: string): string | undefined {
  const clean = ref.replace(/[?#].*$/, "");
  return FACE_QUERY_IMAGE_RE.test(clean)
    ? undefined
    : `--match image must be a JPEG or PNG: ${ref} (tinycloud 0.3.6 rejects webp/heic/gif/bmp/tiff/avif at preflight)`;
}

/** Resolve a --match face-IMAGE ref. A path/URL is used as-is; a case record id
 *  resolves to its media ONLY when that media looks like an image — a watch/
 *  listen (or non-search face) record's ref is the analyzed video/audio, not a
 *  face photo, so reject it with a clear local error instead of matching against
 *  the wrong media. */
function resolveImageRef(c: Case, ref: string): { ref?: string; error?: string } {
  const rec = c.recordById(ref);
  if (!rec) return { ref }; // a direct path / URL — trust the user's choice
  const m = rec.media?.ref;
  if (!m) return { error: `--match record ${ref} has no media` };
  // tinycloud 0.3.6 accepts only JPEG/PNG query images for match/search. Check a
  // record-resolved ref here so a watch/capture/scan record pointing at a video,
  // page URL, or unsupported image format is rejected before spawning tinycloud.
  const imageErr = faceQueryImageError(m);
  if (imageErr) {
    return { error: `--match record ${ref} resolves to ${m}; ${imageErr}` };
  }
  return { ref: m };
}

/** Resolve a --index value (id or name, comma-list ok) to tinycloud-backed index
 *  id(s) for a face op. Surfaces an ambiguous-name error (like ask/index)
 *  instead of passing a raw name, and rejects a mirrored index whose type isn't face-analysis.
 *  Unmirrored values pass through as
 *  raw ids; a value that resolves to nothing yields an empty list. */
function resolveFaceIndexes(c: Case, value: string): { ids: string[]; error?: string } {
  const ids: string[] = [];
  for (const v of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const ref = resolveIndexRef(c, v);
    if (ref.error) return { ids: [], error: ref.error };
    const entry = ref.entry;
    if (entry && entry.type !== "face-analysis" && entry.type !== "deepface-local" && entry.type !== "unknown") {
      return { ids: [], error: `index ${entry.id} is type '${entry.type}', not face-analysis/deepface-local — face --match/list only read face indexes` };
    }
    ids.push(entry?.id ?? v);
  }
  return { ids };
}

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Is this `face` binding a tinycloud invocation (possibly a PINNED binary/path,
 *  e.g. `/opt/tc/tinycloud face detect {{input}}`) rather than a standalone custom
 *  provider? Such a binding must be driven via runFace with the derived base so
 *  ALL four ops work — the custom branch would hardcode whatever subcommand the
 *  template names. Detected by a tinycloud subcommand following the command prefix. */
function isTinycloudFaceBinding(b?: ProviderDescriptor): boolean {
  const run = b?.run;
  if (!run) return false;
  const base = tinycloudBaseFromRun(run);
  if (!base) return false;
  const after = run.trim().split(/\s+/).slice(base.split(/\s+/).length);
  return after.length > 0 && TC_SUBCOMMANDS.includes(after[0]);
}

function isDeepfaceFaceBinding(b?: ProviderDescriptor): boolean {
  return b?.backend === "deepface-local" || b?.id === "deepface-local";
}

export const faceVerb: VerbSpec = {
  name: "face",
  group: "sense",
  summary: "Detect, match, or search faces in video (and across face-analysis indexes).",
  description:
    "Default provider: tinycloud. `face <video>` detects faces — one box per sampled frame, so the " +
    "count is detections, NOT unique people (detect doesn't cluster). To find or count a PERSON, use " +
    "`face <video> --match ref.jpg` (locates that person in the clip, ranked by similarity), or " +
    "`face --match ref.jpg --index <id>` to search a registered face-analysis index (case-wide); " +
    "`face <video> --index <id>` lists that video's stored detections. The video/reference may be a " +
    "path, URL, or a case record id; the reference image for --match must be JPEG/PNG. Emits a face.analysis record whose `summary` is the headline, plus " +
    "faces[] (at, box, similarity, thumbnail?) and the full provider data in `detailed`.",
  args: [
    { name: "input", summary: "Video to analyze (path/URL/record-id); omit with --match + --index to search the index", required: false },
  ],
  flags: [
    { name: "match", summary: "Reference face image to find (JPEG/PNG path/URL/record-id)", type: "string" },
    { name: "index", summary: "Face-analysis index id/name to search or list within (comma-list ok; default: the case's face index)", type: "string" },
    { name: "max-faces", summary: "match: cap returned matches (1–4000)", type: "number" },
    { name: "min-similarity", summary: "match/search: similarity floor (0–100)", type: "number" },
    { name: "thumbnails", summary: "detect/match: include per-face thumbnail URLs", type: "boolean" },
    { name: "fps", summary: "detect/match: sampling frames per second; local face accepts --max-frames as a cap", type: "number" },
    { name: "max-frames", summary: "local face: video frame sample count/cap", type: "number" },
    { name: "start", summary: "detect/match: window start (SS or timecode)", type: "string" },
    { name: "end", summary: "detect/match: window end (SS or timecode)", type: "string" },
    { name: "limit", summary: "detect/list/search: max results (match uses --max-faces)", type: "number" },
    { name: "offset", summary: "list/search: result offset", type: "number" },
    { name: "group-by", summary: "search: group results by file", type: "string" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "face.analysis",
  providerKey: "face",
  run: async (ctx) => {
    const c = ctx.case;
    const binding = providerBinding(ctx, "face");
    const useDeepface = isDeepfaceFaceBinding(binding);
    // --match is a face image: a path/URL is used as-is; a record id resolves only
    // when its media is an image (not an analyzed video/audio).
    let image: string | undefined;
    if (ctx.opts.match != null) {
      // `!= null` + blank reject so a provided-but-empty `--match=` is a user
      // error, not silently treated as omitted (→ detect instead of match/search).
      const raw = String(ctx.opts.match);
      if (!raw.trim()) return [err("--match requires a face image (path/URL/record-id)")];
      const r = resolveImageRef(c, raw);
      if (r.error) return [err(r.error)];
      image = r.ref;
    }
    // the video input goes through the SAME media validation as index
    // add/entities (reject a scan record's page URL, a non-AV ref, a face-search
    // query image, a missing local file). requireReady:false — a video file is
    // analyzable regardless of whether a prior sense finished.
    let video: string | undefined;
    if (ctx.input) {
      const v = resolveVideoArg(c, ctx.input, "face video", { requireReady: false });
      if (v.error) return [err(v.error)];
      video = v.ref;
    }
    // `!= null` (not truthy) so a provided-but-empty `--index=` is caught as a
    // user error below rather than treated as omitted (→ silent detect/auto-pick).
    const indexFlag = ctx.opts.index != null ? String(ctx.opts.index) : undefined;
    if (indexFlag !== undefined && !indexFlag.trim()) {
      return [err("--index requires an index id or name")];
    }
    // a provided-but-blank `--start=`/`--end=` is a user error (it would otherwise
    // be treated as omitted and run the full clip), matching the blank-flag hygiene
    // used for --match/--index/--min-similarity.
    for (const f of ["start", "end"] as const) {
      if (ctx.opts[f] != null && !String(ctx.opts[f]).trim()) {
        return [err(`--${f} requires a timestamp (seconds or hh:mm:ss)`)];
      }
    }

    // validate the numeric flags up front (covers both the custom + default
    // paths) — reject 0/negative/out-of-range/non-finite like ask/entities,
    // rather than forwarding a junk value to the provider.
    const numErr =
      badNumber(ctx.opts, "max-faces", (n) => n >= 1 && n <= 4000, "1–4000") ??
      badNumber(ctx.opts, "min-similarity", (n) => n >= 0 && n <= 100, "0–100") ??
      badNumber(ctx.opts, "fps", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "max-frames", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number");
    if (numErr) return [err(numErr)];

    // the --match image (a direct path) must exist too (resolveImageRef only
    // type-checks a record-resolved ref; a direct path is trusted until here).
    if (image && !/^https?:\/\//i.test(image) && !existsSync(image)) {
      return [err(`--match image not found: ${image}`)];
    }
    if (image) {
      const imageErr = faceQueryImageError(image);
      if (imageErr) return [err(imageErr)];
    }

    // Resolve which face op the given inputs select. This runs BEFORE the custom
    // branch so a bound provider gets the same op + resolved indexes (with the
    // same ambiguity/type-guard/auto-pick) as the default tinycloud path.
    let op: FaceOp;
    let indexes: string[] | undefined;
    if (image && video) {
      // match is video-scoped (find this face IN this clip); --index is for
      // search/list in tinycloud. A local face index may be provided to choose the
      // local matcher backend while still matching inside this one clip.
      if (indexFlag) {
        const r = resolveFaceIndexes(c, indexFlag);
        if (r.error) return [err(r.error)];
        if (!r.ids.length) return [err(`--index '${indexFlag}' has no valid index id`)];
        const entries = r.ids.map((id) => findIndex(c, id)).filter(Boolean);
        const allLocal = entries.length === r.ids.length && entries.every((e) => e!.backend === "local" || e!.type === "deepface-local");
        if (!allLocal) {
          return [err(`--index can't combine with a video for ${useDeepface ? "deepface-local" : "tinycloud"} --match unless it is a deepface-local index: drop the video to search the index, or drop --index to match within the video`)];
        }
        if (r.ids.length !== 1) return [err("local face match accepts exactly one --index")];
        indexes = r.ids;
      }
      op = "match";
    } else if (image && !video) {
      // search the face across a face-analysis index (case-wide).
      if (indexFlag) {
        const r = resolveFaceIndexes(c, indexFlag);
        if (r.error) return [err(r.error)];
        // a flag that resolves to nothing (whitespace/comma-only) must not run an
        // unscoped search — surface it as the user error it is.
        if (!r.ids.length) return [err(`--index '${indexFlag}' has no valid index id`)];
        indexes = r.ids;
      } else {
        // auto-pick the case's sole FACE-ANALYSIS index. An untyped stub
        // (`index add` by raw id without --type) stays "unknown" and is NOT
        // assumed to be a face index — classify it with `--type face` or pass
        // --index explicitly.
        const cands = indexesByType(c, useDeepface ? "deepface-local" : "face-analysis");
        if (cands.length === 1) indexes = [cands[0].id];
        else if (cands.length === 0) {
          return [err(useDeepface
            ? "face --match with the deepface-local provider needs a video to match, or a deepface-local index — create one with `overcast index create <name> --type deepface-local --local`, then retry"
            : "face --match needs a video to search, or a face-analysis index — create one with `overcast index create <name> --type face` (or classify an added one with `index add … --type face`), then retry")];
        } else {
          return [err(`face --match matched ${cands.length} ${useDeepface ? "deepface-local" : "face"} indexes; pass --index <id> (one of: ${cands.map((x) => x.id).join(", ")})`)];
        }
      }
      op = "search";
    } else if (video && indexFlag) {
      // list the video's stored detections within the index.
      const r = resolveFaceIndexes(c, indexFlag);
      if (r.error) return [err(r.error)];
      if (!r.ids.length) return [err(`--index '${indexFlag}' has no valid index id`)];
      indexes = r.ids;
      op = "list";
    } else if (video) {
      op = "detect";
    } else {
      return [err("face requires a video (to detect/match), or --match <image> with --index (to search). See `overcast face --help`.")];
    }

    // op-specific flags: faceArgv only forwards each flag to the ops it applies to,
    // so a flag set for the WRONG op would be silently dropped (the user thinks
    // they filtered but didn't). Reject the mismatch, like the --index guards.
    const FLAG_OPS: Record<string, FaceOp[]> = {
      "max-faces": ["match"],
      "min-similarity": ["match", "search"],
      fps: ["detect", "match"],
      start: ["detect", "match"],
      end: ["detect", "match"],
      thumbnails: ["detect", "match"],
      limit: ["detect", "list", "search"],
      offset: ["list", "search"],
      "group-by": ["search"],
    };
    for (const [flag, ops] of Object.entries(FLAG_OPS)) {
      const provided = flag === "thumbnails" ? ctx.opts[flag] === true : ctx.opts[flag] != null;
      if (provided && !ops.includes(op)) {
        return [err(`--${flag} doesn't apply to face ${op} (only: ${ops.join(", ")})`)];
      }
    }

    const localEntries = (indexes ?? []).map((id) => findIndex(c, id)).filter((x): x is NonNullable<ReturnType<typeof findIndex>> => !!x && (x.backend === "local" || x.type === "deepface-local"));
    if (localEntries.length || useDeepface) {
      if (localEntries.length && (!indexes || localEntries.length !== indexes.length)) {
        return [err("can't mix local face indexes with tinycloud/raw face indexes in one face command")];
      }
      if (localEntries.length > 1) return [err("local face search/list accepts exactly one --index")];
      if (useDeepface && op !== "detect" && op !== "match" && localEntries.length !== 1) {
        return [err("deepface-local face search/list requires exactly one deepface-local --index")];
      }
      if (localEntries.length === 0 && op !== "detect" && op !== "match") {
        return [err("local face search/list requires exactly one deepface-local --index")];
      }
      const localOp: LocalFaceOp = op === "search" ? "search" : op === "match" ? "match" : "detect";
      const primary = localOp === "search" ? image! : video!;
      const rec = await runLocalFace(c, primary, {
        op: localOp,
        indexId: localEntries[0]?.id ?? "deepface-local",
        image,
        minSimilarity: num(ctx.opts["min-similarity"]),
        limit: num(ctx.opts.limit) ?? num(ctx.opts["max-faces"]),
        maxFrames: num(ctx.opts["max-frames"]),
        fps: num(ctx.opts.fps),
        thumbnails: ctx.opts.thumbnails === true,
        signal: ctx.signal,
      });
      return [rec];
    }
    if (ctx.opts["max-frames"] != null) {
      return [err("--max-frames only applies to local face indexes")];
    }

    // A custom face provider takes over (pass-through) with the SAME resolved op +
    // indexes, so a bound provider behaves like the default tinycloud path. A
    // tinycloud-style binding (incl. a pinned binary/path) is NOT custom — it runs
    // through runFace below so all four ops work, not just the template's subcommand.
    if (isCustomBinding(binding) && !isTinycloudFaceBinding(binding)) {
      const primary = op === "search" ? image! : video!;
      const extraArgs: string[] = ["--op", op];
      if (image && (op === "match" || op === "search")) extraArgs.push("--match", image);
      if (indexes?.length) extraArgs.push("--index", indexes.join(","));
      for (const f of ["max-faces", "min-similarity", "fps", "start", "end", "limit", "offset", "group-by"]) {
        if (ctx.opts[f] != null) extraArgs.push(`--${f}`, String(ctx.opts[f]));
      }
      if (ctx.opts.thumbnails === true) extraArgs.push("--thumbnails");
      const rec = await runBoundProvider("face", binding!, primary, {
        env: providerEnv(c.mediaDir),
        extraArgs,
        timeoutMs: TINYCLOUD_TIMEOUT_MS,
        signal: ctx.signal,
      });
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    const params: FaceParams = {
      op,
      source: video,
      image,
      collections: indexes,
      maxFaces: num(ctx.opts["max-faces"]),
      minSimilarity: num(ctx.opts["min-similarity"]),
      fps: num(ctx.opts.fps),
      start: ctx.opts.start ? String(ctx.opts.start) : undefined,
      end: ctx.opts.end ? String(ctx.opts.end) : undefined,
      thumbnails: ctx.opts.thumbnails === true,
      limit: num(ctx.opts.limit),
      offset: num(ctx.opts.offset),
      groupByFile: ctx.opts["group-by"] === "file" || ctx.opts["group-by"] === true,
    };

    const rec = await runFace(params, {
      // honor a bound tinycloud command/wrapper (consistent with watch/listen);
      // falls back to OVERCAST_TINYCLOUD_CMD / `tinycloud` when unbound.
      base: tinycloudBaseFromRun(binding?.run),
      env: providerEnv(c.mediaDir),
      // long media: match watch/listen's 15-min headroom (and the custom-face
      // branch above), not runTinycloud's 10-min default.
      timeoutMs: TINYCLOUD_TIMEOUT_MS,
      signal: ctx.signal,
    });
    rec.meta = { ...rec.meta, case: c.dir };
    return [rec];
  },
};
