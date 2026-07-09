// The global archive: bucket core (naming/refs/scoping), the archive verb
// (init/list/show/add/remove/setup), cross-case consumption (archive: media
// refs, --index archive: scoping, ask --archive, capture archive: pulls), and
// the record-hygiene guarantees (bucket records never leak into the case).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { archiveVerb } from "../../src/verbs/archive.ts";
import { captureVerb } from "../../src/verbs/osint.ts";
import { askVerb } from "../../src/verbs/read.ts";
import { imageVerb } from "../../src/verbs/image.ts";
import { indexVerb } from "../../src/verbs/index.ts";
import { faceVerb } from "../../src/verbs/face.ts";
import { watchVerb } from "../../src/registry/verbs.ts";
import { openCase, type Case } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { persistRecords } from "../../src/registry/persist.ts";
import {
  bucketDir,
  ensureBucket,
  isArchiveBucket,
  listBuckets,
  openBucket,
  parseArchiveRef,
  provenanceCase,
  resolveIndexScope,
  stampArchive,
  validBucketName,
} from "../../src/archive.ts";
import { provenanceFromCapture } from "../../src/verbs/provenance.ts";
import { refPathExists, resolveMediaRef, resolveVideoArg } from "../../src/verbs/media-ref.ts";
import { addIndex, addMember, listIndexes, findIndex } from "../../src/state/index.ts";
import { loadSetup } from "../../src/state/setup.ts";
import type { VerbContext } from "../../src/registry/types.ts";

interface Env {
  home: string;
  caseDir: string;
  c: Case;
  cleanup: () => void;
}

function makeEnv(): Env {
  const home = mkdtempSync(join(tmpdir(), "oc-arch-home-"));
  const caseDir = mkdtempSync(join(tmpdir(), "oc-arch-case-"));
  const c = openCase(caseDir);
  c.ensure();
  return {
    home,
    caseDir,
    c,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(caseDir, { recursive: true, force: true });
    },
  };
}

function ctx(env: Env, input?: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext {
  return { input, rest, opts, case: env.c, profile: defaultProfile(), home: env.home, profileName: "default" };
}

/** Run the archive verb THROUGH the persist seam (like the CLI/agent), so the
 *  transient/persisted/other-case guards are exercised, not bypassed. */
async function runArchive(env: Env, input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): Promise<OvercastRecord[]> {
  const recs = await archiveVerb.run(ctx(env, input, rest, opts));
  persistRecords(env.c, recs);
  return recs;
}

function payload(rec: OvercastRecord | undefined): Record<string, unknown> {
  return rec?.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
}

function seedFile(env: Env, name: string, bytes: string): string {
  const p = join(env.caseDir, name);
  writeFileSync(p, bytes);
  return p;
}

// ---- core helpers -----------------------------------------------------------

test("validBucketName: single path segments only", () => {
  assert.equal(validBucketName("ref-footage"), true);
  assert.equal(validBucketName("A1.b_c-d"), true);
  assert.equal(validBucketName(""), false);
  assert.equal(validBucketName(".hidden"), false);
  assert.equal(validBucketName("a/b"), false);
  assert.equal(validBucketName(".."), false);
  assert.equal(validBucketName("a".repeat(65)), false);
});

test("parseArchiveRef splits bucket/item; non-archive refs pass through", () => {
  assert.deepEqual(parseArchiveRef("archive:b/clip.mp4"), { bucket: "b", item: "clip.mp4" });
  assert.deepEqual(parseArchiveRef("archive:b/dir/clip.mp4"), { bucket: "b", item: "dir/clip.mp4" });
  assert.deepEqual(parseArchiveRef("archive:b"), { bucket: "b", item: "" });
  assert.equal(parseArchiveRef("youtube:@handle"), undefined);
  assert.equal(parseArchiveRef("/tmp/x.mp4"), undefined);
});

test("ensureBucket stamps kind:archive; openBucket errors on missing/invalid", () => {
  const env = makeEnv();
  try {
    const made = ensureBucket("refs", env.home);
    assert.ok(made.bucket);
    assert.equal(made.created, true);
    assert.equal(isArchiveBucket(made.bucket!.case), true);
    assert.equal(JSON.parse(readFileSync(made.bucket!.case.caseFile, "utf8")).kind, "archive");
    // re-ensure is idempotent
    assert.equal(ensureBucket("refs", env.home).created, false);
    assert.match(openBucket("nope", env.home).error ?? "", /archive init nope/);
    assert.match(openBucket("../etc", env.home).error ?? "", /invalid archive bucket name/);
    assert.equal(listBuckets(env.home).length, 1);
    assert.equal(isArchiveBucket(env.c), false);
  } finally {
    env.cleanup();
  }
});

test("a real case dir under the archive root is never adopted or relabeled", () => {
  const env = makeEnv();
  try {
    ensureBucket("refs", env.home);
    // plant an ordinary investigation case inside <home>/archive/
    const stray = openCase(bucketDir("stray-case", env.home));
    stray.ensure();
    const kindBefore = JSON.parse(readFileSync(stray.caseFile, "utf8")).kind;
    assert.equal(kindBefore, undefined);

    assert.match(openBucket("stray-case", env.home).error ?? "", /not an archive bucket/);
    assert.match(ensureBucket("stray-case", env.home).error ?? "", /not an archive bucket/);
    // ensureBucket must NOT have rewritten the case's kind
    assert.equal(JSON.parse(readFileSync(stray.caseFile, "utf8")).kind, undefined);
    // and the bucket listing excludes it
    assert.deepEqual(listBuckets(env.home).map((b) => b.name), ["refs"]);
  } finally {
    env.cleanup();
  }
});

test("resolveIndexScope: passthrough / bucket scope / errors", () => {
  const env = makeEnv();
  try {
    ensureBucket("refs", env.home);
    const plain = resolveIndexScope(env.c, "my-index", env.home);
    assert.equal(plain.scope, env.c);
    assert.equal(plain.value, "my-index");
    assert.equal(plain.bucket, undefined);

    const scoped = resolveIndexScope(env.c, "archive:refs/faces", env.home);
    assert.equal(scoped.bucket, "refs");
    assert.equal(scoped.value, "faces");
    assert.equal(scoped.scope.dir, bucketDir("refs", env.home));

    assert.match(resolveIndexScope(env.c, "archive:nope/faces", env.home).error ?? "", /not found/);
    assert.match(resolveIndexScope(env.c, "archive:refs", env.home).error ?? "", /needs an index/);
  } finally {
    env.cleanup();
  }
});

// ---- init / list / show -----------------------------------------------------

test("archive init creates the bucket and records its birth in the bucket only", async () => {
  const env = makeEnv();
  try {
    const recs = await runArchive(env, "init", ["refs"], { name: "Reference footage" });
    assert.equal(recs[0].state, "ready");
    assert.equal(payload(recs[0]).created, true);
    assert.equal(payload(recs[0]).name, "Reference footage");
    // the init record lives in the bucket store, not the case
    const bucket = openBucket("refs", env.home).bucket!;
    assert.equal(bucket.case.records().filter((r) => r.verb === "archive").length, 1);
    assert.equal(env.c.records().filter((r) => r.verb === "archive").length, 0);

    assert.match((await runArchive(env, "init", []))[0].error ?? "", /requires a bucket name/);
    assert.match((await runArchive(env, "init", ["a/b"]))[0].error ?? "", /invalid archive bucket name/);
  } finally {
    env.cleanup();
  }
});

test("archive list/show are transient and report items/indexes/setup", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    await runArchive(env, "add", [clip], { to: "refs" });

    const [list] = await runArchive(env, "list");
    assert.equal(list.meta?.transient, true);
    assert.equal(payload(list).count, 1);
    const buckets = payload(list).buckets as Array<Record<string, unknown>>;
    assert.equal(buckets[0].name, "refs");
    assert.equal(buckets[0].items, 1);

    const [show] = await runArchive(env, "show", ["refs"], { limit: 10 });
    assert.equal(show.meta?.transient, true);
    assert.equal(payload(show).total_items, 1);
    const items = payload(show).items as Array<Record<string, unknown>>;
    assert.equal(typeof items[0].sha256, "string");
    // neither list nor show persisted anything into the case
    assert.equal(env.c.records().filter((r) => r.verb === "archive" && payload(r).op !== "add").length, 0);
  } finally {
    env.cleanup();
  }
});

