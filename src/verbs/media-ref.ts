// Shared media-ref intake for verbs that take a video/audio argument
// (index add/entities/remove + face). ONE place that resolves a path / URL /
// case-record-id to a media ref AND applies the filters Bugbot kept flagging per
// verb: a record must be captured/sensed media (not a `scan` hit's page URL) and
// not a face-search query image; the ref must be audio/video. Centralized so the
// rule can't drift between verbs (the root cause of the review cascade).

import { existsSync } from "node:fs";
import { basename, resolve, sep, isAbsolute } from "node:path";
import { realpathContained } from "../fs-path.js";
import { isReady, type OvercastRecord } from "../record.js";
import type { Case } from "../case.js";
import { ARCHIVE_REF_PREFIX, bucketPathStatus, bucketRecordForPath, listBucketItems, openBucket, parseArchiveRef, resolveBucketPath } from "../archive.js";

/** Whether a `--ref` string points at a real LOCAL file, for the finding/note
 *  evidence-ref guard. An absolute path is taken as-is (an explicit operator
 *  choice); an `archive:<bucket>/<file>` ref must exist INSIDE its bucket; a
 *  relative path resolves against the CASE dir (so `--case <dir>` from
 *  another cwd finds .overcast/media/… ) but MUST stay inside it — a `../` escape,
 *  OR a case-local SYMLINK pointing outside, that would validate/anchor files
 *  beyond the case store is rejected (containment is re-checked on the real path). */
export function refPathExists(caseDir: string, rawRef: string, home?: string): boolean {
  if (rawRef.startsWith(ARCHIVE_REF_PREFIX)) {
    const parsed = parseArchiveRef(rawRef);
    if (!parsed?.item) return false;
    const { bucket } = openBucket(parsed.bucket, home);
    return !!bucket && resolveBucketPath(bucket, parsed.item) !== undefined;
  }
  if (isAbsolute(rawRef)) {
    // a raw path INTO a bucket honors the manifest like an archive: ref would —
    // a --keep-file retirement isn't bypassable by pasting the file path
    if (bucketPathStatus(rawRef, home).retired) return false;
    return existsSync(rawRef);
  }
  const p = resolve(caseDir, rawRef);
  if (p !== caseDir && !p.startsWith(caseDir + sep)) return false; // lexical ../ escape
  // existsSync/resolve are lexical + follow symlinks: re-check containment on the
  // REAL path so a case-local symlink can't point outside the store.
  return existsSync(p) && realpathContained(caseDir, p);
}

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

/** Verbs whose media.ref is captured/sensed media the ARCHIVE can store —
 *  MEDIA_VERBS (AV) plus `see` (its media.ref is the analyzed still image) and
 *  `screenshot` (a rendered-page PNG). */
const ARCHIVABLE_MEDIA_VERBS = [...MEDIA_VERBS, "see", "screenshot"];

/** Whether a case RECORD is captured/sensed media for `archive add --all`.
 *  Like isRegisterableMediaRecord, but the archive stores IMAGES **and** audio/
 *  video (an index is AV-only), so this accepts an image OR AV media.ref and
 *  includes the image sense `see` — otherwise `--all` silently skips `.jpg`/
 *  `.png` captures and `see` records, contrary to "archive every captured/
 *  sensed media record". Excludes scan page URLs (verb not in the set) and
 *  face-search query images. */
export function isArchivableMediaRecord(r: OvercastRecord): boolean {
  const ref = r.media?.ref;
  if (!ref) return false;
  if (!ARCHIVABLE_MEDIA_VERBS.includes(r.verb)) return false;
  if (r.verb === "face" && (r.payload as Record<string, unknown> | undefined)?.op === "search") return false;
  return isAv(ref) || isImage(ref);
}

/** A case record id → its media.ref (+ the record id); otherwise the ref as-is
 *  (path / URL). Also resolves capture payload ids (`cap_...`) because those are
 *  the human-facing handles capture emits. Mirrors view/capture id resolution.
 *  An `archive:<bucket>/<item>` ref resolves against the BUCKET's store instead
 *  (record id / capture id / bucket-contained media path → absolute path),
 *  reports the bucket in `archive`, and carries the resolved bucket `record` so
 *  callers can gate on readiness/verb without an active-case lookup (which
 *  would find nothing). Resolution honors the MANIFEST: an item retired by
 *  `archive remove` errors instead of resolving (consistent with `archive
 *  show`); a bad archive ref sets `error` rather than falling through as a
 *  literal path. */
