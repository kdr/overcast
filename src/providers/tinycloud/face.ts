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
  /** match: cap returned matches (tinycloud: 1–4000) */
  maxFaces?: number;
  /** match/search: similarity/score floor (0–100, tinycloud's percent scale) */
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

/** The start-second of a normalized face's `at` (number or [start,end] span). */
function atStart(f: Record<string, unknown>): number | undefined {
  const a = f.at;
  if (typeof a === "number") return a;
  if (Array.isArray(a) && typeof a[0] === "number") return a[0];
  return undefined;
}

/**
 * A one-line, human-readable headline for a face record — the FIRST thing a
 * reader (or agent) sees, so the basic question is answered without paging the
 * raw faces[] blob. Crucially flags that `detect` counts boxes per sampled frame,
 * NOT unique people (tinycloud detect doesn't cluster), and points at the op that
 * actually identifies a person.
 */
function summarizeFaces(op: FaceOp, faces: Array<Record<string, unknown>>, count: number): string {
  const ts = [...new Set(faces.map(atStart).filter((t): t is number => t !== undefined))].sort((a, b) => a - b);
  const span = ts.length ? ` (${ts[0]}s–${ts[ts.length - 1]}s)` : "";
  // similarity/score is tinycloud's 0–100 scale; render it as a percent range so
  // the reader sees confidence at a glance (e.g. "~100.0%" or "61.2–99.9%").
  const sims = faces.map((f) => f.similarity).filter((s): s is number => typeof s === "number");
  const simPct = (() => {
    if (!sims.length) return "";
    const lo = Math.min(...sims), hi = Math.max(...sims);
    return lo.toFixed(1) === hi.toFixed(1) ? ` at ~${hi.toFixed(1)}% similarity` : ` at ${lo.toFixed(1)}–${hi.toFixed(1)}% similarity`;
  })();
  // pluralize correctly — "match" → "matches" (es after s/x/ch/sh), not "matchs".
  const n = (noun: string) => `${count} ${noun}${count === 1 ? "" : /(s|x|ch|sh)$/.test(noun) ? "es" : "s"}`;
  if (op === "detect") {
    if (count === 0) return "no faces detected in this clip";
    const frames = ts.length ? ` across ${ts.length} frame${ts.length === 1 ? "" : "s"}${span}` : "";
    return `${n("face detection")}${frames} — boxes per sampled frame, not unique people; use \`--match <photo>\` to find a specific person`;
  }
  if (op === "match") {
    if (count === 0) return "the reference face was not found in this clip";
    return `reference face matched at ${n("moment")}${span}${simPct}`;
  }
  if (op === "search") {
    return count === 0 ? "no matches for that face across the collection" : `${n("match")} for that face across the collection${simPct}`;
  }
  // list: a video's STORED detections in a face-analysis collection — same shape as
  // detect (one box per sampled frame), so carry the same span + "not people" caveat.
  if (count === 0) return "no faces stored for this video in the collection";
  const frames = ts.length ? ` across ${ts.length} frame${ts.length === 1 ? "" : "s"}${span}` : "";
  return `${count} stored face detection${count === 1 ? "" : "s"}${frames} — one box per sampled frame, not unique people (with thumbnails)`;
}

/** A compact, COMPLETE projection of the faces — just the time anchor (+ similarity
 *  / file when present), dropping the heavy box + thumbnail. This is the clean
 *  "when/where" timeline a reader actually wants, small enough to page in one go
 *  (or show inline for a few items) without wading through the full faces[] blob. */
function toMoments(faces: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return faces
    .map((f) => {
      const m: Record<string, unknown> = {};
      if (f.at !== undefined) m.at = f.at;
      if (typeof f.similarity === "number") m.similarity = Math.round(f.similarity * 10) / 10; // 1-dp % for a readable timeline
      if (f.file !== undefined) m.file = f.file;
      return m;
    })
    .filter((m) => Object.keys(m).length > 0)
    .sort((a, b) => (atStart(a) ?? 0) - (atStart(b) ?? 0));
}

/** Build the `tinycloud face <op> …` sub-argv from params (input is split-safe
 *  — each ref is its own argv token). */
export function faceArgv(p: FaceParams): string[] {
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
  // collection target (list/search) → a repeated `--in collection:<id>` per
  // collection (search can span several), not one --in with multiple values.
  if ((p.op === "list" || p.op === "search") && p.collections?.length) {
    for (const cId of p.collections) {
      a.push("--in", cId.startsWith("collection:") ? cId : `collection:${cId}`);
    }
  }
  if (p.op === "match" && p.maxFaces != null) a.push("--max-faces", String(p.maxFaces));
  if ((p.op === "match") && p.minSimilarity != null) a.push("--min-similarity", String(p.minSimilarity));
  if (p.op === "search" && p.minSimilarity != null) a.push("--min-score", String(p.minSimilarity));
  if ((p.op === "detect" || p.op === "match") && p.fps != null) a.push("--fps", String(p.fps));
  if ((p.op === "detect" || p.op === "match") && p.start) a.push("--start", p.start);
  if ((p.op === "detect" || p.op === "match") && p.end) a.push("--end", p.end);
  if ((p.op === "detect" || p.op === "match") && p.thumbnails) a.push("--thumbnails");
  if (p.op === "search" && p.groupByFile) a.push("--group-by", "file");
  // --limit caps results for detect/list/search; match caps with --max-faces, so
  // never forward --limit there (tinycloud face match has no such flag).
  if (p.op !== "match" && p.limit != null) a.push("--limit", String(p.limit));
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

  // headline FIRST (so the record reads cleanly without paging the faces[] blob).
  // Always synthesize: it's tailored per op and — for detect — carries the crucial
  // "boxes per frame, not unique people" caveat that tinycloud's terse
  // "Detected N face(s)." omits. Keep tinycloud's own line too when it adds info.
  const payload: Record<string, unknown> = {
    op: p.op,
    summary: summarizeFaces(p.op, faces, typeof count === "number" ? count : faces.length),
    count,
  };
  if (typeof out.env.summary === "string" && out.env.summary.trim()) payload.provider_summary = out.env.summary;
  if (p.image && (p.op === "match" || p.op === "search")) payload.reference = p.image;
  if (p.collections?.length) payload.index = p.collections.length === 1 ? p.collections[0] : p.collections;
  // the compact "when/where" timeline (before the heavy faces[] blob) — the answer
  // most reads want, cleanly pageable on its own.
  if (faces.length) payload.moments = toMoments(faces);
  payload.faces = faces;
  payload.detailed = out.data;

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