// ---- add --------------------------------------------------------------------

test("archive add: copies into the bucket, dedupes by sha256, keeps the case clean", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const recs = await runArchive(env, "add", [clip], { to: "refs", tags: "drone,uav", note: "known drone" });
    const cap = recs.find((r) => r.verb === "capture")!;
    const p = payload(cap);
    assert.equal(cap.state, "ready");
    assert.equal(typeof p.sha256, "string");
    assert.equal(p.bytes, 9);
    assert.deepEqual(p.tags, ["drone", "uav"]);
    assert.equal(p.note, "known drone");
    assert.equal((p.origin as Record<string, unknown>).case, env.c.dir);
    assert.ok(String(cap.media?.ref).startsWith(bucketDir("refs", env.home)));
    assert.ok(existsSync(String(cap.media?.ref)));

    // summary is the case's ONLY record of the operation (capture stays bucket-side)
    const summary = recs.find((r) => r.verb === "archive")!;
    assert.equal((payload(summary).added as unknown[]).length, 1);
    assert.equal(env.c.records().filter((r) => r.verb === "capture").length, 0);
    assert.equal(env.c.records().filter((r) => r.verb === "archive").length, 1);

    // same content again (different filename) → deduped, no second file
    const dupe = seedFile(env, "copy.mp4", "vid-bytes");
    const recs2 = await runArchive(env, "add", [dupe], { to: "refs" });
    const summary2 = recs2.find((r) => r.verb === "archive")!;
    assert.equal((payload(summary2).added as unknown[]).length, 0);
    assert.equal((payload(summary2).already_archived as Array<Record<string, unknown>>)[0].record, cap.id);

    // sole-bucket default: --to may be omitted when exactly one bucket exists
    const clip2 = seedFile(env, "clip2.mp4", "other-bytes");
    const recs3 = await runArchive(env, "add", [clip2]);
    assert.equal((payload(recs3.find((r) => r.verb === "archive")).added as unknown[]).length, 1);

    // a second bucket makes a bare add ambiguous
    await runArchive(env, "init", ["other"]);
    const recs4 = await runArchive(env, "add", [clip2]);
    assert.match(recs4[0].error ?? "", /multiple archive buckets/);
  } finally {
    env.cleanup();
  }
});

test("archive add: record-id source carries origin provenance; --all archives case media", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const src = makeRecord({
      verb: "capture",
      format: "json",
      payload: { capture_id: "cap_clip.mp4", path: clip, kind: "file", source: "local" },
      media: { ref: clip },
      state: "ready",
    });
    env.c.writeRecord(src);
    // a still IMAGE capture + a `see` record must ALSO be swept (archive stores
    // images, not just AV — an index would skip these)
    const still = seedFile(env, "photo.jpg", "img-bytes");
    env.c.writeRecord(makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_photo.jpg", path: still, kind: "file", source: "local" }, media: { ref: still }, state: "ready" }));
    const seen = seedFile(env, "frame.png", "frame-bytes");
    env.c.writeRecord(makeRecord({ verb: "see", format: "json", payload: { caption: "a frame" }, media: { ref: seen }, state: "ready" }));
    // a scan hit must NOT be swept up by --all (its media.ref is a page URL)
    env.c.writeRecord(makeRecord({ verb: "scan", format: "json", payload: { url: "https://x.test/post" }, media: { ref: "https://x.test/post" }, state: "ready" }));
    // a face SEARCH's query image must NOT be swept
    env.c.writeRecord(makeRecord({ verb: "face", format: "json", payload: { op: "search" }, media: { ref: seedFile(env, "query.jpg", "q") }, state: "ready" }));

    const recs = await runArchive(env, "add", [], { all: true, to: "refs" });
    const summary = recs.find((r) => r.verb === "archive")!;
    // clip (AV) + photo (image capture) + frame (see) = 3. AV-only would archive
    // just the clip (1); 4 would mean the face-search query leaked in. So 3
    // proves images + `see` are swept and scan/face-search are excluded.
    assert.equal((payload(summary).added as unknown[]).length, 3, "--all archives AV + image captures + see, not scan/face-search");
    // the archived items on disk cover all three source basenames
    const onDisk = (payload(summary).added as Array<Record<string, unknown>>).map((a) => basename(String(a.path)));
    for (const stem of ["clip", "photo", "frame"]) assert.ok(onDisk.some((f) => f.startsWith(stem)), `--all archived a ${stem} file`);
  } finally {
    env.cleanup();
  }
});

// ---- remove -------------------------------------------------------------------

test("archive remove: tombstone by sha prefix, file deletion, --keep-file", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const a = seedFile(env, "a.mp4", "aaa");
    const b = seedFile(env, "b.mp4", "bbb");
    const added = await runArchive(env, "add", [a, b], { to: "refs" });
    const caps = added.filter((r) => r.verb === "capture");
    const shaA = String(payload(caps[0]).sha256);

    const [tomb] = await runArchive(env, "remove", [shaA.slice(0, 10)], { from: "refs" });
    assert.equal(payload(tomb).op, "remove");
    assert.equal(payload(tomb).file_removed, true);
    assert.equal(existsSync(String(payload(caps[0]).path)), false);

    const [show] = await runArchive(env, "show", ["refs"]);
    assert.equal(payload(show).total_items, 1);

    const [tomb2] = await runArchive(env, "remove", [basename(String(payload(caps[1]).path))], { from: "refs", "keep-file": true });
    assert.equal(payload(tomb2).file_removed, false);
    assert.equal(existsSync(String(payload(caps[1]).path)), true);

    assert.match((await runArchive(env, "remove", ["nope"], { from: "refs" }))[0].error ?? "", /no archived item matches/);
  } finally {
    env.cleanup();
  }
});

