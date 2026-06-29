// Shared media-ref intake for verbs that take a video/audio argument
// (index add/entities/remove + face). ONE place that resolves a path / URL /
// case-record-id to a media ref AND applies the filters Bugbot kept flagging per
// verb: a record must be captured/sensed media (not a `scan` hit's page URL) and
// not a face-search query image; the ref must be audio/video. Centralized so the
// rule can't drift between verbs (the root cause of the review cascade).

import { existsSync } from "node:fs";
import { isReady, type OvercastRecord } from "../record.js";
import type { Case } from "../case.js";

/** Record verbs whose media.ref is registerable/analyzable case media. Excludes
 *  `scan` — its media.ref is a page/listing URL that still passes isAv for any
 *  http(s); the actual media arrives via `capture` (scan --pull → capture).
 *  Includes `enhance` (its media.ref is a real upscaled/denoised video). */
export const MEDIA_VERBS = ["capture", "watch", "listen", "face", "enhance"];

// Broad enough to cover what tinycloud/ffmpeg actually accept — `watch`/`listen`
// don't gate on extension at all, so index/face intake mustn't be narrower
// and silently drop a valid clip (e.g. a transport-stream .ts or an .opus track).
const AV_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|m2ts|mts|ts|wmv|flv|3gp|3g2|ogv|mxf|mp3|m4a|wav|flac|ogg|oga|opus|aac|wma|aiff?)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp|bmp|tiff?|gif|avif|heic)$/i;

/** Whether a ref looks like audio/video the senses/indexes can use. */
export const isAv = (ref: string): boolean => /^https?:\/\//i.test(ref) || AV_RE.test(ref);
export const isImage = (ref: string): boolean => /^https?:\/\//i.test(ref) || IMAGE_RE.test(ref.replace(/[?#].*$/, ""));

/** Whether a case RECORD is registerable case media: a captured/sensed verb, an
 *  AV `media.ref`, and NOT a face SEARCH (whose media is the query image, not a
 *  case video). State-agnostic — callers add the readiness/pending gate they need.
 *  The single predicate behind `add --all`'s register list AND its pending/failed
 *  accounting, so the two can't drift (e.g. counting a face-search as "pending"). */
export function isRegisterableMediaRecord(r: OvercastRecord): boolean {
  if (!MEDIA_VERBS.includes(r.verb)) return false;
  if (r.verb === "face" && (r.payload as Record<string, unknown> | undefined)?.op === "search") return false;
  return !!r.media?.ref && isAv(r.media.ref);
}

/** A case record id → its media.ref (+ the record id); otherwise the ref as-is
 *  (path / URL). Also resolves capture payload ids (`cap_...`) because those are
 *  the human-facing handles capture emits. Mirrors view/capture id resolution. */
export function resolveMediaRef(c: Case, ref: string): { ref: string; recordId?: string } {
  const rec = c.recordById(ref);
  if (rec?.media?.ref) return { ref: rec.media.ref, recordId: rec.id };
  const byCapture = c.records().find((r) => {
    if (r.verb !== "capture" || !r.media?.ref || !r.payload || typeof r.payload !== "object") return false;
    return (r.payload as Record<string, unknown>).capture_id === ref;
  });
  if (byCapture?.media?.ref) return { ref: byCapture.media.ref, recordId: byCapture.id };
  return { ref };
}

export interface VideoArgOpts {
  /** reject a non-ready (failed/pending/cred-gapped) source record (default true) */
  requireReady?: boolean;
  /** reject a missing local file (default true) */
  requireExists?: boolean;
}

/**
 * Resolve + validate a single video/audio arg (path / URL / case-record-id). A
 * case record must be captured/sensed media (not a `scan` page URL) and not a
 * face-search query image; the resolved ref must be AV. `requireReady` /
 * `requireExists` (default true) gate non-ready records and missing local files —
 * `remove` disables both (you should still un-index a video whose sense errored or
 * whose local file is gone). Returns the resolved ref (+ recordId), or an error.
 */
export function resolveVideoArg(
  c: Case,
  arg: string,
  label: string,
  opts: VideoArgOpts = {},
): { ref?: string; recordId?: string; error?: string } {
  const { requireReady = true, requireExists = true } = opts;
  const { ref, recordId } = resolveMediaRef(c, arg);
  if (recordId) {
    const src = c.recordById(recordId);
    if (src && !MEDIA_VERBS.includes(src.verb)) {
      return { error: `${label}: record ${arg} is a ${src.verb} record, not captured/sensed media — capture it first (e.g. \`scan --pull\`) then use the capture, or pass a path/URL` };
    }
    if (requireReady && src && !isReady(src)) return { error: `${label}: record ${arg} isn't ready (state=${src.state ?? "?"})` };
    if (src?.verb === "face" && (src.payload as Record<string, unknown> | undefined)?.op === "search") {
      return { error: `${label}: record ${arg} is a face search (its media is the query image, not a video)` };
    }
  }
  if (requireExists && !/^https?:\/\//i.test(ref) && !existsSync(ref)) return { error: `${label}: video not found: ${ref}` };
  if (!isAv(ref)) return { error: `${label}: ${ref} is not a video/audio file` };
  return { ref, recordId };
}

/** Resolve + validate a still image arg (path / URL / case-record-id). */
export function resolveImageArg(
  c: Case,
  arg: string,
  label: string,
  opts: Pick<VideoArgOpts, "requireExists" | "requireReady"> = {},
): { ref?: string; recordId?: string; error?: string } {
  const { requireReady = true, requireExists = true } = opts;
  const { ref, recordId } = resolveMediaRef(c, arg);
  if (recordId) {
    const src = c.recordById(recordId);
    if (requireReady && src && !isReady(src)) return { error: `${label}: record ${arg} isn't ready (state=${src.state ?? "?"})` };
  }
  if (requireExists && !/^https?:\/\//i.test(ref) && !existsSync(ref)) return { error: `${label}: image not found: ${ref}` };
  if (!isImage(ref)) return { error: `${label}: ${ref} is not an image file` };
  return { ref, recordId };
}

/** Resolve a local visual query, allowing either a still image or video. */
export function resolveVisualArg(
  c: Case,
  arg: string,
  label: string,
  opts: VideoArgOpts = {},
): { ref?: string; recordId?: string; kind?: "image" | "video"; error?: string } {
  const { ref, recordId } = resolveMediaRef(c, arg);
  if (isImage(ref)) {
    const r = resolveImageArg(c, arg, label, opts);
    return r.error ? { error: r.error } : { ...r, kind: "image" };
  }
  const r = resolveVideoArg(c, arg, label, opts);
  return r.error ? { error: r.error } : { ...r, kind: "video" };
}
