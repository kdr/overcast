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
  resolveIndexScope,
  stampArchive,
  validBucketName,
} from "../../src/archive.ts";
import { refPathExists, resolveMediaRef } from "../../src/verbs/media-ref.ts";
import { addIndex, listIndexes, findIndex } from "../../src/state/index.ts";
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
    // a scan hit must NOT be swept up by --all (its media.ref is a page URL)
    env.c.writeRecord(makeRecord({ verb: "scan", format: "json", payload: { url: "https://x.test/post" }, media: { ref: "https://x.test/post" }, state: "ready" }));

    const recs = await runArchive(env, "add", [], { all: true, to: "refs" });
    const summary = recs.find((r) => r.verb === "archive")!;
    assert.equal((payload(summary).added as unknown[]).length, 1);
    const cap = recs.find((r) => r.verb === "capture")!;
    assert.equal((payload(cap).origin as Record<string, unknown>).record, src.id);
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