test("re-adding retired bytes RESTORES the kept file instead of duplicating it", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "restore-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const cap = added.find((r) => r.verb === "capture")!;
    const keptPath = String(payload(cap).path);

    // retire with --keep-file: manifest drops it, the file stays
    await runArchive(env, "remove", [cap.id], { from: "refs", "keep-file": true });
    assert.equal(existsSync(keptPath), true);

    // same bytes, different source name → restore: reuse the kept file, fresh record
    const again = seedFile(env, "copy-of-clip.mp4", "restore-bytes");
    const recs = await runArchive(env, "add", [again], { to: "refs" });
    const summary = payload(recs.find((r) => r.verb === "archive")!);
    const entry = (summary.added as Array<Record<string, unknown>>)[0];
    assert.equal(entry.restored_from, cap.id, "restore traces the retired record");
    assert.equal(entry.path, keptPath, "restore reuses the on-disk file");
    const bucket = openBucket("refs", env.home).bucket!;
    const files = bucket.case.records().filter((r) => r.verb === "capture").length;
    assert.equal(files, 2, "restore is a fresh record, not an edit");
    const [show] = await runArchive(env, "show", ["refs"]);
    assert.equal(payload(show).total_items, 1, "one live item after restore");

    // a restore un-retires EVERY addressing form — not just basename/raw path,
    // but the OLD record id and OLD cap id too (round-11 inconsistency: id
    // forms stayed dead while basename/path worked, breaking ask --archive
    // citations that name a record id)
    const oldCapId = String(payload(cap).capture_id);
    const restoredRec = openBucket("refs", env.home).bucket!.case.records()
      .filter((r) => r.verb === "capture" && String((r.payload as Record<string, unknown>).path) === keptPath).at(-1)!;
    for (const [form, addr] of [["old record id", cap.id], ["old cap id", oldCapId], ["basename", basename(keptPath)], ["raw path", keptPath]] as const) {
      const r = resolveMediaRef(env.c, addr === keptPath ? addr : `archive:refs/${addr}`, env.home);
      assert.equal(r.error, undefined, `restore un-retires by ${form}`);
      assert.equal(r.archive, "refs");
      // id/name forms resolve to the LIVE successor record, not the dead one
      if (addr !== keptPath) assert.equal(r.recordId, restoredRec.id, `${form} resolves to the live successor`);
    }

    // retired WITHOUT --keep-file (file gone) → plain re-add copies fresh
    const b = seedFile(env, "b.mp4", "other-bytes");
    const addedB = await runArchive(env, "add", [b], { to: "refs" });
    const capB = addedB.find((r) => r.verb === "capture")!;
    await runArchive(env, "remove", [capB.id], { from: "refs" });
    const recsB = await runArchive(env, "add", [b], { to: "refs" });
    const entryB = (payload(recsB.find((r) => r.verb === "archive")!).added as Array<Record<string, unknown>>)[0];
    assert.equal(entryB.restored_from, undefined);
    assert.ok(existsSync(String(entryB.path)));
  } finally {
    env.cleanup();
  }
});

test("archive remove un-indexes the item from bucket indexes (mirror member dropped)", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const img = seedFile(env, "ref.png", "png-bytes");
    await runArchive(env, "add", [img], { to: "refs" });
    // stand up a bucket image index; backfill registers the archived image
    await runArchive(env, "setup", ["refs"], { index: "stills:image-ransac", yes: true });
    const bucket = openBucket("refs", env.home).bucket!;
    const entry = listIndexes(bucket.case).find((i) => i.name === "stills")!;
    assert.equal(entry.members.length, 1, "backfill registered the member");

    const cap = bucket.case.records().find((r) => r.verb === "capture")!;
    const recs = await runArchive(env, "remove", [cap.id], { from: "refs" });
    const tomb = recs.find((r) => r.verb === "archive" && payload(r).op === "remove")!;
    assert.deepEqual(payload(tomb).unindexed, [entry.id], "tombstone reports the un-indexing");
    assert.equal(findIndex(bucket.case, entry.id)?.members.length, 0, "stale member dropped from the bucket mirror");
  } finally {
    env.cleanup();
  }
});

test("retired items stop resolving as archive: refs (media args + capture pull)", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const cap = added.find((r) => r.verb === "capture")!;
    const file = basename(String(cap.media?.ref));
    await runArchive(env, "remove", [cap.id], { from: "refs", "keep-file": true });

    // record id, capture id, AND the kept file's basename all report "retired"
    for (const item of [cap.id, String(payload(cap).capture_id), file]) {
      const r = resolveMediaRef(env.c, `archive:refs/${item}`, env.home);
      assert.match(r.error ?? "", /retired by `archive remove`/, `item ${item}`);
    }
    const pulled = await captureVerb.run(ctx(env, `archive:refs/${file}`));
    assert.match(pulled[0].error ?? "", /retired/);
  } finally {
    env.cleanup();
  }
});

