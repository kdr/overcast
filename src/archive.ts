// Archive = the global, cross-case media store. A BUCKET is a case-shaped
// folder (a dir with its own `.overcast/` store) under <home>/archive/<name>,
// so every Case-rooted mechanism — records JSONL, media dir, indexes.json
// mirror, local index DBs, memory providers, setup.json — works on a bucket
// unchanged (invariant #4: no bespoke store object; `Case` is reused, not
// subclassed). There is deliberately NO bucket registry file: the directory
// listing IS the bucket list, so it can't go stale.
//
// Cross-case addressing uses `archive:<bucket>/<item>` refs. This module owns
// bucket naming/paths + ref parsing + the index-scope seam; MEDIA resolution
// for archive refs stays in verbs/media-ref.ts (the one place that resolves
// media refs), which imports these helpers.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { openCase, type Case, type CaseInfo } from "./case.js";
import { resolveHome } from "./profile.js";
import { realpathContained } from "./fs-path.js";
import type { OvercastRecord } from "./record.js";

export const ARCHIVE_DIRNAME = "archive";
export const ARCHIVE_REF_PREFIX = "archive:";

/** The archive root under the overcast home (--home > $OVERCAST_HOME > ~/.overcast). */
export function archiveRoot(home?: string): string {
  return join(resolveHome({ home }), ARCHIVE_DIRNAME);
}

/** Bucket names are single path segments — no separators, no leading dot, so a
 *  name can never traverse out of the archive root. */
export function validBucketName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function bucketDir(name: string, home?: string): string {
  return join(archiveRoot(home), name);
}

export interface BucketHandle {
  name: string;
  dir: string;
  case: Case;
}

/** Open an existing bucket by name. Missing/invalid is an error VALUE (not a
 *  throw) so verbs can surface it as a normal error record. */
export function openBucket(name: string, home?: string): { bucket?: BucketHandle; error?: string } {
  if (!validBucketName(name)) {
    return { error: `invalid archive bucket name '${name}' (letters/digits and . _ - only, no separators)` };
  }
  const c = openCase(bucketDir(name, home));
  if (!c.exists()) {
    return { error: `archive bucket '${name}' not found — create it with \`overcast archive init ${name}\`` };
  }
  return { bucket: { name, dir: c.dir, case: c } };
}

/** Create-if-missing + open a bucket, stamping `kind: "archive"` into its
 *  case.json so a bucket is distinguishable from an investigation case. */
export function ensureBucket(name: string, home?: string): { bucket?: BucketHandle; created?: boolean; error?: string } {
  if (!validBucketName(name)) {
    return { error: `invalid archive bucket name '${name}' (letters/digits and . _ - only, no separators)` };
  }
  const c = openCase(bucketDir(name, home));
  const created = !c.exists();
  try {
    const info = c.ensure() as CaseInfo & { kind?: string };
    if (info.kind !== "archive") {
      writeFileSync(c.caseFile, JSON.stringify({ ...info, kind: "archive" }, null, 2) + "\n", "utf8");
    }
  } catch (e) {
    return { error: `could not initialize archive bucket '${name}': ${(e as Error).message}` };
  }
  return { bucket: { name, dir: c.dir, case: c }, created };
}

/** All initialized buckets under the archive root (self-healing readdir). */
export function listBuckets(home?: string): BucketHandle[] {
  const root = archiveRoot(home);
  if (!existsSync(root)) return [];
  const out: BucketHandle[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!validBucketName(name)) continue;
    const c = openCase(join(root, name));
    if (c.exists()) out.push({ name, dir: c.dir, case: c });
  }
  return out;
}

/** Whether a Case is an archive bucket (case.json kind === "archive"). */
export function isArchiveBucket(c: Case): boolean {
  try {
    return (JSON.parse(readFileSync(c.caseFile, "utf8")) as { kind?: string }).kind === "archive";
  } catch {
    return false;
  }
}

/** Split an `archive:<bucket>/<item>` ref. `item` may be empty ("archive:b") —
 *  resolvers requiring an item reject that themselves. Non-archive refs → undefined. */
export function parseArchiveRef(raw: string): { bucket: string; item: string } | undefined {
  if (!raw.startsWith(ARCHIVE_REF_PREFIX)) return undefined;
  const rest = raw.slice(ARCHIVE_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { bucket: rest, item: "" };
  return { bucket: rest.slice(0, slash), item: rest.slice(slash + 1) };
}

/** Resolve a bucket-relative item to an absolute path INSIDE the bucket, or
 *  undefined. Tries `.overcast/media/<item>` first (the common case), then
 *  `<bucket>/<item>`. Containment is lexical (`../` escape) AND re-checked on
 *  the real path (a bucket-local symlink pointing outside is rejected), the
 *  same double guard as refPathExists in verbs/media-ref.ts. */
export function resolveBucketPath(bucket: BucketHandle, item: string): string | undefined {
  for (const candidate of [join(bucket.case.mediaDir, item), join(bucket.dir, item)]) {
    const lexical = resolve(candidate);
    if (lexical !== bucket.dir && !lexical.startsWith(bucket.dir + sep)) continue;
    if (existsSync(lexical) && realpathContained(bucket.dir, lexical)) return lexical;
  }
  return undefined;
}

/** Streaming sha256 of a file — the archive's content-dedup key (media can be
 *  GBs; never readFileSync it whole). */
export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => res(hash.digest("hex")))
      .on("error", rej);
  });
}

/** The index-scope seam: `--index archive:<bucket>/<index>` resolves to the
 *  BUCKET's Case (its indexes.json mirror + index dir), anything else stays on
 *  the active case. Typed verbs substitute `scope` for ctx.case in mirror
 *  lookups / localIndexDir / member writes, and stamp `bucket` on emitted
 *  records — the query evidence still persists to the ACTIVE case. */
export function resolveIndexScope(
  c: Case,
  raw: string,
  home?: string,
): { scope: Case; value: string; bucket?: string; error?: string } {
  const parsed = parseArchiveRef(raw);
  if (!parsed) return { scope: c, value: raw };
  const opened = openBucket(parsed.bucket, home);
  if (!opened.bucket) return { scope: c, value: raw, error: opened.error };
  if (!parsed.item) {
    return { scope: c, value: raw, error: `archive index ref needs an index: archive:${parsed.bucket}/<index id or name>` };
  }
  return { scope: opened.bucket.case, value: parsed.item, bucket: parsed.bucket };
}

/** Tag a record produced by an archive-scoped query so the evidence (persisted
 *  to the ACTIVE case) traces to the bucket it was matched against. */
export function stampArchive(rec: OvercastRecord, bucket?: string): OvercastRecord {
  if (bucket) rec.meta = { ...rec.meta, archive: bucket };
  return rec;
}
