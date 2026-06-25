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
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerEnv } from "../providers/provider-env.js";
import { findCollection, collectionsByType } from "../state/collection.js";
import type { Case } from "../case.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "face", format: "json", payload: { error: message }, error: message, state: "error" });
}

/** Resolve a media ref: a case record id → its media.ref; otherwise the ref
 *  as-is (path / URL). Mirrors view/capture id resolution. */
function resolveMediaRef(c: Case, ref: string): string {
  const rec = c.recordById(ref);
  if (rec?.media?.ref) return rec.media.ref;
  return ref;
}

/** Resolve a --collection value (id or name, comma-list ok) to tinycloud
 *  collection id(s): a mirrored name/id maps to its real id; an unknown value is
 *  assumed to already be a tinycloud id. */
function resolveCollectionIds(c: Case, value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => findCollection(c, v)?.id ?? v);
}

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

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
    { name: "max-faces", summary: "match: cap returned matches", type: "number" },
    { name: "min-similarity", summary: "match/search: similarity floor (0–100)", type: "number" },
    { name: "thumbnails", summary: "Include face thumbnails", type: "boolean" },
    { name: "fps", summary: "detect/match: sampling frames per second", type: "number" },
    { name: "start", summary: "detect/match: window start (SS or timecode)", type: "string" },
    { name: "end", summary: "detect/match: window end (SS or timecode)", type: "string" },
    { name: "limit", summary: "list/search: max results", type: "number" },
    { name: "offset", summary: "list/search: result offset", type: "number" },
    { name: "group-by", summary: "search: group results by file", type: "string" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "face.analysis",
  providerKey: "face",
  run: async (ctx) => {
    const c = ctx.case;
    const image = ctx.opts.match ? resolveMediaRef(c, String(ctx.opts.match)) : undefined;
    const video = ctx.input ? resolveMediaRef(c, ctx.input) : undefined;
    const collectionFlag = ctx.opts.collection ? String(ctx.opts.collection) : undefined;

    // A custom face provider takes over (pass-through). Hand it the primary
    // media (video, else the query image) and forward the face flags so a bound
    // provider can implement detect/match/search itself.
    const binding = ctx.profile.providers?.face;
    if (isCustomBinding(binding)) {
      const primary = video ?? image;
      if (!primary) return [err("face requires a video, or --match <image> with --collection")];
      const extraArgs: string[] = [];
      if (image && video) extraArgs.push("--match", image);
      if (collectionFlag) extraArgs.push("--collection", collectionFlag);
      for (const f of ["max-faces", "min-similarity", "fps", "start", "end", "limit", "offset", "group-by"]) {
        if (ctx.opts[f] != null) extraArgs.push(`--${f}`, String(ctx.opts[f]));
      }
      if (ctx.opts.thumbnails === true) extraArgs.push("--thumbnails");
      const rec = await runBoundProvider("face", binding!, primary, {
        env: providerEnv(c.mediaDir),
        extraArgs,
        timeoutMs: 15 * 60_000,
        signal: ctx.signal,
      });
      rec.meta = { ...rec.meta, case: c.dir };
      return [rec];
    }

    // Resolve which tinycloud face op the given inputs select.
    let op: FaceOp;
    let collections: string[] | undefined;

    if (image && video) {
      op = "match";
    } else if (image && !video) {
      // search the face across a face-analysis collection (case-wide).
      if (collectionFlag) {
        collections = resolveCollectionIds(c, collectionFlag);
      } else {
        const faceCols = collectionsByType(c, "face-analysis");
        if (faceCols.length === 1) collections = [faceCols[0].id];
        else if (faceCols.length === 0) {
          return [err("face --match needs a video to search, or a face-analysis collection — create one with `overcast collection create <name> --type face` and add videos, then retry")];
        } else {
          return [err(`face --match matched ${faceCols.length} face collections; pass --collection <id> (one of: ${faceCols.map((x) => x.id).join(", ")})`)];
        }
      }
      op = "search";
    } else if (video && collectionFlag) {
      // list the video's stored detections within the collection.
      collections = resolveCollectionIds(c, collectionFlag);
      op = "list";
    } else if (video) {
      op = "detect";
    } else {
      return [err("face requires a video (to detect/match), or --match <image> with --collection (to search). See `overcast face --help`.")];
    }

    // A local file input that doesn't exist (and isn't a URL) is a clear user
    // error — fail before shipping a bogus ref to tinycloud.
    for (const [label, ref] of [["video", video], ["--match image", image]] as const) {
      if (ref && !/^https?:\/\//i.test(ref) && !existsSync(ref)) {
        return [err(`${label} not found: ${ref}`)];
      }
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
      env: providerEnv(c.mediaDir),
      signal: ctx.signal,
    });
    rec.meta = { ...rec.meta, case: c.dir };
    return [rec];
  },
};