test("archive refs gate on the BUCKET record's readiness/verb, not an active-case lookup", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const bucket = openBucket("refs", env.home).bucket!;
    const clip = join(bucket.case.mediaDir, "pending.mp4");
    writeFileSync(clip, "vid");
    bucket.case.writeRecord(makeRecord({
      verb: "capture",
      format: "json",
      payload: { capture_id: "cap_pending.mp4", path: clip, kind: "file", source: "local" },
      media: { ref: clip },
      state: "pending",
    }));
    const r = resolveVideoArg(env.c, "archive:refs/cap_pending.mp4", "watch input", { home: env.home });
    assert.match(r.error ?? "", /isn't ready/, "bucket record's pending state gates the ref");

    // watch/listen/grid/… pass requireReady:false (a local file is analyzable
    // regardless of a prior sense) — but a BUCKET capture's pending state means
    // the FILE is partial, so it's gated regardless of requireReady
    const notReady = resolveVideoArg(env.c, "archive:refs/cap_pending.mp4", "watch input", { requireReady: false, home: env.home });
    assert.match(notReady.error ?? "", /isn't ready/, "archive readiness gate ignores requireReady:false");
    // ...but a pure mirror op (index remove: requireExists:false) may still
    // un-index a non-ready archived item — the gate keys on requireExists
    const unindex = resolveVideoArg(env.c, "archive:refs/cap_pending.mp4", "index remove", { requireReady: false, requireExists: false, home: env.home });
    assert.equal(unindex.error, undefined, "un-indexing a non-ready archived item is not blocked");

    // the FILENAME and the RAW path forms carry the owning record too — a
    // partial in-flight file isn't fair game just because the bytes exist
    const byName = resolveVideoArg(env.c, "archive:refs/pending.mp4", "watch input", { home: env.home });
    assert.match(byName.error ?? "", /isn't ready/, "filename form gates the same way");
    const byPath = resolveVideoArg(env.c, clip, "watch input", { home: env.home });
    assert.match(byPath.error ?? "", /isn't ready/, "raw path form gates the same way");

    // frame://archive:<bucket>/<item>@<sec> gates on readiness too (see/enhance)
    const { seeVerb: seeV } = await import("../../src/verbs/senses.ts");
    const frameOut = await seeV.run(ctx(env, "frame://archive:refs/cap_pending.mp4@1"));
    assert.match(frameOut[0].error ?? "", /isn't ready/, "frame source gates on readiness");

    // capture pulls and explicit archive adds gate the same way — never copy a
    // partial in-flight file
    const pulled = await captureVerb.run(ctx(env, "archive:refs/cap_pending.mp4"));
    assert.match(pulled[0].error ?? "", /isn't ready/);
    await runArchive(env, "init", ["other"]);
    const recs = await runArchive(env, "add", ["archive:refs/cap_pending.mp4"], { to: "other" });
    assert.match(recs[0].error ?? "", /isn't ready/);

    // the READING verbs gate on it too — a pending bucket capture's partial
    // file must not produce misleading forensic/face/see results
    const { seeVerb, enhanceVerb, viewVerb, exifVerb, verifyVerb } = await import("../../src/verbs/senses.ts")
      .then(async (s) => ({ ...s, ...(await import("../../src/verbs/forensics.ts")) }));
    for (const [verb, arg] of [
      [seeVerb, "archive:refs/pending.mp4"],
      [enhanceVerb, "archive:refs/pending.mp4"],
      [viewVerb, "archive:refs/pending.mp4"],
      [exifVerb, "archive:refs/pending.mp4"],
      [verifyVerb, "archive:refs/pending.mp4"],
      [faceVerb, undefined],
    ] as const) {
      const opts = verb === faceVerb ? { match: "archive:refs/pending.mp4" } : {};
      const out = await verb.run(ctx(env, arg, [], opts));
      assert.match(out[0].error ?? "", /isn't ready/, `${verb.name} gates a pending bucket ref`);
    }
  } finally {
    env.cleanup();
  }
});

test("reading verbs gate a pending CASE record, not just bucket refs (thread-2 class, root fix)", async () => {
  const env = makeEnv();
  try {
    // a pending case capture: resolveMediaRef returns recordId but (pre-fix) no
    // `record`, so a readiness gate keyed on resolved.record fired ONLY for
    // archive refs and silently skipped this. resolveMediaRef now always carries
    // `record`, so every reading verb gates it like it gates a pending bucket ref.
    const clip = seedFile(env, "pending.mp4", "partial");
    const pend = makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_pending.mp4", path: clip }, media: { ref: clip }, state: "pending" });
    env.c.writeRecord(pend);
    const { seeVerb, enhanceVerb, viewVerb } = await import("../../src/verbs/senses.ts");
    const { exifVerb, verifyVerb } = await import("../../src/verbs/forensics.ts");
    for (const verb of [seeVerb, enhanceVerb, viewVerb, exifVerb, verifyVerb]) {
      const out = await verb.run(ctx(env, pend.id));
      assert.match(out[0].error ?? "", /isn't ready/, `${verb.name} gates a pending case record`);
    }
    // and via cap-id addressing (byCapture branch now sets record too)
    assert.match((await exifVerb.run(ctx(env, "cap_pending.mp4")))[0].error ?? "", /isn't ready/);
    // resolveMediaRef surfaces the record for both id forms
    assert.equal(resolveMediaRef(env.c, pend.id).record?.id, pend.id);
    assert.equal(resolveMediaRef(env.c, "cap_pending.mp4").record?.id, pend.id);
  } finally {
    env.cleanup();
  }
});

test("a retired --keep-file item is blocked by RAW absolute path too, not just archive: refs", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const cap = added.find((r) => r.verb === "capture")!;
    const keptPath = String(cap.media?.ref);

    // live: a raw bucket path resolves and carries the bucket (meta.archive)
    const live = resolveMediaRef(env.c, keptPath, env.home);
    assert.equal(live.error, undefined);
    assert.equal(live.archive, "refs");

    await runArchive(env, "remove", [cap.id], { from: "refs", "keep-file": true });
    assert.equal(existsSync(keptPath), true);
    const retired = resolveMediaRef(env.c, keptPath, env.home);
    assert.match(retired.error ?? "", /retired by `archive remove`/);
    assert.equal(refPathExists(env.caseDir, keptPath, env.home), false, "note/finding --ref path validation rejects it too");
    // an unrelated absolute path outside the archive root is untouched
    assert.equal(resolveMediaRef(env.c, clip, env.home).error, undefined);
  } finally {
    env.cleanup();
  }
});

test("face --match resolves archive: refs (and errors clearly on a missing item)", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const face = seedFile(env, "known-face.png", "png-bytes");
    await runArchive(env, "add", [face], { to: "refs" });
    const bucket = openBucket("refs", env.home).bucket!;
    const file = basename(String(payload(bucket.case.records().find((r) => r.verb === "capture")!).path));

    // a real archived still resolves PAST the exists/type gates and reaches op
    // resolution (no video, no index → the usual guidance error, not "not found")
    const recs = await faceVerb.run(ctx(env, undefined, [], { match: `archive:refs/${file}` }));
    assert.match(recs[0].error ?? "", /needs a video to search|face-analysis index|deepface-local index/);

    const missing = await faceVerb.run(ctx(env, undefined, [], { match: "archive:refs/nope.png" }));
    assert.match(missing[0].error ?? "", /not found/);
  } finally {
    env.cleanup();
  }
});

test("watch on an archive: ref stamps meta.archive (in-place sensing traces to the bucket)", async () => {
  const env = makeEnv();
  const prev = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const file = basename(String(added.find((r) => r.verb === "capture")!.media?.ref));

    const recs = await watchVerb.run(ctx(env, `archive:refs/${file}`));
    assert.equal(recs[0].meta?.archive, "refs");
    assert.equal(recs[0].meta?.case, env.c.dir);
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prev;
    env.cleanup();
  }
});

test("archive add from another bucket carries the SOURCE bucket record as origin", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["src-refs"]);
    await runArchive(env, "init", ["dst-refs"]);
    const clip = seedFile(env, "clip.mp4", "cross-bucket-bytes");
    const added = await runArchive(env, "add", [clip], { to: "src-refs" });
    const srcCap = added.find((r) => r.verb === "capture")!;
    const file = basename(String(srcCap.media?.ref));

    const recs = await runArchive(env, "add", [`archive:src-refs/${file}`], { to: "dst-refs" });
    const cap = recs.find((r) => r.verb === "capture")!;
    const origin = payload(cap).origin as Record<string, unknown>;
    assert.equal(origin.record, srcCap.id, "origin.record traces the source bucket item");
    assert.equal(origin.url, `archive:src-refs/${file}`);
  } finally {
    env.cleanup();
  }
});

test("see/view/enhance resolve archive: refs and block retired raw paths like the other senses", async () => {
  const env = makeEnv();
  try {
    const { seeVerb, enhanceVerb, viewVerb } = await import("../../src/verbs/senses.ts");
    await runArchive(env, "init", ["refs"]);
    const img = seedFile(env, "still.png", "png-bytes");
    const added = await runArchive(env, "add", [img], { to: "refs" });
    const cap = added.find((r) => r.verb === "capture")!;
    const file = basename(String(cap.media?.ref));
    const keptPath = String(cap.media?.ref);

    // view resolves the archive ref (os-open for a png) and stamps the bucket
    const viewed = await viewVerb.run(ctx(env, `archive:refs/${file}`, [], { "no-open": true }));
    assert.equal(viewed[0].state, "ready");
    assert.equal(viewed[0].meta?.archive, "refs");
    assert.equal(payload(viewed[0]).ref, keptPath);

    // missing items error through the resolver (not a literal-path miss)
    assert.match((await seeVerb.run(ctx(env, "archive:refs/nope.png")))[0].error ?? "", /not found/);
    assert.match((await enhanceVerb.run(ctx(env, "archive:refs/nope.png")))[0].error ?? "", /not found/);
    assert.match((await viewVerb.run(ctx(env, "archive:refs/nope.png")))[0].error ?? "", /not found/);

    // a retired --keep-file item is blocked by raw path in all three
    await runArchive(env, "remove", [cap.id], { from: "refs", "keep-file": true });
    for (const verb of [seeVerb, enhanceVerb, viewVerb]) {
      const recs = await verb.run(ctx(env, keptPath));
      assert.match(recs[0].error ?? "", /retired/, `${verb.name} blocks the retired raw path`);
    }
  } finally {
    env.cleanup();
  }
});

