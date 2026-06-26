// `face` verb (sense): detect faces in a video, match a known face image
// against a video, or search/list faces across a face-analysis collection.
// Backed by tinycloud (invariant #9, public verbs only); a custom provider can
// be bound via `setup provider face <spec>` like any sense. One verb resolves
// to one of four tinycloud face ops from the inputs given:
//   face <video>                      → detect   (who is in this video)
//   face <video> --match ref.jpg      → match    (find this person in the video)
//   face --match ref.jpg --collection → search   (find this person across the index)
//   face <video> --collection <id>    → list     (stored detections for that video)

import { existsSync } from "node:fs";
import { makeRecord, type OvercastRecord } from "../record.js";
import { runFace, type FaceOp, type FaceParams } from "../providers/tinycloud/face.js";
import { tinycloudBaseFromRun, TC_SUBCOMMANDS, TINYCLOUD_TIMEOUT_MS } from "../providers/tinycloud/envelope.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerEnv } from "../providers/provider-env.js";
import { collectionsByType, resolveCollectionRef } from "../state/collection.js";
import { resolveVideoArg } from "./media-ref.js";
import { badNumber } from "./validate.js";
import type { Case } from "../case.js";
import type { ProviderDescriptor } from "../profile.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "face", format: "json", payload: { error: message }, error: message, state: "error" });
}

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|avif)$/i;

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
  // require an image extension for a record-resolved ref — local AND http (strip
  // any query/fragment) — so a watch/capture/scan record pointing at a video or
  // page URL is rejected, not accepted as a face image.
  if (!IMG_RE.test(m.replace(/[?#].*$/, ""))) {
    return { error: `--match record ${ref} resolves to ${m}, which isn't a face image — pass a face image (jpg/png) or an image record (e.g. a see/capture of a photo)` };
  }
  return { ref: m };
}

/** Resolve a --collection value (id or name, comma-list ok) to tinycloud
 *  collection id(s) for a face op. Surfaces an ambiguous-name error (like
 *  ask/collection) instead of passing a raw name, and rejects a mirrored
 *  collection whose type isn't face-analysis. Unmirrored values pass through as
 *  raw ids; a value that resolves to nothing yields an empty list. */
function resolveFaceCollections(c: Case, value: string): { ids: string[]; error?: string } {
  const ids: string[] = [];
  for (const v of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const ref = resolveCollectionRef(c, v);
    if (ref.error) return { ids: [], error: ref.error };
    const entry = ref.entry;
    if (entry && entry.type !== "face-analysis" && entry.type !== "unknown") {
      return { ids: [], error: `collection ${entry.id} is type '${entry.type}', not face-analysis — face --match/list only read face-analysis collections` };
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

export const faceVerb: VerbSpec = {
  name: "face",
  group: "sense",
  summary: "Detect, match, or search faces in video (and across face-analysis collections).",
  description:
    "Default provider: tinycloud. `face <video>` detects faces (normalized boxes + timestamps). " +
    "`face <video> --match ref.jpg` finds that person in the video, ranked by similarity. " +
    "`face --match ref.jpg --collection <id>` searches the face across a registered face-analysis " +
    "collection (case-wide); `face <video> --collection <id>` lists that video's stored detections. " +
    "The video/reference may be a path, URL, or a case record id. Emits a face.analysis record with " +
    "faces[] (at, box, similarity, thumbnail?) and the full provider data in `detailed`.",
  args: [
    { name: "input", summary: "Video to analyze (path/URL/record-id); omit with --match + --collection to search the index", required: false },
  ],
  flags: [
    { name: "match", summary: "Reference face image to find (path/URL/record-id)", type: "string" },
    { name: "collection", summary: "Face-analysis collection id/name to search or list within (comma-list ok; default: the case's face collection)", type: "string" },
    { name: "max-faces", summary: "match: cap returned matches (1–4000)", type: "number" },
    { name: "min-similarity", summary: "match/search: similarity floor (0–1)", type: "number" },
    { name: "thumbnails", summary: "detect/match: include per-face thumbnail URLs", type: "boolean" },
    { name: "fps", summary: "detect/match: sampling frames per second", type: "number" },
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
    // the video input goes through the SAME media validation as collection
    // add/entities (reject a scan record's page URL, a non-AV ref, a face-search
    // query image, a missing local file). requireReady:false — a video file is
    // analyzable regardless of whether a prior sense finished.
    let video: string | undefined;
    if (ctx.input) {
      const v = resolveVideoArg(c, ctx.input, "face video", { requireReady: false });
      if (v.error) return [err(v.error)];
      video = v.ref;
    }
    // `!= null` (not truthy) so a provided-but-empty `--collection=` is caught as a
    // user error below rather than treated as omitted (→ silent detect/auto-pick).
    const collectionFlag = ctx.opts.collection != null ? String(ctx.opts.collection) : undefined;
    if (collectionFlag !== undefined && !collectionFlag.trim()) {
      return [err("--collection requires a collection id or name")];
    }
    // a provided-but-blank `--start=`/`--end=` is a user error (it would otherwise
    // be treated as omitted and run the full clip), matching the blank-flag hygiene
    // used for --match/--collection/--min-similarity.
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
      badNumber(ctx.opts, "min-similarity", (n) => n >= 0 && n <= 1, "0–1") ??
      badNumber(ctx.opts, "fps", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number");
    if (numErr) return [err(numErr)];

    // the --match image (a direct path) must exist too (resolveImageRef only
    // type-checks a record-resolved ref; a direct path is trusted until here).
    if (image && !/^https?:\/\//i.test(image) && !existsSync(image)) {
      return [err(`--match image not found: ${image}`)];
    }

    // Resolve which face op the given inputs select. This runs BEFORE the custom
    // branch so a bound provider gets the same op + resolved collections (with the
    // same ambiguity/type-guard/auto-pick) as the default tinycloud path.
    let op: FaceOp;
    let collections: string[] | undefined;
    if (image && video) {
      // match is video-scoped (find this face IN this clip); --collection is for
      // search/list and can't combine with it — fail clearly instead of ignoring it.
      if (collectionFlag) {
        return [err("--collection can't combine with a video for --match: drop the video to search the collection, or drop --collection to match within the video")];
      }
      op = "match";
    } else if (image && !video) {
      // search the face across a face-analysis collection (case-wide).
      if (collectionFlag) {
        const r = resolveFaceCollections(c, collectionFlag);
        if (r.error) return [err(r.error)];
        // a flag that resolves to nothing (whitespace/comma-only) must not run an
        // unscoped search — surface it as the user error it is.
        if (!r.ids.length) return [err(`--collection '${collectionFlag}' has no valid collection id`)];
        collections = r.ids;
      } else {
        // auto-pick the case's sole FACE-ANALYSIS collection. An untyped stub
        // (`collection add` by raw id without --type) stays "unknown" and is NOT
        // assumed to be a face index — classify it with `--type face` or pass
        // --collection explicitly.
        const cands = collectionsByType(c, "face-analysis");
        if (cands.length === 1) collections = [cands[0].id];
        else if (cands.length === 0) {
          return [err("face --match needs a video to search, or a face-analysis collection — create one with `overcast collection create <name> --type face` (or classify an added one with `collection add … --type face`), then retry")];
        } else {
          return [err(`face --match matched ${cands.length} face collections; pass --collection <id> (one of: ${cands.map((x) => x.id).join(", ")})`)];
        }
      }
      op = "search";
    } else if (video && collectionFlag) {
      // list the video's stored detections within the collection.
      const r = resolveFaceCollections(c, collectionFlag);
      if (r.error) return [err(r.error)];
      if (!r.ids.length) return [err(`--collection '${collectionFlag}' has no valid collection id`)];
      collections = r.ids;
      op = "list";
    } else if (video) {
      op = "detect";
    } else {
      return [err("face requires a video (to detect/match), or --match <image> with --collection (to search). See `overcast face --help`.")];
    }

    // A custom face provider takes over (pass-through) with the SAME resolved op +
    // collections, so a bound provider behaves like the default tinycloud path. A
    // tinycloud-style binding (incl. a pinned binary/path) is NOT custom — it runs
    // through runFace below so all four ops work, not just the template's subcommand.
    const binding = ctx.profile.providers?.face;
    if (isCustomBinding(binding) && !isTinycloudFaceBinding(binding)) {
      const primary = op === "search" ? image! : video!;
      const extraArgs: string[] = ["--op", op];
      if (image && (op === "match" || op === "search")) extraArgs.push("--match", image);
      if (collections?.length) extraArgs.push("--collection", collections.join(","));
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
      collections,
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
