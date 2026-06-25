// Default `face` provider: tinycloud (exec). Invariant #9 — call tinycloud only
// via its public CLI verbs (`tinycloud face detect|match|list|search`); map the
// envelope to the loose record at THIS boundary (invariant #3). One verb fans
// out to four tinycloud face ops; all land in a `face.analysis` record whose
// `faces[]` is a best-effort normalization and `detailed` keeps the full data.

import { makeRecord, type OvercastRecord } from "../../record.js";
import {
  runTinycloud,
  type RunTinycloudOpts,
} from "./envelope.js";
import type { ProviderDescriptor } from "../../profile.js";

/** The four tinycloud face operations overcast's `face` verb fans out to. */
export type FaceOp = "detect" | "match" | "list" | "search";

export interface FaceParams {
  op: FaceOp;
  /** the video/source to analyze (detect/match/list) */
  source?: string;
  /** the query face image (match/search) */
  image?: string;
  /** a face-analysis collection id (list/search); search may target several */
  collections?: string[];
  /** match: cap returned matches */
  maxFaces?: number;
  /** match/search: similarity floor (0–100) */
  minSimilarity?: number;
  /** detect/match: sampling fps + time window */
  fps?: number;
  start?: string;
  end?: string;
  /** include base64/URL face thumbnails */
  thumbnails?: boolean;
  /** list/search paging */
  limit?: number;
  offset?: number;
  /** search: group results by file */
  groupByFile?: boolean;
}

/** Coerce a timestamp to seconds, tolerating numeric strings ("12.5"). */
function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Pick the first present value among several candidate keys. */
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** The array of faces/matches in a tinycloud face envelope, tolerating the
 *  several shapes the four ops can return. */
function faceArray(data: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const k of ["faces", "matches", "detections", "results", "items", "hits"]) {
    const v = data[k];
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
  }
  return [];
}

/** A point-in-time anchor for a face item: a single second, or a [start,end]
 *  span when both endpoints are present. */
function faceAt(o: Record<string, unknown>): number | [number, number] | undefined {
  const start = toSeconds(pick(o, ["at", "timestamp", "time", "time_seconds", "start", "start_seconds", "second"]));
  const end = toSeconds(pick(o, ["end", "end_seconds", "end_time"]));
  if (start !== undefined && end !== undefined && end !== start) return [start, end];
  return start;
}

/** Normalize a raw face/match item to overcast's common shape (only defined
 *  fields are emitted; the raw item survives in the record's `detailed`). */
function normalizeFace(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const at = faceAt(o);
  if (at !== undefined) out.at = at;
  const box = pick(o, ["box", "bbox", "bounding_box", "boundingBox"]);
  if (box !== undefined) out.box = box;
  const sim = toSeconds(pick(o, ["similarity", "score", "confidence"]));
  if (sim !== undefined) out.similarity = sim;
  const id = pick(o, ["face_id", "faceId", "id"]);
  if (id !== undefined) out.face_id = id;
  const file = pick(o, ["file", "source", "source_id", "sourceId", "video", "file_id", "fileId"]);
  if (file !== undefined) out.file = file;
  const thumb = pick(o, ["thumbnail", "thumb", "thumbnail_url", "thumbnailUrl", "image"]);
  if (thumb !== undefined) out.thumbnail = thumb;
  // keep nothing-matched items meaningful: fall back to the raw item.
  return Object.keys(out).length ? out : o;
}

/** The first numeric seek anchor across the normalized faces (for media.at). */
function firstAnchor(faces: Array<Record<string, unknown>>): number | undefined {
  for (const f of faces) {
    const a = f.at;
    if (typeof a === "number") return a;
    if (Array.isArray(a) && typeof a[0] === "number") return a[0];
  }
  return undefined;
}

/** Build the `tinycloud face <op> …` sub-argv from params (input is split-safe
 *  — each ref is its own argv token). */