test("a case record carrying meta.archive keeps the bucket trace when resolved by id/cap-id", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const file = basename(String(added.find((r) => r.verb === "capture")!.media?.ref));

    // pull a copy into the case — the case capture record is stamped meta.archive
    const pulls = await captureVerb.run(ctx(env, `archive:refs/${file}`));
    persistRecords(env.c, pulls);
    const caseCap = pulls[0];
    assert.equal(caseCap.meta?.archive, "refs");
    const capId = String(payload(caseCap).capture_id);

    // resolving that CASE copy by record id or capture id keeps archive set,
    // so downstream senses (watch/listen/see/grid/view) re-stamp the bucket
    // without the caller re-typing the full archive: ref
    const byRec = resolveMediaRef(env.c, caseCap.id, env.home);
    assert.equal(byRec.archive, "refs", "record-id resolution carries the bucket trace");
    const byCap = resolveMediaRef(env.c, capId, env.home);
    assert.equal(byCap.archive, "refs", "capture-id resolution carries the bucket trace");
    // and resolveVideoArg (watch/listen/grid) surfaces it
    assert.equal(resolveVideoArg(env.c, caseCap.id, "watch input", { requireReady: false, home: env.home }).archive, "refs");

    // view on an archived-origin case record stamps meta.archive (use an image
    // item so view takes the os-open path — no ffmpeg in the unit env)
    const png = seedFile(env, "still.png", "png-bytes");
    const pngAdd = await runArchive(env, "add", [png], { to: "refs" });
    const pngFile = basename(String(pngAdd.find((r) => r.verb === "capture")!.media?.ref));
    const pngPull = await captureVerb.run(ctx(env, `archive:refs/${pngFile}`));
    persistRecords(env.c, pngPull);
    const { viewVerb } = await import("../../src/verbs/senses.ts");
    const viewed = await viewVerb.run(ctx(env, pngPull[0].id, [], { "no-open": true }));
    assert.equal(viewed[0].meta?.archive, "refs");
  } finally {
    env.cleanup();
  }
});

test("provenanceCase routes capture-provenance lookup to the bucket for archived media", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const bucket = openBucket("refs", env.home).bucket!;
    // a bucket capture that itself came from a post (source_url provenance)
    const file = join(bucket.case.mediaDir, "fromtweet.mp4");
    writeFileSync(file, "vid");
    bucket.case.writeRecord(makeRecord({
      verb: "capture",
      format: "json",
      payload: { capture_id: "cap_fromtweet.mp4", path: file, kind: "file", source: "x", source_url: "https://x.test/status/42", source_author: "someone" },
      media: { ref: file },
      state: "ready",
    }));

    // active case can't see the bucket capture — provenance would be lost
    assert.deepEqual(provenanceFromCapture(env.c, file), {});
    // ...but provenanceCase routes the lookup to the bucket, recovering it
    const prov = provenanceFromCapture(provenanceCase(env.c, "refs", env.home), file);
    assert.equal(prov.source_url, "https://x.test/status/42");
    assert.equal(prov.source_author, "someone");
    // no bucket → the active case, unchanged
    assert.equal(provenanceCase(env.c, undefined, env.home), env.c);
  } finally {
    env.cleanup();
  }
});

test("see/enhance frame:// refs resolve a bucket clip (archive:<bucket>/<item>)", async () => {
  const env = makeEnv();
  try {
    const { seeVerb } = await import("../../src/verbs/senses.ts");
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const file = basename(String(added.find((r) => r.verb === "capture")!.media?.ref));

    // a bucket clip addressed as a frame source resolves PAST the record lookup
    // (the failure is frame extraction — no ffmpeg here — not "cannot resolve")
    const ok = await seeVerb.run(ctx(env, `frame://archive:refs/${file}@1`));
    assert.doesNotMatch(ok[0].error ?? "", /cannot resolve/, "bucket frame source resolved");
    // a missing bucket item reports the resolver's not-found through the frame path
    const missing = await seeVerb.run(ctx(env, "frame://archive:refs/nope.mp4@1"));
    assert.match(missing[0].error ?? "", /cannot resolve .*not found/);
  } finally {
    env.cleanup();
  }
});

test("note/finding anchored to archived evidence stamp meta.archive (direct ref + via a stamped record)", async () => {
  const env = makeEnv();
  try {
    const { noteVerb } = await import("../../src/verbs/note.ts");
    const { findingVerb } = await import("../../src/verbs/finding.ts");
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const file = basename(String(added.find((r) => r.verb === "capture")!.media?.ref));

    // anchoring directly to an archive: ref → the record traces to the bucket,
    // and payload.ref keeps the archive: string for the citation
    const note = await noteVerb.run(ctx(env, "known drone", [], { ref: `archive:refs/${file}` }));
    assert.equal(note[0].meta?.archive, "refs");
    assert.equal((note[0].payload as Record<string, unknown>).ref, `archive:refs/${file}`);
    const finding = await findingVerb.run(ctx(env, "create", ["confirmed sighting"], { ref: `archive:refs/${file}`, target: "drone" }));
    assert.equal(finding[0].meta?.archive, "refs");

    // anchoring to a CASE record that already carries meta.archive (e.g. a
    // capture archive:… pull) propagates the trace too
    const pull = await captureVerb.run(ctx(env, `archive:refs/${file}`));
    persistRecords(env.c, pull);
    const note2 = await noteVerb.run(ctx(env, "same clip", [], { ref: pull[0].id }));
    assert.equal(note2[0].meta?.archive, "refs");
  } finally {
    env.cleanup();
  }
});

test("parity guard: every local match/identify verb stamps query provenance through provenanceCase", () => {
  // one whole class of Bugbot findings on this PR was "verb X handles archive
  // refs but verb Y (adjacent, same shape) doesn't". This locks the
  // provenance-through-the-bucket wiring across every match/identify path so a
  // future edit can't silently drop it from one and reopen the whack-a-mole.
  // Floors, not exact counts, so a legitimate refactor that ADDS a path passes.
  const expected: Record<string, number> = {
    "src/verbs/similar.ts": 2, // CLIP match + CLAP match
    "src/verbs/image.ts": 1, // image match
    "src/verbs/audio.ts": 1, // audio match
    "src/verbs/voice.ts": 1, // voice match (pairwise + search share one stamp)
    "src/verbs/face.ts": 3, // deepface-local + custom + tinycloud match
    "src/verbs/cluster.ts": 2, // ingest + identify
  };
  for (const [rel, min] of Object.entries(expected)) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const hits = (src.match(/provenanceFromCapture\(provenanceCase\(/g) ?? []).length;
    assert.ok(hits >= min, `${rel}: expected >= ${min} provenanceCase-routed provenance stamps, found ${hits}`);
  }
});

test("an auto-suggested finding inherits the archive-index match record's bucket trace", async () => {
  const env = makeEnv();
  try {
    const { makeFinding } = await import("../../src/verbs/finding.ts");
    // a match record produced against an archive index (stamped meta.archive)
    const match = makeRecord({
      verb: "image",
      format: "json",
      payload: { op: "match", count: 1 },
      media: { ref: "/case/query.png" },
      meta: { case: env.c.dir, archive: "refs" },
      state: "ready",
    });
    const lead = makeFinding({ text: "matched a known logo", target: "logo", sourceRecord: match, trigger: "signal:image-match", status: "suggested" });
    assert.equal(lead.meta?.archive, "refs", "the suggested lead traces to the bucket the match hit");
  } finally {
    env.cleanup();
  }
});

// ---- index remove/delete against a bucket index -----------------------------------

test("index remove --from / delete on archive:… manage the BUCKET's index", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const bucket = openBucket("refs", env.home).bucket!;
    addIndex(bucket.case, { id: "local_image_x", type: "image-ransac", name: "stills", backend: "local" });
    const img = seedFile(env, "ref.png", "png-bytes");
    addMember(bucket.case, "local_image_x", { ref: img });
    assert.equal(findIndex(bucket.case, "local_image_x")?.members.length, 1);

    const removed = await indexVerb.run(ctx(env, "remove", [img], { from: "archive:refs/stills" }));
    assert.equal(removed[0].state, "ready");
    assert.equal(removed[0].meta?.archive, "refs", "scoped index ops stamp meta.archive");
    assert.equal(findIndex(bucket.case, "local_image_x")?.members.length, 0, "member removed from the bucket mirror");

    const shown = await indexVerb.run(ctx(env, "show", ["archive:refs/stills"], {}));
    assert.equal(shown[0].meta?.archive, "refs");

    const deleted = await indexVerb.run(ctx(env, "delete", ["archive:refs/stills"], {}));
    assert.equal(deleted[0].state, "ready");
    assert.equal(deleted[0].meta?.archive, "refs");
    assert.equal(findIndex(bucket.case, "local_image_x"), undefined, "bucket mirror entry deleted");
    assert.match((await indexVerb.run(ctx(env, "delete", ["archive:nope/stills"], {})))[0].error ?? "", /not found/);
  } finally {
    env.cleanup();
  }
});

