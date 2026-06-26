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
import { collectionsByType, resolveCollectionRef } from "../state/collection.js";
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

/** Validate a numeric face flag (only when provided): returns an error string on
 *  a missing-after-coerce (non-finite) or out-of-bounds value, else undefined. */
function badNumber(opts: VerbContext["opts"], name: string, ok: (n: number) => boolean, expect: string): string | undefined {
  if (opts[name] == null) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n) || !ok(n)) return `invalid --${name}: ${opts[name]} (expected ${expect})`;
  return undefined;
}

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** The leading command of a bound tinycloud `run` template — everything before
 *  the first subcommand / {{input}} / flag — used as runFace's base so a bound
 *  tinycloud binary/wrapper (e.g. `tinycloud-beta …`) is honored rather than
 *  silently ignored. A fully non-tinycloud binding is handled by isCustomBinding
 *  (pass-through) instead; here we only reach a tinycloud-style binding. */
export function tinycloudBaseFromRun(run?: string): string | undefined {
  if (!run || !run.trim()) return undefined;
  const out: string[] = [];
  for (const t of run.trim().split(/\s+/)) {
    if (["face", "library", "ask", "probe", "watch", "listen"].includes(t) || t.startsWith("{{") || t.startsWith("-")) break;
    out.push(t);
  }
  return out.length ? out.join(" ") : undefined;
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
    { name: "max-faces", summary: "match: cap returned matches", type: "number" },
    { name: "min-similarity", summary: "match/search: similarity floor (0–100)", type: "number" },
    { name: "thumbnails", summary: "Include face thumbnails", type: "boolean" },
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
    const image = ctx.opts.match ? resolveMediaRef(c, String(ctx.opts.match)) : undefined;
    const video = ctx.input ? resolveMediaRef(c, ctx.input) : undefined;
    const collectionFlag = ctx.opts.collection ? String(ctx.opts.collection) : undefined;

    // validate the numeric flags up front (covers both the custom + default
    // paths) — reject 0/negative/out-of-range/non-finite like ask/entities,
    // rather than forwarding a junk value to the provider.
    const numErr =
      badNumber(ctx.opts, "max-faces", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "min-similarity", (n) => n >= 0 && n <= 100, "0–100") ??
      badNumber(ctx.opts, "fps", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
      badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number");
    if (numErr) return [err(numErr)];

    // A custom face provider takes over (pass-through). Hand it the primary
    // media (video, else the query image) and forward the face flags so a bound
    // provider can implement detect/match/search itself.
    const binding = ctx.profile.providers?.face;
    if (isCustomBinding(binding)) {
      const primary = video ?? image;
      if (!primary) return [err("face requires a video, or --match <image> with --collection")];
      const extraArgs: string[] = [];
      // Forward --match whenever a reference image is present (not only when a
      // video is too) so a collection-wide SEARCH is distinguishable from detect:
      // a bound provider keys on --match (+ --collection) vs a bare video input.
      if (image) extraArgs.push("--match", image);
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
        // auto-pick the case's sole face collection. A collection added by raw id
        // (not created here) is mirrored with type "unknown" when no --type was
        // given, so fall back to those candidates rather than erroring.
        let cands = collectionsByType(c, "face-analysis");
        if (cands.length === 0) cands = collectionsByType(c, "unknown");
        if (cands.length === 1) collections = [cands[0].id];
        else if (cands.length === 0) {
          return [err("face --match needs a video to search, or a face-analysis collection — create one with `overcast collection create <name> --type face` and add videos, then retry")];
        } else {
          return [err(`face --match matched ${cands.length} collections; pass --collection <id> (one of: ${cands.map((x) => x.id).join(", ")})`)];
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
      // honor a bound tinycloud command/wrapper (consistent with watch/listen);
      // falls back to OVERCAST_TINYCLOUD_CMD / `tinycloud` when unbound.
      base: tinycloudBaseFromRun(binding?.run),
      env: providerEnv(c.mediaDir),
      signal: ctx.signal,
    });
    rec.meta = { ...rec.meta, case: c.dir };
    return [rec];
  },
};