function faceArgv(p: FaceParams): string[] {
  const a: string[] = ["face", p.op];
  if (p.op === "detect") {
    if (p.source) a.push(p.source);
  } else if (p.op === "match") {
    if (p.image) a.push(p.image);
    if (p.source) a.push(p.source);
  } else if (p.op === "list") {
    if (p.source) a.push(p.source);
  } else if (p.op === "search") {
    if (p.image) a.push(p.image);
  }
  // collection target (list/search) → `--in collection:<id>` (search may repeat)
  if ((p.op === "list" || p.op === "search") && p.collections?.length) {
    a.push("--in", ...p.collections.map((c) => (c.startsWith("collection:") ? c : `collection:${c}`)));
  }
  if (p.op === "match" && p.maxFaces != null) a.push("--max-faces", String(p.maxFaces));
  if ((p.op === "match") && p.minSimilarity != null) a.push("--min-similarity", String(p.minSimilarity));
  if (p.op === "search" && p.minSimilarity != null) a.push("--min-score", String(p.minSimilarity));
  if ((p.op === "detect" || p.op === "match") && p.fps != null) a.push("--fps", String(p.fps));
  if ((p.op === "detect" || p.op === "match") && p.start) a.push("--start", p.start);
  if ((p.op === "detect" || p.op === "match") && p.end) a.push("--end", p.end);
  if ((p.op === "detect" || p.op === "match") && p.thumbnails) a.push("--thumbnails");
  if (p.op === "search" && p.groupByFile) a.push("--group-by", "file");
  if (p.limit != null) a.push("--limit", String(p.limit));
  if ((p.op === "list" || p.op === "search") && p.offset != null) a.push("--offset", String(p.offset));
  a.push("--json");
  return a;
}

export interface FaceOptions extends RunTinycloudOpts {}

/**
 * Run a tinycloud face op and map the envelope → a single `face.analysis`
 * record. The analyzed media is the record's `media.ref` (the video for
 * detect/match/list; the query image for search), seekable via `media.at`.
 */
export async function runFace(p: FaceParams, opts: FaceOptions = {}): Promise<OvercastRecord> {
  const argv = faceArgv(p);
  const out = await runTinycloud(argv, opts);

  // the analyzed media: video for detect/match/list; the query image for search
  const mediaRef = p.op === "search" ? p.image : p.source;

  if (out.state === "error" || out.state === "needs_credentials") {
    return makeRecord({
      verb: "face",
      format: "json",
      payload: { op: p.op, faces: [], count: 0, detailed: out.data },
      media: mediaRef ? { ref: mediaRef } : undefined,
      meta: { provider: "tinycloud", model: "cloudglue", op: p.op },
      error: out.error,
      state: out.state,
    });
  }

  const faces = faceArray(out.data).map(normalizeFace);
  const count =
    toSeconds(out.data.count) ?? toSeconds(out.data.total) ?? faces.length;
  const anchor = firstAnchor(faces);

  const payload: Record<string, unknown> = {
    op: p.op,
    faces,
    count,
    detailed: out.data,
  };
  if (p.image && (p.op === "match" || p.op === "search")) payload.reference = p.image;
  if (p.collections?.length) payload.collection = p.collections.length === 1 ? p.collections[0] : p.collections;
  if (typeof out.env.summary === "string") payload.summary = out.env.summary;

  const media = mediaRef
    ? { ref: mediaRef, at: p.op === "search" ? undefined : anchor }
    : undefined;

  return makeRecord({
    verb: "face",
    format: "json",
    payload,
    media,
    meta: { provider: "tinycloud", model: "cloudglue", op: p.op },
    state: out.state,
  });
}

/** The default profile descriptor for `face` (custom bindings override it; the
 *  default path uses `runFace`, not this `run` template). */
export function tinycloudFaceDescriptor(): ProviderDescriptor {
  return {
    type: "exec",
    run: "tinycloud face detect {{input}} --json",
    init: { skill: "tinycloud-init", ensure: true },
    describe: "tinycloud commands --json",
  };
}