// ---- archive: media refs ------------------------------------------------------

test("resolveMediaRef/refPathExists: archive refs resolve in-bucket with containment", async () => {
  const env = makeEnv();
  const outside = mkdtempSync(join(tmpdir(), "oc-arch-out-"));
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const recs = await runArchive(env, "add", [clip], { to: "refs" });
    const cap = recs.find((r) => r.verb === "capture")!;
    const file = basename(String(cap.media?.ref));
    const capId = String(payload(cap).capture_id);

    for (const item of [file, cap.id, capId]) {
      const r = resolveMediaRef(env.c, `archive:refs/${item}`, env.home);
      assert.equal(r.error, undefined, `item ${item}`);
      assert.equal(r.ref, cap.media?.ref);
      assert.equal(r.archive, "refs");
    }
    assert.match(resolveMediaRef(env.c, "archive:refs/missing.mp4", env.home).error ?? "", /not found/);
    assert.match(resolveMediaRef(env.c, "archive:nope/x.mp4", env.home).error ?? "", /not found/);
    assert.match(resolveMediaRef(env.c, "archive:refs", env.home).error ?? "", /needs an item/);
    // a nested archive: item's inner failure surfaces the INNER cause (the
    // missing inner bucket), not a masked "not found in bucket refs"
    const nested = resolveMediaRef(env.c, "archive:refs/archive:nope/x.mp4", env.home);
    assert.match(nested.error ?? "", /bucket 'nope' not found|archive init nope/);
    assert.doesNotMatch(nested.error ?? "", /bucket 'refs'/);
    // a SUCCESSFUL nested ref carries the INNER bucket's record + archive tag,
    // not the outer's (round-13: the outer branch must not re-look-up / re-stamp)
    await runArchive(env, "init", ["inner"]);
    const innerClip = seedFile(env, "innerclip.mp4", "inner-bytes");
    const innerAdd = await runArchive(env, "add", [innerClip], { to: "inner" });
    const innerCap = innerAdd.find((r) => r.verb === "capture")!;
    const deep = resolveMediaRef(env.c, `archive:refs/archive:inner/${innerCap.id}`, env.home);
    assert.equal(deep.error, undefined);
    assert.equal(deep.archive, "inner", "nested ref stamps the INNER bucket, not the outer");
    assert.equal(deep.recordId, innerCap.id);
    assert.equal(deep.record?.id, innerCap.id, "the inner bucket record is carried through (not an outer-case miss)");
    assert.equal(deep.ref, innerCap.media?.ref);
    // ../ escape out of the bucket → not found (containment)
    writeFileSync(join(outside, "secret.mp4"), "s");
    const esc = resolveMediaRef(env.c, `archive:refs/../../${basename(outside)}/secret.mp4`, env.home);
    assert.ok(esc.error, "escape must not resolve");
    // a bucket-local symlink pointing outside → rejected by the realpath re-check
    const bucket = openBucket("refs", env.home).bucket!;
    symlinkSync(join(outside, "secret.mp4"), join(bucket.case.mediaDir, "link.mp4"));
    assert.ok(resolveMediaRef(env.c, "archive:refs/link.mp4", env.home).error, "symlink escape must not resolve");

    assert.equal(refPathExists(env.caseDir, `archive:refs/${file}`, env.home), true);
    assert.equal(refPathExists(env.caseDir, "archive:refs/missing.mp4", env.home), false);
  } finally {
    env.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---- --index archive: scoping ---------------------------------------------------

test("image add --index archive:… registers the member in the BUCKET, evidence in the case", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const bucket = openBucket("refs", env.home).bucket!;
    addIndex(bucket.case, { id: "local_image_test", type: "image-ransac", name: "stills", backend: "local" });
    const img = seedFile(env, "ref.png", "png-bytes");

    const recs = await imageVerb.run(ctx(env, "add", [img], { index: "archive:refs/stills" }));
    persistRecords(env.c, recs);
    assert.equal(recs[0].state, "ready");
    assert.equal(recs[0].meta?.archive, "refs");
    // member landed in the bucket mirror; the case mirror stays empty
    assert.equal(findIndex(bucket.case, "local_image_test")?.members.length, 1);
    assert.equal(listIndexes(env.c).length, 0);
    // the add record is CASE evidence
    assert.equal(env.c.records().filter((r) => r.verb === "image").length, 1);

    assert.match((await imageVerb.run(ctx(env, "add", [img], { index: "archive:nope/stills" })))[0].error ?? "", /not found/);
  } finally {
    env.cleanup();
  }
});

test("voice --index archive:… scopes to the BUCKET's voice-print DB (merged from #86)", async () => {
  const env = makeEnv();
  try {
    const { voiceVerb } = await import("../../src/verbs/voice.ts");
    await runArchive(env, "init", ["refs"]);
    const bucket = openBucket("refs", env.home).bucket!;
    addIndex(bucket.case, { id: "local_voice_test", type: "voice-print", name: "voices", backend: "local" });
    const clip = seedFile(env, "sample.wav", "aud-bytes");

    // a bad bucket errors at scope resolution, before media/provider
    assert.match((await voiceVerb.run(ctx(env, "add", [clip], { index: "archive:nope/voices" })))[0].error ?? "", /not found/);
    // good bucket + missing index resolves against the BUCKET mirror (not the
    // active case, which has no indexes) → "unknown voice-print index"
    assert.match((await voiceVerb.run(ctx(env, "add", [clip], { index: "archive:refs/missing" })))[0].error ?? "", /unknown local voice-print index/);
    // the real bucket index passes scope + index validation and reaches the
    // provider (offline it errors on the Python, but NOT on scope/index)
    const recs = await voiceVerb.run(ctx(env, "add", [clip], { index: "archive:refs/voices" }));
    assert.doesNotMatch(recs[0].error ?? "", /unknown local voice-print index|not found in bucket/);
  } finally {
    env.cleanup();
  }
});

test("match verbs stamp the QUERY's bucket even when --index is case-local (round 14 pattern A)", async () => {
  const env = makeEnv();
  try {
    // a case-local image index + an archived query image
    addIndex(env.c, { id: "local_case_img", type: "image-ransac", name: "caseidx", backend: "local" });
    await runArchive(env, "init", ["refs"]);
    const img = seedFile(env, "q.png", "png-bytes");
    const added = await runArchive(env, "add", [img], { to: "refs" });
    const file = basename(String(added.find((r) => r.verb === "capture")!.media?.ref));
    // image match <archive query> --index <case index>: index scope is case-local
    // (no bucket), but the QUERY came from a bucket → the record still traces to
    // it (stampArchive unions scoped.bucket ?? q.archive). The provider errors
    // offline, but meta.archive is stamped on the emitted record regardless.
    const recs = await imageVerb.run(ctx(env, "match", [`archive:refs/${file}`], { index: "caseidx" }));
    assert.equal(recs[0].meta?.archive, "refs", "query bucket stamped even with a case-local index");
  } finally {
    env.cleanup();
  }
});