export function resolveMediaRef(c: Case, ref: string, home?: string): { ref: string; recordId?: string; record?: OvercastRecord; archive?: string; error?: string } {
  if (ref.startsWith(ARCHIVE_REF_PREFIX)) {
    const parsed = parseArchiveRef(ref)!;
    const { bucket, error } = openBucket(parsed.bucket, home);
    if (!bucket) return { ref, error };
    if (!parsed.item) {
      return { ref, error: `archive ref needs an item: archive:${parsed.bucket}/<record id | capture id | media file>` };
    }
    const items = listBucketItems(bucket, { includeRemoved: true });
    const retiredErr = () => ({
      ref,
      error: `${ref} was retired by \`archive remove\` — re-add it with \`overcast archive add\` to restore it`,
    });
    // "retired" means a tombstone with NO live successor for the same FILE. A
    // restore (`archive add` of the same bytes) re-adds a live capture over the
    // kept file, so the OLD record id / cap id / basename / path must resolve
    // AGAIN to that live item — not stay dead. This one predicate keeps every
    // addressing form consistent (the round-11 inconsistency was id-forms dead
    // while basename/path worked).
    const liveForPath = (p: string | undefined) => (p ? items.find((it) => !it.removed && it.path === p) : undefined);
    // record id / capture id — through the bucket STORE (any verb, any state:
    // a pending capture must resolve so the readiness gate can report it),
    // with the manifest's tombstones layered on top. Pass `home` so a nested
    // archive: item or an absolute bucket path inside resolves against the SAME
    // archive root, not the env/default one.
    const inBucket = resolveMediaRef(bucket.case, parsed.item, home);
    // surface a real inner failure (a nested archive: item that errored, a
    // missing inner bucket, a retired absolute path) instead of masking it as
    // the outer bucket's "not found". A plain unresolved literal (no error, no
    // recordId) still falls through to basename/path resolution below.
    if (inBucket.error) return { ref, error: inBucket.error };
    if (inBucket.recordId) {
      // a NESTED archive: item (or a bucket path) already resolved through its
      // OWN bucket — the inner call applied that bucket's tombstone/readiness
      // context and set `record` + `archive` correctly. Pass it through
      // unchanged; a lookup in THIS bucket's case would miss the inner record
      // and mis-stamp the outer bucket.
      if (inBucket.archive != null) return inBucket;
      if (items.some((it) => it.removed && it.record.id === inBucket.recordId)) {
        const succ = liveForPath(inBucket.ref);
        if (succ) return { ref: succ.path!, recordId: succ.record.id, record: succ.record, archive: parsed.bucket };
        return retiredErr();
      }
      return { ref: inBucket.ref, recordId: inBucket.recordId, record: bucket.case.recordById(inBucket.recordId), archive: parsed.bucket };
    }
    // media filename — the LIVE manifest item that owns it
    const live = items.find((it) => !it.removed && !!it.path && basename(it.path) === parsed.item);
    if (live) return { ref: live.path!, recordId: live.record.id, record: live.record, archive: parsed.bucket };
    if (items.some((it) => it.removed && !!it.path && basename(it.path) === parsed.item)) return retiredErr();
    const path = resolveBucketPath(bucket, parsed.item);
    if (path) {
      if (items.some((it) => it.removed && it.path === path) && !liveForPath(path)) return retiredErr();
      // an on-disk file owned by a NON-ready capture (pending/error) must carry
      // its record so the readiness gates fire — a partial download addressed by
      // filename is not fair game just because the bytes exist
      const owner = bucketRecordForPath(bucket, path);
      if (owner) return { ref: path, recordId: owner.id, record: owner, archive: parsed.bucket };
      return { ref: path, archive: parsed.bucket };
    }
    return { ref, error: `${ref} not found (no matching record, capture id, or media file in bucket '${parsed.bucket}')` };
  }
  // a resolved case record carries its own bucket trace forward: `capture
  // archive:…` stamps meta.archive on the case copy, so resolving that copy by
  // record id / cap_ id keeps `archive` set — downstream stampArchive/refBucket
  // trace the bucket without the caller re-typing the full archive: ref.
  const recArchive = (r: OvercastRecord): string | undefined =>
    typeof r.meta?.archive === "string" ? r.meta.archive : undefined;
  // Always carry the resolved `record` alongside `recordId` — not just for
  // archive/bucket refs. A consumer's readiness/verb gate keyed on
  // `resolved.record` (forensics, see/enhance/view, capture) would otherwise fire
  // ONLY for archive refs and silently skip a pending/errored CASE record (which
  // has recordId but, without this, no record) — the class behind the face
  // `--match` gate miss. One place sets it so no call site has to re-look-up.
  const rec = c.recordById(ref);
  if (rec?.media?.ref) return { ref: rec.media.ref, recordId: rec.id, record: rec, ...(recArchive(rec) ? { archive: recArchive(rec) } : {}) };
  const byCapture = c.records().find((r) => {
    if (r.verb !== "capture" || !r.media?.ref || !r.payload || typeof r.payload !== "object") return false;
    return (r.payload as Record<string, unknown>).capture_id === ref;
  });
  if (byCapture?.media?.ref) return { ref: byCapture.media.ref, recordId: byCapture.id, record: byCapture, ...(recArchive(byCapture) ? { archive: recArchive(byCapture) } : {}) };
  // a raw ABSOLUTE path into a bucket honors the manifest like its archive: ref
  // would (retired files error; live/in-flight ones carry the bucket + their
  // owning record so meta.archive and the readiness gates apply)
  if (isAbsolute(ref)) {
    const st = bucketPathStatus(ref, home);
    if (st.retired) return { ref, error: `${ref} was retired by \`archive remove\` — re-add it with \`overcast archive add\` to restore it` };
    if (st.bucket) return { ref, archive: st.bucket.name, ...(st.record ? { recordId: st.record.id, record: st.record } : {}) };
  }
  return { ref };
}

