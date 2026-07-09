// `archive` verb — the global archive: named cross-case buckets under
// <home>/archive/. A bucket is a case-shaped folder (src/archive.ts), so its
// store, indexes, memory, and setup reuse the Case machinery unchanged.
// Actions: init | list | show | add | remove | setup.
//
// Records: archived ITEMS are plain `capture` records written INTO the bucket
// (writeRecord stamps meta.case=<bucket>; meta.persisted marks them so the
// active case's persist seam skips them) — the bucket's capture JSONL IS the
// manifest, deduped by payload.sha256 (no separate manifest file to drift).
// The ACTIVE case receives one operational `archive` summary per add
// ("archive" is in OPERATIONAL_VERBS, so summaries never pollute evidence).
// From any case, bucket contents are addressed as `archive:<bucket>/<item>`
// (media args) and `--index archive:<bucket>/<index>` (typed-verb queries).

import { existsSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { errRecord, isReady, makeRecord, type OvercastRecord } from "../record.js";
import {
  ARCHIVE_REF_PREFIX,
  archiveRoot,
  ensureBucket,
  listBucketItems,
  listBuckets,
  openBucket,
  sha256File,
  type BucketHandle,
  type BucketItem,
} from "../archive.js";
import { realpathContained } from "../fs-path.js";
import { addIndex, listIndexes, removeIndex, LOCAL_INDEX_TYPES } from "../state/index.js";
import { emptySetup, loadSetup, saveSetup, setupSummary, type CaseSetup } from "../state/setup.js";
import { resolveMemory } from "../providers/memory/index.js";
import { isArchivableMediaRecord, resolveMediaRef } from "./media-ref.js";
import { captureRef } from "./osint.js";
import { ensureLocalWatchRecord, indexVerb } from "./index.js";
import { listenVerb } from "./senses.js";
import { scanHitProvenance, stampProvenance } from "./provenance.js";
import {
  addVideoRoute,
  applySetupIndexing,
  cloneSetup,
  csv,
  folderMediaFiles,
  normalizeSetupMemory,
  parseIndexSpec,
  refreshSetupRouteIndexes,
  setupIndexRef,
} from "./setup-apply.js";
import type { VerbContext, VerbSpec } from "../registry/types.js";

const ACTIONS = ["init", "list", "show", "add", "remove", "setup"];
const err = (message: string): OvercastRecord => errRecord("archive", message);

/** Bucket memory defaults: like a case's but with `capture` (the manifest
 *  records, carrying tags/notes/origin) instead of `scan` (buckets don't scan). */
const ARCHIVE_MEMORY_SIGNALS = ["note", "watch", "listen", "see", "capture"];

/** Case-setup-only flags a bucket must reject (parseVerbArgs is loose — an
 *  undeclared flag lands in opts silently instead of erroring). */
const INVESTIGATION_FLAGS = [
  "target",
  "image-target",
  "face-ref",
  "remove-target",
  "source",
  "remove-source",
  "provider",
  "provider-indexable",
  "auto-sense",
  "findings",
  "findings-threshold",
];

function payloadOf(rec: OvercastRecord): Record<string, unknown> {
  return rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
}

function itemSummary(it: BucketItem): Record<string, unknown> {
  const p = payloadOf(it.record);
  return {
    id: it.record.id,
    capture_id: it.captureId,
    ref: it.path,
    sha256: it.sha256,
    bytes: typeof p.bytes === "number" ? p.bytes : undefined,
    tags: p.tags,
    note: p.note,
    origin: p.origin,
    added: it.record.meta?.time,
  };
}

/** Resolve an explicit bucket name, else the sole bucket (mirrors the index
 *  verb's sole-target rule: a PROVIDED-but-blank value is a user error). */
function resolveBucketArg(ctx: VerbContext, explicit: unknown, hint: string): { bucket?: BucketHandle; error?: string } {
  if (explicit !== undefined && explicit !== null) {
    const name = String(explicit).trim();
    if (!name) return { error: `a blank bucket name was given — pass a real bucket via ${hint}, or omit it to use the sole bucket` };
    return openBucket(name, ctx.home);
  }
  const all = listBuckets(ctx.home);
  if (all.length === 1) return { bucket: all[0] };
  if (all.length === 0) return { error: "no archive buckets yet — create one with `overcast archive init <bucket>`" };
  return { error: `multiple archive buckets; pick one via ${hint} (${all.map((b) => b.name).join(", ")})` };
}

/** Persist a record into the BUCKET's store and mark it so the active case's
 *  persist seam skips it (guard order: meta.persisted first, then meta.case).
 *  Idempotent on meta.persisted: a nested index/sense already writes some
 *  records bucket-side and stamps them persisted (ensureArchiveWatchRecord,
 *  similar's shot-watch) then returns them for display — re-writing here would
 *  duplicate the JSONL row and inflate ask/brief. Skip those; they're stored. */
function writeToBucket(bucket: BucketHandle, rec: OvercastRecord): OvercastRecord {
  if (rec.meta?.persisted === true) return rec;
  bucket.case.writeRecord(rec);
  rec.meta = { ...rec.meta, persisted: true };
  return rec;
}

interface ArchiveSetupChange {
  setup?: CaseSetup;
  operations?: string[];
  error?: string;
}

function archiveEmptySetup(bucket: BucketHandle): CaseSetup {
  const setup = emptySetup(bucket.case.exists() ? bucket.case.info().name : bucket.name);
  setup.memory.signals = [...ARCHIVE_MEMORY_SIGNALS];
  return setup;
}

/** The bucket subset of buildSetupChange: name, memory backend, indexes,
 *  routes, automation — no targets/sources/providers/findings. New/edited
 *  index sets BACKFILL every archived item as a route so the existing
 *  applySetupIndexing loop indexes the whole bucket. */
function buildArchiveSetupChange(ctx: VerbContext, bucket: BucketHandle, base: CaseSetup, apply: boolean): ArchiveSetupChange {
  for (const flag of INVESTIGATION_FLAGS) {
    if (ctx.opts[flag] != null) {
      return { error: `--${flag} does not apply to an archive bucket (buckets are reference stores, not investigations)` };
    }
  }
  if (ctx.opts.note != null) {
    return { error: "--note does not apply to archive setup — attach notes to items via `archive add <ref> --note ...`" };
  }
  const signals = csv(ctx.opts.signals);
  const memories = csv(ctx.opts.memory);
  const indexSignals = memories.length ? [] : signals;
  const indexes = csv(ctx.opts.index).map((s) => parseIndexSpec(s, indexSignals));
  const removeIndexes = csv(ctx.opts["remove-index"]);
  const videos = csv(ctx.opts.video);
  const folders = csv(ctx.opts.folder);
  const setup = cloneSetup(base);
  const operations: string[] = [];
  let indexRoutesChanged = false;

  if (ctx.opts.name) {
    setup.case_name = String(ctx.opts.name);
    operations.push(`bucket name: ${setup.case_name}`);
    if (apply) bucket.case.setName(setup.case_name);
  }
  if (memories.length) {
    const backend = normalizeSetupMemory(memories.at(-1)!)!;
    setup.memory = {
      ...setup.memory,
      backend,
      signals: signals.length ? signals : (setup.memory?.signals ?? ARCHIVE_MEMORY_SIGNALS),
    };
    operations.push(`memory backend: ${backend} (${setup.memory.signals.join(", ")})`);
  } else {
    setup.memory ??= { backend: "local-grep", signals: [...ARCHIVE_MEMORY_SIGNALS] };
  }
  for (const index of indexes) {
    const existing = setup.indexes.find((i) => (index.id && (i.id === index.id || i.name === index.name)) || (!index.id && i.name === index.name));
    const previousSignalKey = existing ? setupIndexRef(existing) : undefined;
    const current = existing ?? index;
    if (existing) {
      const priorId = existing.id;
      const priorMode = existing.mode;
      Object.assign(existing, index);
      if (!index.id && priorId) {
        existing.id = priorId;
        existing.mode = priorMode ?? "attach";
      }
    } else {
      setup.indexes.push(index);
    }
    const signalKey = setupIndexRef(current);
    if (previousSignalKey && previousSignalKey !== signalKey) delete setup.default_signals[previousSignalKey];
    setup.default_signals[signalKey] = current.default_signals;
    indexRoutesChanged = true;
    operations.push(`${current.mode === "attach" ? "index attach" : "index create planned"}: ${signalKey}`);
    // local-only types MUST carry backend "local" in the mirror — without it the
    // typed verbs (image/face/cluster) reject the entry as remote.
    if (apply && current.id) addIndex(bucket.case, { id: current.id, name: current.name, type: current.type, backend: LOCAL_INDEX_TYPES.has(String(current.type)) ? "local" : undefined });
  }
  if (removeIndexes.length) {
    const removedIndexes = setup.indexes.filter((i) => removeIndexes.includes(i.id ?? "") || removeIndexes.includes(i.name));
    setup.indexes = setup.indexes.filter((i) => !removeIndexes.includes(i.id ?? "") && !removeIndexes.includes(i.name));
    for (const index of removedIndexes) delete setup.default_signals[setupIndexRef(index)];
    indexRoutesChanged ||= removedIndexes.length > 0;
    for (const id of removeIndexes) {
      operations.push(`index remove: ${id}`);
      if (apply) {
        for (const existing of listIndexes(bucket.case).filter((i) => i.id === id || i.name === id)) removeIndex(bucket.case, existing.id);
      }
    }
  }
  // a face-cluster DB's ingest/identify records are searchable bucket evidence —
  // mirror the case-setup rule (never auto-removed; see case.ts).
  const hasFaceClusterDb =
    setup.indexes.some((i) => String(i.type) === "face-cluster") ||
    listIndexes(bucket.case).some((i) => i.type === "face-cluster");
  if (hasFaceClusterDb && setup.memory && !setup.memory.signals.includes("cluster")) {
    setup.memory.signals = [...setup.memory.signals, "cluster"];
    operations.push("memory signals: +cluster (face-cluster evidence searchable)");
  }
  // routes: explicit videos/folders + BACKFILL of every archived item once any
  // index is configured. Routes default to the "index add" signal (not "watch")
  // so local DB types (basic-clip/face-cluster) embed too — indexing the
  // existing media is the point of an archive index.
  const routeSignals = signals.length ? signals : ["index add"];
  for (const video of videos) {
    addVideoRoute(setup, video, routeSignals);
    operations.push(`video route: ${video}`);
  }
  for (const folder of folders) {
    if (!setup.media.folders.includes(folder)) setup.media.folders.push(folder);
    const files = folderMediaFiles(folder);
    for (const file of files) addVideoRoute(setup, file, routeSignals);
    operations.push(`folder select: ${folder}${files.length ? ` (${files.length} media files)` : " (no media files found)"}`);
  }
  if (setup.indexes.length) {
    let backfilled = 0;
    for (const item of listBucketItems(bucket)) {
      if (!item.path || !existsSync(item.path)) continue;
      if (!setup.media.videos.includes(item.path)) backfilled++;
      addVideoRoute(setup, item.path, routeSignals);
    }
    if (backfilled) operations.push(`backfill: ${backfilled} archived item(s) routed to indexes`);
  }
  if (indexRoutesChanged) refreshSetupRouteIndexes(setup);
  if (ctx.opts["auto-index-new"] != null || ctx.opts["no-auto-index-new"] != null) {
    setup.automation = {
      auto_sense: setup.automation?.auto_sense ?? [],
      auto_index_new: ctx.opts["no-auto-index-new"] === true
        ? false
        : ctx.opts["auto-index-new"] === true
          ? true
          : setup.automation?.auto_index_new === true,
    };
    operations.push(`automation: auto_index_new=${setup.automation.auto_index_new}`);
  } else {
    setup.automation ??= { auto_sense: [], auto_index_new: false };
  }
  if (!operations.length) operations.push("save empty setup");
  setup.updated_at = new Date().toISOString();
  return { setup, operations };
}

/** Route freshly added items through the bucket's configured indexes
 *  (automation.auto_index_new): a minimal one-shot setup clone whose routes are
 *  just the new refs, driven by the shared applySetupIndexing engine. */
async function autoIndexNewItems(ctx: VerbContext, bucket: BucketHandle, refs: string[]): Promise<{ records: OvercastRecord[]; operations: string[] }> {
  const setup = loadSetup(bucket.case);
  const operations: string[] = [];
  if (!setup?.automation?.auto_index_new || !setup.indexes.some((i) => i.id) || !refs.length) {
    return { records: [], operations };
  }
  const routing = cloneSetup(setup);
  routing.media = { folders: [], videos: [], routes: [] };
  for (const ref of refs) addVideoRoute(routing, ref, ["index add"]);
  const records = await applySetupIndexing({ ...ctx, case: bucket.case }, routing, operations);
  return { records, operations };
}

async function runSenses(ctx: VerbContext, bucket: BucketHandle, senses: string[], ref: string): Promise<OvercastRecord[]> {
  const out: OvercastRecord[] = [];
  const bucketCtx: VerbContext = { ...ctx, case: bucket.case, input: ref, rest: [], opts: {} };
  for (const sense of senses) {
    if (sense === "watch") {
      const rec = await ensureLocalWatchRecord(bucketCtx, ref);
      if (rec) out.push(writeToBucket(bucket, rec));
    } else if (sense === "listen") {
      for (const rec of await listenVerb.run(bucketCtx)) out.push(writeToBucket(bucket, rec));
    }
  }
  return out;
}

async function runAdd(ctx: VerbContext): Promise<OvercastRecord[]> {
  const to = resolveBucketArg(ctx, ctx.opts.to, "--to");
  if (!to.bucket) return [err(to.error!)];
  const bucket = to.bucket;
  const tags = csv(ctx.opts.tags);
  const note = ctx.opts.note != null ? String(ctx.opts.note) : undefined;
  const senses = csv(ctx.opts.sense);
  for (const s of senses) {
    if (!["watch", "listen"].includes(s)) return [err(`unknown --sense verb '${s}' (expected watch, listen)`)];
  }

  let sources = ctx.rest;
  if (ctx.opts.all === true) {
    const seen = new Set<string>();
    sources = [];
    for (const r of ctx.case.records()) {
      // archive stores images AND audio/video (unlike an AV-only index), so
      // --all sweeps still-image captures + `see` records too, not just AV
      if (!isArchivableMediaRecord(r) || !isReady(r) || !r.media?.ref) continue;
      if (seen.has(r.media.ref)) continue;
      seen.add(r.media.ref);
      sources.push(r.id);
    }
    if (!sources.length) return [err("archive add --all: no captured/sensed media records in this case")];
  }
  if (!sources.length) return [err("archive add requires media refs (paths / URLs / record ids), or --all")];

  const out: OvercastRecord[] = [];
  // includeRemoved: dedup must see the WHOLE sha history — a live match is
  // `already_archived`, a tombstoned match is a RESTORE (reuse the kept file,
  // never a second physical copy of the same bytes).
  const items = listBucketItems(bucket, { includeRemoved: true });
  const added: Array<Record<string, unknown>> = [];
  const alreadyArchived: Array<Record<string, unknown>> = [];
  let failed = 0;

  for (const raw of sources) {
    const resolved = resolveMediaRef(ctx.case, raw, ctx.home);
    if (resolved.error) {
      out.push(err(`archive add ${raw}: ${resolved.error}`));
      failed++;
      continue;
    }
    // an `archive:<bucket>/<item>` source resolves its record from the SOURCE
    // bucket — the active-case lookup would find nothing and drop the
    // origin.record / post-provenance trace of a cross-bucket copy
    const srcRec = resolved.record ?? (resolved.recordId ? ctx.case.recordById(resolved.recordId) : undefined);
    // never archive an in-flight/failed record's partial file (--all gates the
    // same way via isReady; explicit refs must not bypass it)
    if (srcRec && !isReady(srcRec)) {
      out.push(err(`archive add ${raw}: record ${srcRec.id} isn't ready (state=${srcRec.state ?? "?"}) — wait for the capture/sense to finish`));
      failed++;
      continue;
    }
    const ref = resolved.ref;
    const isUrl = /^https?:\/\//i.test(ref);
    if (!isUrl && !existsSync(ref)) {
      out.push(err(`archive add ${raw}: file not found: ${ref}`));
      failed++;
      continue;
    }

    const retiredMatch = (hash: string | undefined) =>
      items.find((it) => it.removed && it.sha256 === hash && !!it.path && existsSync(it.path));

    // local file → hash BEFORE copying so a duplicate never lands twice
    let sha: string | undefined;
    let restoredFrom: string | undefined;
    let cap: OvercastRecord | undefined;
    if (!isUrl) {
      try {
        sha = await sha256File(ref);
      } catch (e) {
        out.push(err(`archive add ${raw}: could not hash ${ref}: ${(e as Error).message}`));
        failed++;
        continue;
      }
      const dup = items.find((it) => !it.removed && it.sha256 === sha);
      if (dup) {
        alreadyArchived.push({ ref: raw, record: dup.record.id, sha256: sha });
        continue;
      }
      const retired = retiredMatch(sha);
      if (retired) {
        // same bytes were retired with --keep-file → restore: fresh manifest
        // record over the existing on-disk file, no copy
        restoredFrom = retired.record.id;
        cap = makeRecord({
          verb: "capture",
          format: "json",
          payload: { capture_id: "cap_" + basename(retired.path!), path: retired.path, kind: "file", source: "local", source_ref: ref },
          media: { ref: retired.path! },
          meta: { provider: "capture:local", case: bucket.dir },
          state: "ready",
        });
      }
    }

    cap ??= await captureRef({ ...ctx, case: bucket.case }, ref);
    let dest = cap.media?.ref;
    if (cap.state === "error" || cap.state === "needs_credentials" || !dest || !existsSync(dest)) {
      failed++;
      out.push(cap);
      continue;
    }
    if (!sha) {
      sha = await sha256File(dest);
      const dup = items.find((it) => !it.removed && it.sha256 === sha);
      if (dup) {
        // a URL re-download that matches an archived item — drop the fresh copy
        // (unless the download landed ON the original file)
        if (dup.path !== dest) rmSync(dest, { force: true });
        alreadyArchived.push({ ref: raw, record: dup.record.id, sha256: sha });
        continue;
      }
      const retired = retiredMatch(sha);
      if (retired) {
        // downloaded bytes match a retired item's kept file → adopt that file
        restoredFrom = retired.record.id;
        if (retired.path !== dest) rmSync(dest, { force: true });
        const p = payloadOf(cap);
        p.path = retired.path;
        p.capture_id = "cap_" + basename(retired.path!);
        cap.media = { ref: retired.path! };
        dest = retired.path!;
      }
    }

    const p = payloadOf(cap);
    p.sha256 = sha;
    if (restoredFrom) p.restored_from = restoredFrom;
    try {
      p.bytes = statSync(dest).size;
    } catch {
      /* keep record without size */
    }
    if (tags.length) p.tags = tags;
    if (note) p.note = note;
    const origin: Record<string, unknown> = {};
    if (ctx.case.dir !== bucket.dir) origin.case = ctx.case.dir;
    if (srcRec) {
      origin.record = srcRec.id;
      if (srcRec.meta?.time) origin.captured = srcRec.meta.time;
    }
    if (isUrl) origin.url = ref;
    else if (resolved.archive) origin.url = raw; // cross-bucket copy trace
    if (Object.keys(origin).length) p.origin = origin;
    stampProvenance(cap, scanHitProvenance(srcRec));
    writeToBucket(bucket, cap);
    items.push({ record: cap, captureId: typeof p.capture_id === "string" ? p.capture_id : undefined, path: dest, sha256: sha });
    added.push({ ref: raw, record: cap.id, capture_id: p.capture_id, path: dest, sha256: sha, ...(restoredFrom ? { restored_from: restoredFrom } : {}) });
    out.push(cap);

    if (senses.length) out.push(...await runSenses(ctx, bucket, senses, dest));
  }

  const autoIndexed = await autoIndexNewItems(ctx, bucket, added.map((a) => String(a.path)));
  for (const rec of autoIndexed.records) {
    if (rec.meta?.transient !== true) out.push(writeToBucket(bucket, rec));
  }

  out.push(makeRecord({
    verb: "archive",
    format: "json",
    payload: {
      op: "add",
      bucket: bucket.name,
      dir: bucket.dir,
      added,
      already_archived: alreadyArchived,
      failed,
      indexed: autoIndexed.operations,
    },
    state: failed && !added.length && !alreadyArchived.length ? "error" : "ready",
  }));
  return out;
}

async function runSetup(ctx: VerbContext): Promise<OvercastRecord[]> {
  const SUBS = new Set(["status", "show", "plan", "edit", "apply"]);
  const first = ctx.rest[0];
  const bucketArg = first !== undefined && !SUBS.has(first) ? first : undefined;
  const sub = (bucketArg !== undefined ? ctx.rest[1] : first) ?? "apply";
  if (!SUBS.has(sub)) {
    return [err("usage: archive setup <bucket> [status|show|plan|edit] [--name ... --index ... --memory ... --yes]")];
  }
  const opened = resolveBucketArg(ctx, bucketArg, "archive setup <bucket>");
  if (!opened.bucket) return [err(opened.error!)];
  const bucket = opened.bucket;
  const saved = loadSetup(bucket.case);

  if (sub === "status") {
    const items = listBucketItems(bucket);
    const indexes = listIndexes(bucket.case);
    const mirrored = new Set(indexes.map((i) => i.id));
    const memory: unknown[] = [];
    for (const p of resolveMemory(bucket.case, ctx.profile)) {
      try {
        memory.push(p.status ? await p.status() : { provider: p.id, backend: p.backend ?? p.id, state: "ready" });
      } catch (e) {
        memory.push({ provider: p.id, backend: p.backend ?? p.id, state: "error", error: (e as Error).message });
      }
    }
    return [makeRecord({
      verb: "archive",
      format: "json",
      payload: {
        op: "setup_status",
        bucket: bucket.name,
        dir: bucket.dir,
        setup: setupSummary(saved),
        items: items.length,
        indexes: indexes.map((i) => ({ id: i.id, type: i.type, backend: i.backend ?? "tinycloud", name: i.name, members: i.members.length, coverage: `${i.members.length}/${items.length}` })),
        memory,
        missing_indexes: (saved?.indexes ?? []).filter((i) => i.id && !mirrored.has(i.id)).map((i) => i.id),
        incomplete_indexes: (saved?.indexes ?? []).filter((i) => !i.id && i.mode !== "attach").map((i) => ({ name: i.name, type: i.type })),
      },
      meta: { transient: true },
      state: "ready",
    })];
  }
  if (sub === "show") {
    return [makeRecord({
      verb: "archive",
      format: "json",
      payload: saved ? { op: "setup_show", bucket: bucket.name, ...saved } : { op: "setup_show", bucket: bucket.name, completed: false, setup_file: bucket.case.setupFile },
      meta: { transient: true },
      state: saved ? "ready" : "pending",
    })];
  }

  const hasInputs = [
    "name",
    "memory",
    "signals",
    "index",
    "remove-index",
    "video",
    "folder",
    "auto-index-new",
    "no-auto-index-new",
  ].some((k) => ctx.opts[k] != null);
  if (!hasInputs && sub !== "plan" && ctx.opts.yes !== true) {
    const completed = saved?.completed ?? false;
    return [makeRecord({
      verb: "archive",
      format: "json",
      payload: {
        op: "setup_wizard",
        bucket: bucket.name,
        completed,
        status: completed ? "bucket setup complete" : "bucket has no index setup yet (media+metadata only — ask --archive still works via local-grep)",
        setup_file: bucket.case.setupFile,
        wizard_steps: [
          "1. Bucket purpose (--name)",
          "2. Indexes — local: deepface-local (face search) | basic-clip (semantic) | image-ransac (exact image) | audio-fp (audio fingerprint) | basic-clap (audio semantic) | voice-print (speaker verification) | face-cluster (people DB); remote Cloudglue: media-descriptions | face-analysis | entities — or skip (default: save media+metadata only)",
          "3. Memory backend for ask --archive: local-grep (default) | qmd (semantic)",
          "4. Automation: auto-index newly added media (--auto-index-new)",
          "5. Backfill: existing bucket media routes into new indexes automatically on apply",
          "6. Preview (archive setup plan ...) and apply (--yes)",
        ],
        next: [
          `overcast archive setup ${bucket.name} --index faces:deepface-local,clip:basic-clip --memory local-grep --auto-index-new --yes`,
          `overcast archive setup ${bucket.name} plan --index descriptions:media-descriptions`,
          `overcast archive setup ${bucket.name} status`,
        ],
        note: completed
          ? "bucket setup is complete; use archive setup status/show to inspect it or archive setup edit to change it"
          : "in the TUI, ask the user one wizard question at a time, or pass setup flags directly on the CLI",
      },
      meta: { transient: true },
      state: "pending",
    })];
  }

  const isPlan = sub === "plan" || ctx.opts["dry-run"] === true || ctx.opts.yes !== true;
  for (const memory of csv(ctx.opts.memory)) {
    if (!normalizeSetupMemory(memory)) return [err(`archive setup needs one local memory backend: local-grep or qmd (got '${memory}')`)];
  }
  const base = saved ?? archiveEmptySetup(bucket);
  const op = saved ? "archive_setup_update" : "archive_setup";
  const before = setupSummary(saved);
  const change = buildArchiveSetupChange(ctx, bucket, base, !isPlan);
  if (change.error || !change.setup || !change.operations) return [err(change.error ?? "archive setup failed")];
  if (!isPlan) {
    change.setup.completed = false;
    saveSetup(bucket.case, change.setup);
  }
  const workRecords = !isPlan && ctx.opts["no-index"] !== true
    ? await applySetupIndexing({ ...ctx, case: bucket.case }, change.setup, change.operations)
    : [];
  for (const rec of workRecords) {
    if (rec.meta?.transient !== true) writeToBucket(bucket, rec);
  }
  const incompleteIndexes = change.setup.indexes.filter((i) => !i.id && i.mode !== "attach");
  if (incompleteIndexes.length) change.setup.completed = false;
  else if (!isPlan) change.setup.completed = true;
  const setupRecord = makeRecord({
    verb: "archive",
    format: "json",
    payload: {
      op,
      bucket: bucket.name,
      dir: bucket.dir,
      saved: !isPlan,
      setup_file: bucket.case.setupFile,
      before,
      after: setupSummary(change.setup),
      applied_operations: isPlan ? [] : change.operations,
      planned_operations: change.operations,
      work_preview: {
        save_setup: !isPlan,
        routed_media: change.setup.media.videos.length,
        indexes: change.setup.indexes.map((index) => ({ name: index.name, type: index.type, mode: index.mode ?? (index.id ? "attach" : "create") })),
        will_start_indexing: !isPlan && ctx.opts["no-index"] !== true && change.setup.indexes.length > 0,
        automation: change.setup.automation ?? { auto_sense: [], auto_index_new: false },
      },
      incomplete_indexes: incompleteIndexes.map((index) => ({ name: index.name, type: index.type })),
      confirmation_required: isPlan && sub !== "plan" && ctx.opts["dry-run"] !== true,
      confirm_with: isPlan && sub !== "plan" && ctx.opts["dry-run"] !== true ? `overcast archive setup ${bucket.name} ... --yes` : undefined,
    },
    meta: isPlan ? { transient: true } : undefined,
    state: isPlan || incompleteIndexes.length ? "pending" : "ready",
  });
  if (!isPlan) {
    change.setup.last_update_record_id = setupRecord.id;
    saveSetup(bucket.case, change.setup);
    writeToBucket(bucket, setupRecord);
  }
  return [...workRecords, setupRecord];
}

export const archiveVerb: VerbSpec = {
  name: "archive",
  group: "state",
  summary: "Global cross-case media archive: save media into named buckets under ~/.overcast/archive (init/list/show/add/remove/setup).",
  description:
    "A bucket is a case-shaped folder reusable from ANY case: `init <bucket>` creates it; `add <ref...> --to <bucket>` " +
    "saves local files / URLs / case records into it (sha256-deduped capture records with tags/notes/origin provenance; " +
    "`--all` archives every captured/sensed media record of the active case); `list`/`show <bucket>` inspect; " +
    "`remove <item> --from <bucket>` retires an item. `setup <bucket>` is the index wizard (plan/--yes): stand up " +
    "local DBs (deepface-local/basic-clip/image-ransac/audio-fp/basic-clap/face-cluster) and/or remote Cloudglue " +
    "collections (media-descriptions/face-analysis/entities) plus a memory backend, backfilling existing bucket media. " +
    "From any case: sense media in place via `watch archive:<bucket>/<item>`, pull a copy via `capture archive:<bucket>/<item>`, " +
    "query bucket indexes via `--index archive:<bucket>/<index>` (face/similar/image/audio/voice/cluster/ask), " +
    "and ask over the bucket via `ask --archive <bucket>`.",
  args: [
    { name: "action", summary: ACTIONS.join(" | "), required: true, choices: ACTIONS },
    { name: "arg", summary: "bucket (init/show/setup) · media refs/record ids (add) · item + setup subcommand", required: false, variadic: true },
  ],
  flags: [
    { name: "to", summary: "add: target bucket (default: the sole bucket)", type: "string" },
    { name: "from", summary: "remove: bucket holding the item (default: the sole bucket)", type: "string" },
    { name: "all", summary: "add: archive every captured/sensed media record of the active case", type: "boolean" },
    { name: "tags", summary: "add: comma-separated tags stored on the archived item", type: "string" },
    { name: "note", summary: "add: note text stored on the archived item", type: "string" },
    { name: "sense", summary: "add: comma-separated senses to run in the bucket after adding (watch, listen)", type: "string" },
    { name: "keep-file", summary: "remove: keep the media file (retire the record only)", type: "boolean" },
    { name: "limit", summary: "show: max items listed", type: "number" },
    { name: "name", summary: "init/setup: bucket display name / purpose", type: "string" },
    { name: "index", summary: "setup: comma-separated indexes to stand up (name:type or id:type:name)", type: "string" },
    { name: "remove-index", summary: "setup: comma-separated index ids/names to remove", type: "string" },
    { name: "signals", summary: "setup: comma-separated signals for new indexes/routes", type: "string" },
    { name: "memory", summary: "setup: local memory backend for ask --archive (local-grep | qmd)", type: "string" },
    { name: "video", summary: "setup: comma-separated extra videos/URLs to route into indexes", type: "string" },
    { name: "folder", summary: "setup: comma-separated local media folders to route into indexes", type: "string" },
    { name: "auto-index-new", summary: "setup: automatically index newly added media", type: "boolean" },
    { name: "no-auto-index-new", summary: "setup: disable automatic indexing of new adds", type: "boolean" },
    { name: "no-index", summary: "setup: save setup without starting index ingestion", type: "boolean" },
    { name: "dry-run", summary: "setup: preview without saving or applying", type: "boolean" },
    { name: "yes", summary: "setup: non-interactive apply", type: "boolean" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "archive",
  providerKey: "archive",
  run: async (ctx) => {
    const action = ctx.input;

    if (action === "init") {
      const name = ctx.rest[0];
      if (!name) return [err("archive init requires a bucket name")];
      const ensured = ensureBucket(name, ctx.home);
      if (!ensured.bucket) return [err(ensured.error!)];
      const bucket = ensured.bucket;
      if (ctx.opts.name) bucket.case.setName(String(ctx.opts.name));
      const rec = makeRecord({
        verb: "archive",
        format: "json",
        payload: {
          op: "init",
          bucket: bucket.name,
          dir: bucket.dir,
          created: ensured.created === true,
          name: bucket.case.info().name,
        },
        state: "ready",
      });
      return [writeToBucket(bucket, rec)];
    }

    if (action === "list") {
      const buckets = listBuckets(ctx.home).map((b) => {
        const setup = loadSetup(b.case);
        return {
          name: b.name,
          dir: b.dir,
          items: listBucketItems(b).length,
          indexes: listIndexes(b.case).map((i) => ({ id: i.id, type: i.type, backend: i.backend ?? "tinycloud", members: i.members.length })),
          memory_backend: setup?.memory.backend ?? "local-grep",
          setup_completed: setup?.completed ?? false,
        };
      });
      return [makeRecord({
        verb: "archive",
        format: "json",
        payload: { op: "list", root: archiveRoot(ctx.home), count: buckets.length, buckets },
        meta: { transient: true },
        state: "ready",
      })];
    }

    if (action === "show") {
      const opened = resolveBucketArg(ctx, ctx.rest[0], "archive show <bucket>");
      if (!opened.bucket) return [err(opened.error!)];
      const bucket = opened.bucket;
      const limit = typeof ctx.opts.limit === "number" && ctx.opts.limit > 0 ? ctx.opts.limit : 50;
      const items = listBucketItems(bucket).sort((a, b) => String(b.record.meta?.time ?? "").localeCompare(String(a.record.meta?.time ?? "")));
      return [makeRecord({
        verb: "archive",
        format: "json",
        payload: {
          op: "show",
          bucket: bucket.name,
          dir: bucket.dir,
          name: bucket.case.exists() ? bucket.case.info().name : bucket.name,
          total_items: items.length,
          items: items.slice(0, limit).map(itemSummary),
          indexes: listIndexes(bucket.case).map((i) => ({ id: i.id, type: i.type, backend: i.backend ?? "tinycloud", name: i.name, members: i.members.length })),
          setup: setupSummary(loadSetup(bucket.case)),
        },
        meta: { transient: true },
        state: "ready",
      })];
    }

    if (action === "add") return runAdd(ctx);

    if (action === "remove") {
      const from = resolveBucketArg(ctx, ctx.opts.from, "--from");
      if (!from.bucket) return [err(from.error!)];
      const bucket = from.bucket;
      const itemArg = ctx.rest[0];
      if (!itemArg) return [err("archive remove requires an item (record id, capture id, media filename, or sha256 prefix)")];
      const items = listBucketItems(bucket);
      // A pre-restore record/capture id addresses a TOMBSTONED item whose bytes
      // were re-added (restore) — that old id is dead in the live manifest, but
      // `resolveMediaRef(archive:<bucket>/<id>)` maps it to the live successor's
      // path via the same liveForPath logic `watch archive:…` uses. Resolve
      // through the archive: ref first so removing by a stale id still finds the
      // live item; then fall back to direct id/basename/sha matching (covers the
      // sha256 prefix and plain literals resolveMediaRef doesn't address).
      const viaRef = resolveMediaRef(ctx.case, `${ARCHIVE_REF_PREFIX}${bucket.name}/${itemArg}`, ctx.home);
      const resolvedPath = !viaRef.error && viaRef.archive === bucket.name ? viaRef.ref : undefined;
      const matches = items.filter((it) =>
        it.record.id === itemArg ||
        it.captureId === itemArg ||
        (it.path && basename(it.path) === itemArg) ||
        (!!it.sha256 && itemArg.length >= 8 && it.sha256.startsWith(itemArg.toLowerCase())) ||
        (!!resolvedPath && !!it.path && it.path === resolvedPath),
      );
      if (!matches.length) return [err(`no archived item matches '${itemArg}' in bucket '${bucket.name}'`)];
      if (matches.length > 1) return [err(`'${itemArg}' matches ${matches.length} archived items; use the record id (${matches.map((m) => m.record.id).join(", ")})`)];
      const item = matches[0];
      // un-index the item from every bucket index BEFORE tombstoning (the
      // tombstone would make its path unresolvable to the removal flow itself).
      // Reuses `index remove`'s type-specific cleanup — mirror member, cached
      // embeddings/fingerprints, remote removal. face-cluster is skipped: it
      // stores derived face assignments, not member refs (index remove rejects
      // it by design; recluster to rebuild).
      const unindexed: string[] = [];
      const indexRecords: OvercastRecord[] = [];
      if (item.path) {
        for (const entry of listIndexes(bucket.case)) {
          if (entry.type === "face-cluster") continue;
          if (!entry.members.some((m) => m.ref === item.path)) continue;
          const recs = await indexVerb.run({ ...ctx, case: bucket.case, input: "remove", rest: [item.path], opts: { from: entry.id } });
          for (const rec of recs) {
            if (rec.meta?.transient !== true) indexRecords.push(writeToBucket(bucket, rec));
          }
          unindexed.push(entry.id);
        }
      }
      let fileRemoved = false;
      if (ctx.opts["keep-file"] !== true && item.path && existsSync(item.path) && realpathContained(bucket.dir, item.path)) {
        rmSync(item.path, { force: true });
        fileRemoved = true;
      }
      const tomb = makeRecord({
        verb: "archive",
        format: "json",
        payload: {
          op: "remove",
          bucket: bucket.name,
          item: item.record.id,
          capture_id: item.captureId,
          ref: item.path,
          sha256: item.sha256,
          file_removed: fileRemoved,
          ...(unindexed.length ? { unindexed } : {}),
        },
        state: "ready",
      });
      return [...indexRecords, writeToBucket(bucket, tomb)];
    }

    if (action === "setup") return runSetup(ctx);

    return [err(`unknown archive action '${action}' (expected ${ACTIONS.join(" | ")})`)];
  },
};