test("note/finding reject a pending bucket ref; capture pull carries bucket-item provenance (round 14 B/C)", async () => {
  const env = makeEnv();
  try {
    const { noteVerb } = await import("../../src/verbs/note.ts");
    const { findingVerb } = await import("../../src/verbs/finding.ts");
    await runArchive(env, "init", ["refs"]);
    const bucket = openBucket("refs", env.home).bucket!;

    // (C) a pending bucket capture — note/finding must not anchor to its partial file
    const pending = join(bucket.case.mediaDir, "pending.mp4");
    writeFileSync(pending, "partial");
    bucket.case.writeRecord(makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_pending.mp4", path: pending }, media: { ref: pending }, state: "pending" }));
    assert.match((await noteVerb.run(ctx(env, "seen it", [], { ref: "archive:refs/cap_pending.mp4" })))[0].error ?? "", /isn't ready/);
    assert.match((await findingVerb.run(ctx(env, "create", ["lead"], { ref: "archive:refs/cap_pending.mp4", target: "x" })))[0].error ?? "", /isn't ready/);

    // (B) a READY bucket item whose capture carries originating-post provenance
    const withProv = join(bucket.case.mediaDir, "fromtweet.mp4");
    writeFileSync(withProv, "vid");
    bucket.case.writeRecord(makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_fromtweet.mp4", path: withProv, source_url: "https://x.test/status/9", source_author: "poster" }, media: { ref: withProv }, state: "ready" }));
    const pull = await captureVerb.run(ctx(env, "archive:refs/cap_fromtweet.mp4"));
    const p = payload(pull[0]);
    assert.equal(p.source_url, "https://x.test/status/9", "pulled copy inherits the bucket item's source_url");
    assert.equal(p.source_author, "poster");
    assert.equal(p.source, "archive");
  } finally {
    env.cleanup();
  }
});

test("face SEARCH carries the QUERY image's bucket provenance (round 15 thread 1)", async () => {
  const env = makeEnv();
  const prev = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    await runArchive(env, "init", ["refs"]);
    const bucket = openBucket("refs", env.home).bucket!;
    // an archived query face-still whose bucket capture records where it came from
    const q = join(bucket.case.mediaDir, "suspect.png");
    writeFileSync(q, "png-bytes");
    bucket.case.writeRecord(makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_suspect.png", path: q, source_url: "https://x.test/status/42", source_author: "tipster" }, media: { ref: q }, state: "ready" }));
    // a case-local tinycloud face-analysis index to search across
    addIndex(env.c, { id: "col_faces", type: "face-analysis", name: "faces" });

    // face --match <archived image> --index faces → SEARCH. The query IS the image
    // (there is no video), so provenance must trace to the query image's bucket
    // capture. Round 15: search stamped from the unset `video`, dropping source_*.
    const recs = await faceVerb.run(ctx(env, undefined, [], { match: "archive:refs/cap_suspect.png", index: "faces" }));
    assert.equal(recs[0].state === "error", false, recs[0].error);
    const p = payload(recs[0]);
    assert.equal(p.source_url, "https://x.test/status/42", "search inherits the query image's originating post");
    assert.equal(p.source_author, "tipster");
    assert.equal(recs[0].meta?.archive, "refs", "search record traces to the query's bucket");
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prev;
    env.cleanup();
  }
});

test("face --match gates a PENDING case-record query image (round 15 thread 2)", async () => {
  const env = makeEnv();
  try {
    const img = seedFile(env, "q.png", "png-bytes");
    // a pending case capture whose media is the query still. A case record id
    // carries recordId but NOT `record` on the resolver result — round 15: only
    // archive refs (which DO carry `record`) were readiness-gated, so a pending
    // case record's partial image slipped through as a valid --match query.
    const pend = makeRecord({ verb: "capture", format: "json", payload: { capture_id: "cap_q.png", path: img }, media: { ref: img }, state: "pending" });
    env.c.writeRecord(pend);
    const recs = await faceVerb.run(ctx(env, undefined, [], { match: pend.id, index: "faces" }));
    assert.match(recs[0].error ?? "", /isn't ready/);
  } finally {
    env.cleanup();
  }
});

test("archive remove finds a live item by its PRE-RESTORE record id (round 15 thread 3)", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "restore-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const cap = added.find((r) => r.verb === "capture")!;
    // retire with --keep-file, then restore the same bytes over the kept file: the
    // live successor gets a NEW record id, the old id is tombstoned.
    await runArchive(env, "remove", [cap.id], { from: "refs", "keep-file": true });
    const again = seedFile(env, "copy.mp4", "restore-bytes");
    await runArchive(env, "add", [again], { to: "refs" });

    // remove by the OLD (pre-restore) record id must still hit the live successor:
    // resolveMediaRef maps the stale id → the successor's path (parity with
    // `watch archive:…/<old id>`). Round 15: remove matched only the live
    // manifest's ids, so the stale id 404'd even though the media ref resolved.
    const [tomb] = await runArchive(env, "remove", [cap.id], { from: "refs" });
    assert.equal(tomb.error, undefined, tomb.error);
    assert.equal(payload(tomb).op, "remove");
    const [show] = await runArchive(env, "show", ["refs"]);
    assert.equal(payload(show).total_items, 0, "the live successor is retired via the stale id");

    // a genuinely-unknown id still 404s (the direct-match fallback is unchanged)
    assert.match((await runArchive(env, "remove", ["rec_nope"], { from: "refs" }))[0].error ?? "", /no archived item matches/);
  } finally {
    env.cleanup();
  }
});

test("bucket-side watch evidence is written ONCE by auto-index/backfill, not twice (round 15 thread 4)", async () => {
  const env = makeEnv();
  const prev = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    await runArchive(env, "add", [clip], { to: "refs" });

    // a media-descriptions index runs `index add`, which ensures a bucket-side
    // watch record (ensureArchiveWatchRecord) — WRITTEN to the bucket AND returned
    // for display, stamped meta.persisted. The setup/add loop's writeToBucket must
    // treat that as already-stored, not re-append the JSONL row (which would
    // inflate ask --archive / memory). See the writeToBucket idempotency guard.
    const totalWatch = () => openBucket("refs", env.home).bucket!.case.records().filter((r) => r.verb === "watch").length;
    await runArchive(env, "setup", ["refs"], { index: "desc:media-descriptions", "auto-index-new": true, yes: true });
    assert.equal(totalWatch(), 1, "setup backfill wrote clip.mp4's watch exactly once");

    // the auto_index_new path on the NEXT add is idempotent the same way
    const clip2 = seedFile(env, "clip2.mp4", "vid2-bytes");
    await runArchive(env, "add", [clip2], { to: "refs" });
    assert.equal(totalWatch(), 2, "auto-index-new added clip2's watch exactly once (no duplicate)");
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prev;
    env.cleanup();
  }
});

test("stampArchive re-homes provider-stamped records so the case persist seam keeps them", () => {
  const env = makeEnv();
  try {
    ensureBucket("refs", env.home);
    // the local provider runners (runLocalImage/Audio/Clip/Face/Cluster) stamp
    // meta.case from the Case they ran against — the BUCKET for an archive-scoped
    // query. Without re-homing, the active case's other-case guard drops the
    // evidence silently (the live-suite regression this test pins).
    const rec = makeRecord({
      verb: "image",
      format: "json",
      payload: { op: "match", count: 1 },
      meta: { case: bucketDir("refs", env.home), provider: "local:image-ransac" },
      state: "ready",
    });
    stampArchive(rec, "refs", env.c.dir);
    persistRecords(env.c, rec ? [rec] : []);
    const persisted = env.c.records().find((r) => r.id === rec.id);
    assert.ok(persisted, "archive-scoped match evidence persists to the ACTIVE case");
    assert.equal(persisted!.meta?.archive, "refs");
  } finally {
    env.cleanup();
  }
});

// ---- setup wizard ----------------------------------------------------------------

test("archive setup: wizard guidance, plan saves nothing, apply mirrors + backfills", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const img = seedFile(env, "ref.png", "png-bytes");
    await runArchive(env, "add", [img], { to: "refs" });
    const bucket = openBucket("refs", env.home).bucket!;

    // no inputs → pending wizard guidance (transient)
    const [wizard] = await runArchive(env, "setup", ["refs"]);
    assert.equal(wizard.state, "pending");
    assert.equal(wizard.meta?.transient, true);
    assert.equal((payload(wizard).wizard_steps as unknown[]).length, 6);

    // plan → nothing saved
    const [plan] = await runArchive(env, "setup", ["refs", "plan"], { index: "stills:image-ransac" });
    assert.equal(plan.state, "pending");
    assert.equal(payload(plan).saved, false);
    assert.ok((payload(plan).planned_operations as string[]).some((o) => o.includes("backfill")));
    assert.equal(existsSync(bucket.case.setupFile), false);

    // investigation-only flags rejected
    assert.match((await runArchive(env, "setup", ["refs"], { target: "someone", yes: true }))[0].error ?? "", /reference stores, not investigations/);

    // apply → setup.json saved, local index mirrored with backend local, image backfilled
    const applied = await runArchive(env, "setup", ["refs"], { index: "stills:image-ransac", memory: "local-grep", "auto-index-new": true, yes: true });
    const setupRec = applied.find((r) => r.verb === "archive" && payload(r).op === "archive_setup")!;
    assert.equal(payload(setupRec).saved, true);
    const saved = loadSetup(bucket.case)!;
    assert.equal(saved.memory.backend, "local-grep");
    assert.ok(saved.memory.signals.includes("capture"));
    assert.equal(saved.automation?.auto_index_new, true);
    const entry = listIndexes(bucket.case).find((i) => i.name === "stills")!;
    assert.equal(entry.backend, "local");
    assert.equal(entry.type, "image-ransac");
    assert.equal(entry.members.length, 1, "backfill registered the archived image");

    // sub-of-sole-bucket form + status/show
    const [status] = await runArchive(env, "setup", ["status"]);
    assert.equal(payload(status).op, "setup_status");
    assert.equal(payload(status).items, 1);
    const [show] = await runArchive(env, "setup", ["refs", "show"]);
    assert.equal(payload(show).completed, true);

    // auto_index_new: the NEXT add routes into the index automatically
    const img2 = seedFile(env, "ref2.png", "png2-bytes");
    const recs = await runArchive(env, "add", [img2], { to: "refs" });
    const summary = recs.find((r) => r.verb === "archive" && payload(r).op === "add")!;
    assert.ok((payload(summary).indexed as string[]).length >= 1, "auto-index ran");
    assert.equal(findIndex(bucket.case, entry.id)?.members.length, 2);
  } finally {
    env.cleanup();
  }
});