export interface VideoArgOpts {
  /** reject a non-ready (failed/pending/cred-gapped) source record (default true) */
  requireReady?: boolean;
  /** reject a missing local file (default true) */
  requireExists?: boolean;
  /** overcast home override for archive: refs (ctx.home; env/default otherwise) */
  home?: string;
}

/**
 * Resolve + validate a single video/audio arg (path / URL / case-record-id). A
 * case record must be captured/sensed media (not a `scan` page URL) and not a
 * face-search query image; the resolved ref must be AV. `requireReady` /
 * `requireExists` (default true) gate non-ready records and missing local files —
 * `remove` disables both (you should still un-index a video whose sense errored or
 * whose local file is gone). Returns the resolved ref (+ recordId), or an error.
 *
 * A BUCKET capture is readiness-gated whenever the caller needs to READ the
 * file (`requireExists`), independent of `requireReady`: a pending/errored
 * bucket capture means the FILE is still being materialized (partial on disk),
 * so in-place `watch`/`listen`/`grid`/… (which pass requireReady:false but need
 * the file) must not process it, matching capture/archive add/forensics. Pure
 * mirror ops (`index remove`/`entities`, which pass requireExists:false to
 * un-index gone/errored media) are unaffected.
 */
export function resolveVideoArg(
  c: Case,
  arg: string,
  label: string,
  opts: VideoArgOpts = {},
): { ref?: string; recordId?: string; archive?: string; error?: string } {
  const { requireReady = true, requireExists = true } = opts;
  const { ref, recordId, record, archive, error } = resolveMediaRef(c, arg, opts.home);
  if (error) return { error: `${label}: ${error}` };
  if (recordId) {
    // an archive ref carries its BUCKET record — gate on that, not an
    // active-case lookup that would find nothing and silently skip the checks
    const src = record ?? c.recordById(recordId);
    if (src && !MEDIA_VERBS.includes(src.verb)) {
      return { error: `${label}: record ${arg} is a ${src.verb} record, not captured/sensed media — capture it first (e.g. \`scan --pull\`) then use the capture, or pass a path/URL` };
    }
    if ((requireReady || (archive != null && requireExists)) && src && !isReady(src)) return { error: `${label}: record ${arg} isn't ready (state=${src.state ?? "?"})` };
    if (src?.verb === "face" && (src.payload as Record<string, unknown> | undefined)?.op === "search") {
      return { error: `${label}: record ${arg} is a face search (its media is the query image, not a video)` };
    }
  }
  if (requireExists && !/^https?:\/\//i.test(ref) && !existsSync(ref)) return { error: `${label}: video not found: ${ref}` };
  if (!isAv(ref)) return { error: `${label}: ${ref} is not a video/audio file` };
  return { ref, recordId, archive };
}

/** Resolve + validate a still image arg (path / URL / case-record-id). */
export function resolveImageArg(
  c: Case,
  arg: string,
  label: string,
  opts: Pick<VideoArgOpts, "requireExists" | "requireReady" | "home"> = {},
): { ref?: string; recordId?: string; archive?: string; error?: string } {
  const { requireReady = true, requireExists = true } = opts;
  const { ref, recordId, record, archive, error } = resolveMediaRef(c, arg, opts.home);
  if (error) return { error: `${label}: ${error}` };
  if (recordId) {
    const src = record ?? c.recordById(recordId);
    // a bucket capture is always readiness-gated (partial file), independent of
    // requireReady — see resolveVideoArg
    if ((requireReady || (archive != null && requireExists)) && src && !isReady(src)) return { error: `${label}: record ${arg} isn't ready (state=${src.state ?? "?"})` };
  }
  if (requireExists && !/^https?:\/\//i.test(ref) && !existsSync(ref)) return { error: `${label}: image not found: ${ref}` };
  if (!isImage(ref)) return { error: `${label}: ${ref} is not an image file` };
  return { ref, recordId, archive };
}

/** Resolve a local visual query, allowing either a still image or video. */
export function resolveVisualArg(
  c: Case,
  arg: string,
  label: string,
  opts: VideoArgOpts = {},
): { ref?: string; recordId?: string; archive?: string; kind?: "image" | "video"; error?: string } {
  const { ref, error } = resolveMediaRef(c, arg, opts.home);
  if (error) return { error: `${label}: ${error}` };
  if (isImage(ref)) {
    const r = resolveImageArg(c, arg, label, opts);
    return r.error ? { error: r.error } : { ...r, kind: "image" };
  }
  const r = resolveVideoArg(c, arg, label, opts);
  return r.error ? { error: r.error } : { ...r, kind: "video" };
}