test("archive setup --folder routes still images too (buckets aren't AV-only)", async () => {
  const env = makeEnv();
  const folder = mkdtempSync(join(tmpdir(), "oc-arch-folder-"));
  try {
    await runArchive(env, "init", ["refs"]);
    // a folder of reference photos + one video + an ignored non-media file
    writeFileSync(join(folder, "a.png"), "png");
    writeFileSync(join(folder, "b.jpg"), "jpg");
    writeFileSync(join(folder, "clip.mp4"), "vid");
    writeFileSync(join(folder, "readme.txt"), "ignore");

    const applied = await runArchive(env, "setup", ["refs"], { index: "stills:image-ransac", folder, yes: true });
    const setupRec = applied.find((r) => r.verb === "archive" && payload(r).op === "archive_setup")!;
    // folderMediaFiles picks up the 2 images + the video (not the .txt) — pre-fix
    // it dropped the images and reported 1 media file
    assert.match(JSON.stringify(payload(setupRec).applied_operations), /folder select: .*\(3 media files\)/);
    const saved = loadSetup(openBucket("refs", env.home).bucket!.case)!;
    const routed = saved.media.routes.map((r) => basename(r.ref)).sort();
    assert.deepEqual(routed, ["a.png", "b.jpg", "clip.mp4"], "still images route alongside the video");
  } finally {
    rmSync(folder, { recursive: true, force: true });
    env.cleanup();
  }
});

// ---- ask --archive ------------------------------------------------------------------

test("ask --archive answers over the bucket via local-grep with zero setup", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    await runArchive(env, "add", [clip], { to: "refs", tags: "drone", note: "warehouse sighting" });

    const [answer] = await askVerb.run(ctx(env, "warehouse", [], { archive: "refs" }));
    assert.equal(answer.state, "ready");
    assert.ok(((payload(answer).citations as unknown[]) ?? []).length >= 1, "bucket item cited");
    assert.equal(answer.meta?.archive, "refs");
    assert.equal((payload(answer).archive as Record<string, unknown>).dir, bucketDir("refs", env.home));

    assert.match((await askVerb.run(ctx(env, "q", [], { archive: "refs", index: "foo" })))[0].error ?? "", /mutually exclusive/);
    assert.match((await askVerb.run(ctx(env, "q", [], { archive: "nope" })))[0].error ?? "", /not found/);
    assert.match((await askVerb.run(ctx(env, "q", [], { archive: " " })))[0].error ?? "", /requires a bucket name/);
  } finally {
    env.cleanup();
  }
});

// ---- capture archive: pull ------------------------------------------------------------

test("capture archive:… pulls a copy with provenance; second pull dedupes", async () => {
  const env = makeEnv();
  try {
    await runArchive(env, "init", ["refs"]);
    const clip = seedFile(env, "clip.mp4", "vid-bytes");
    const added = await runArchive(env, "add", [clip], { to: "refs" });
    const item = added.find((r) => r.verb === "capture")!;
    const ref = `archive:refs/${basename(String(item.media?.ref))}`;

    const pulls = await captureVerb.run(ctx(env, ref));
    persistRecords(env.c, pulls);
    const cap = pulls[0];
    assert.equal(cap.state, "ready");
    assert.equal(payload(cap).source, "archive");
    assert.equal(payload(cap).source_ref, ref);
    assert.equal((payload(cap).origin as Record<string, unknown>).bucket, "refs");
    assert.equal(cap.meta?.archive, "refs");
    assert.ok(String(cap.media?.ref).startsWith(env.c.mediaDir), "copied into the case");

    const again = await captureVerb.run(ctx(env, ref));
    assert.equal(payload(again[0]).already_present, true);
    assert.equal(payload(again[0]).record, cap.id);
    assert.equal(again[0].meta?.transient, true);

    assert.match((await captureVerb.run(ctx(env, "archive:refs/missing.mp4")))[0].error ?? "", /not found/);
  } finally {
    env.cleanup();
  }
});
