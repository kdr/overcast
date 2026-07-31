// `index` verb (OSINT): manage the lifecycle of tinycloud indexes — the
// remote (Cloudglue) indexes that make a target's videos searchable. One verb
// fans out to tinycloud's collection ops and keeps a local mirror
// (state/index.ts) of which indexes + members this case owns.
//
//   index create <name> --type media|entities|face [--prompt|--schema]
//   index add <video|record-id> --to <id>     (or --all to register the case's videos)
//   index list | attach <remote-id-or-name> | show <id> | delete <id> | remove <video> --from <id>
//   index entities <id> <video>               (entities indexes)
//
// Read the indexed videos with: `ask --index <id>` (media-descriptions),
// `face --match … --index <id>` (face-analysis), `index entities …`.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { makeRecord, errRecord, isReady, type OvercastRecord } from "../record.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import {
  tcCollectionCreate,
  tcCollectionAdd,
  tcCollectionShow,
  tcCollectionList,
  tcCollectionDelete,
  tcCollectionRemove,
  tcCollectionEntities,
  fileStatus,
} from "../providers/tinycloud/collection.js";
import {
  listIndexes,
  findIndex,
  resolveIndexRef,
  addIndex,
  removeIndex,
  addMember,
  removeMember,
  normalizeIndexType,
  setMembers,
  LOCAL_INDEX_TYPES,
} from "../state/index.js";
import { providerEnv } from "../providers/provider-env.js";
import { loadSetup, saveSetup } from "../state/setup.js";
import {
  localIndexDir,
  writeClipConfig,
  defaultClipConfig,
  removeClipEmbedding,
  type ClipConfig,
} from "../providers/local/vision.js";
import {
  writeAudioFpConfig,
  defaultAudioFpConfig,
  writeClapConfig,
  defaultClapConfig,
  writeVoicePrintConfig,
  defaultVoicePrintConfig,
  removeAudioFingerprint,
  type VoicePrintConfig,
} from "../providers/local/audio.js";
import { resolveVideoArg, resolveImageArg, resolveVisualArg, isRegisterableMediaRecord, isImage } from "./media-ref.js";
import { openBucket, resolveIndexScope, stampArchive } from "../archive.js";
import { badNumber, numFlag } from "./validate.js";
import { tinycloudBaseFromRun } from "../providers/tinycloud/envelope.js";
import type { Case } from "../case.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const VALID_ACTIONS = ["create", "attach", "add", "list", "show", "delete", "remove", "entities"];
const LOCAL_VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|m2ts|mts|ts|wmv|flv|3gp|3g2|ogv|mxf)$/i;
const LOCAL_IMAGE_MEDIA_VERBS = new Set(["capture", "image", "face"]);

const err = (message: string): OvercastRecord => errRecord("index", message);

function isLocalIndex(entry: { backend?: string; type: string }): boolean {
  return entry.backend === "local";
}

/** Build a validated basic-clip ClipConfig from create flags, merged over the
 *  given defaults (basic-clap reuses this with its own base). Returns an error
 *  string for a bad enum/number value. */
function clipConfigFromOpts(opts: Record<string, unknown>, base: ClipConfig = defaultClipConfig()): { config?: ClipConfig; error?: string } {
  const cfg = base;
  const enumFlag = <T extends string>(name: string, allowed: readonly T[]): T | undefined | string => {
    const v = opts[name];
    if (v == null) return undefined;
    const s = String(v);
    return (allowed as readonly string[]).includes(s) ? (s as T) : `--${name} must be one of: ${allowed.join(", ")} (got '${s}')`;
  };
  const pooling = enumFlag("pooling", ["max", "mean"] as const);
  if (typeof pooling === "string" && pooling.startsWith("--")) return { error: pooling };
  const granularity = enumFlag("granularity", ["video", "frame"] as const);
  if (typeof granularity === "string" && granularity.startsWith("--")) return { error: granularity };
  const sampling = enumFlag("sampling", ["uniform", "shots"] as const);
  if (typeof sampling === "string" && sampling.startsWith("--")) return { error: sampling };
  if (pooling) cfg.pooling = pooling as ClipConfig["pooling"];
  if (granularity) cfg.granularity = granularity as ClipConfig["granularity"];
  if (sampling) cfg.sampling = sampling as ClipConfig["sampling"];
  for (const [name, key] of [["window", "window"], ["max-frames", "maxFrames"], ["fps", "fps"]] as const) {
    const v = opts[name];
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return { error: `--${name} expects a positive number (got '${String(v)}')` };
    cfg[key] = n;
  }
  return { config: cfg };
}

/** Build a validated basic-clap ClipConfig from create flags. Audio has no
 *  frame/shot sampling, so reject those flags rather than silently ignoring. */
function clapConfigFromOpts(opts: Record<string, unknown>): { config?: ClipConfig; error?: string } {
  for (const f of ["sampling", "fps", "max-frames"] as const) {
    if (opts[f] != null) return { error: `--${f} doesn't apply to a basic-clap index — audio is embedded in --window second chunks` };
  }
  return clipConfigFromOpts(opts, defaultClapConfig());
}

/** Build a validated voice-print config from create flags. Speaker embedding
 *  has no frame/pooling machinery — only --window (seconds per voice window)
 *  applies; the model is pinned from OVERCAST_VOICE_MODEL at create time so a
 *  later env change can't silently mix embedding spaces. */
function voiceConfigFromOpts(opts: Record<string, unknown>): { config?: VoicePrintConfig; error?: string } {
  for (const f of ["pooling", "granularity", "sampling", "fps", "max-frames"] as const) {
    if (opts[f] != null) return { error: `--${f} doesn't apply to a voice-print index — speech is embedded in fixed --window second voice windows` };
  }
  const cfg = defaultVoicePrintConfig();
  if (opts.window != null) {
    const n = Number(opts.window);
    if (!Number.isFinite(n) || n <= 0) return { error: `--window expects a positive number (got '${String(opts.window)}')` };
    cfg.window = n;
  }
  return { config: cfg };
}

function indexRecord(rec: OvercastRecord): OvercastRecord {
  rec.verb = "index";
  if (rec.payload && typeof rec.payload === "object") {
    const p = rec.payload as Record<string, unknown>;
    if ("collection" in p && !("index" in p)) {
      p.index = p.collection;
      delete p.collection;
    }
    if ("collections" in p && !("indexes" in p)) {
      p.indexes = p.collections;
      delete p.collections;
    }
    if (typeof p.summary === "string") {
      p.summary = p.summary.replace(/\bcollections\b/g, "indexes").replace(/\bcollection\b/g, "index");
    }
    if (typeof p.provider_summary === "string") {
      p.provider_summary = p.provider_summary.replace(/\bcollections\b/g, "indexes").replace(/\bcollection\b/g, "index");
    }
  }
  return rec;
}

/** A non-failure outcome: the op was accepted (an async add lands as `pending`
 *  while it ingests, but the membership intent is real). */
const accepted = (rec: OvercastRecord) => rec.state === "ready" || rec.state === "pending";

// ---- add --all batching (backpressure) --------------------------------------
// Firing hundreds of `collections add` calls back-to-back collapses server-side
// (observed in the field: 401 files in one pass → 236 failed; the same corpus
// re-added in waited waves of 10–20 recovered 100%). `add --all` therefore
// submits in WAVES and pauses between them until the previous wave stops
// processing (or a bounded wait elapses). `--batch 0` restores the single pass.

const DEFAULT_ADD_BATCH = 12;

/** Split items into submission waves; size <= 0 or Infinity = one wave. */
export function chunkBatches<T>(items: T[], size: number): T[][] {
  if (!Number.isFinite(size) || size <= 0 || items.length === 0) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** File ids a collection-show entry may carry (tinycloud 0.3.x variants). */
function showEntryIds(f: unknown): string[] {
  if (!f || typeof f !== "object") return [];
  const o = f as Record<string, unknown>;
  return [o.file_id, o.fileId, o.cloudglue_file_id, o.id].filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Backpressure signals from one collection-show page: how many of THIS wave's
 *  files are still processing (when observable — the provider lists at most ~50
 *  files, so a wave can be entirely invisible), how many listed files are
 *  processing overall (a congestion proxy), and how many wave files we saw. */
export function batchBackpressure(
  files: unknown[],
  waveIds: Set<string>,
): { waveProcessing: number; waveObserved: number; processing: number } {
  let waveProcessing = 0;
  let waveObserved = 0;
  let processing = 0;
  for (const f of files) {
    const status = fileStatus(f);
    if (status === "processing") processing++;
    if (showEntryIds(f).some((id) => waveIds.has(id))) {
      waveObserved++;
      if (status === "processing") waveProcessing++;
    }
  }
  return { waveProcessing, waveObserved, processing };
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || !raw.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Pause between `add --all` waves until the previous wave settles: always at
 *  least one poll interval of pacing, then keep waiting while the wave's files
 *  (when observable in the show listing) or the listing at large are still
 *  processing — bounded by OVERCAST_INDEX_BATCH_WAIT_S (default 300). Show
 *  errors degrade to the single pacing delay rather than failing the add. */
async function waitForWaveSettled(
  collectionId: string,
  waveIds: Set<string>,
  waveSize: number,
  tcOpts: Parameters<typeof tcCollectionShow>[1],
  signal?: AbortSignal,
): Promise<number> {
  const pollMs = envNum("OVERCAST_INDEX_BATCH_POLL_MS", 10_000);
  const deadline = Date.now() + envNum("OVERCAST_INDEX_BATCH_WAIT_S", 300) * 1000;
  let polls = 0;
  for (;;) {
    if (signal?.aborted) return polls;
    await sleep(pollMs, signal);
    polls++;
    if (signal?.aborted || Date.now() >= deadline) return polls;
    const shown = await tcCollectionShow(collectionId, tcOpts).catch(() => undefined);
    const payload = shown?.rec.payload as Record<string, unknown> | undefined;
    const files = shown?.rec.state === "ready" && Array.isArray(payload?.files) ? (payload.files as unknown[]) : undefined;
    if (!files) return polls; // can't observe — the single pacing delay is the backpressure
    const bp = batchBackpressure(files, waveIds);
    const settled = bp.waveObserved > 0 ? bp.waveProcessing === 0 : bp.processing < waveSize;
    if (settled) return polls;
  }
}

/** show/delete take a POSITIONAL id; an `add`/`remove` target flag (--to/--from)
 *  with no positional is a misuse that must NOT fall through to the sole
 *  index (dangerous for delete). Returns the stray flag name, else undefined. */
function strayTargetFlag(ctx: VerbContext): string | undefined {
  if (ctx.rest[0]) return undefined;
  if (ctx.opts.to != null) return "--to";
  if (ctx.opts.from != null) return "--from";
  return undefined;
}

/** Unique AV media refs the case has captured or sensed (the media gathered while
 *  investigating the target) — what `index add --all` registers: `capture`
 *  (fetched media) plus anything sensed via `watch`/`listen`/`face`. Deliberately
 *  excludes `scan` hits: their media.ref is a page/listing URL (and isAv accepts
 *  any http(s)), so they'd pollute the index with non-video links — the
 *  actual media arrives via `capture` (scan --pull → capture record). */
function caseVideoRefs(c: Case): Array<{ ref: string; recordId: string }> {
  const out: Array<{ ref: string; recordId: string }> = [];
  const seen = new Set<string>();
  for (const r of c.records()) {
    // shared predicate (registerable verb + AV ref + not a face-search query image)
    // so --all's register list and its pending/failed accounting use one rule; here
    // we add the readiness gate (a failed/cred-gapped sense's ref would pollute).
    if (!isRegisterableMediaRecord(r) || !isReady(r)) continue;
    const ref = r.media!.ref!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, recordId: r.id });
  }
  return out;
}

/** Unique READY still-image refs the case can use as local visual references.
 *  Unlike video `--all`, local image/deepface indexes register reference images;
 *  reject operational query images (face search) and non-ready records so an
 *  in-flight/failed analysis cannot silently become database material. */
function caseImageRefs(c: Case): Array<{ ref: string; recordId: string }> {
  const out: Array<{ ref: string; recordId: string }> = [];
  const seen = new Set<string>();
  for (const r of c.records()) {
    const ref = r.media?.ref;
    if (!ref || !isReady(r) || !isImage(ref)) continue;
    if (!LOCAL_IMAGE_MEDIA_VERBS.has(r.verb)) continue;
    if (r.verb === "face" && (r.payload as Record<string, unknown> | undefined)?.op === "search") continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, recordId: r.id });
  }
  return out;
}

function hasWatchRecord(c: Case, ref: string): boolean {
  return c.records().some((r) => {
    if (r.verb !== "watch" || r.media?.ref !== ref) return false;
    const state = String(r.state ?? "ready");
    return state !== "error" && state !== "needs_credentials";
  });
}

export async function ensureLocalWatchRecord(ctx: VerbContext, ref: string): Promise<OvercastRecord | undefined> {
  if (
    ctx.opts["__skip-local-watch"] === true ||
    /^https?:\/\//i.test(ref) ||
    !LOCAL_VIDEO_RE.test(ref) ||
    !existsSync(ref) ||
    hasWatchRecord(ctx.case, ref)
  ) return undefined;
  const binding = providerBinding(ctx, "watch");
  const rec = isCustomBinding(binding)
    ? await runBoundProvider("watch", binding!, ref, { home: ctx.home,
        env: providerEnv(ctx.case.mediaDir),
        timeoutMs: 15 * 60_000,
        signal: ctx.signal,
      })
    : await runWatch(ref, { run: binding?.run, signal: ctx.signal });
  rec.meta = { ...rec.meta, case: ctx.case.dir, triggered_by: "index add" };
  return rec;
}

/** ensure-watch for a video resolved from an ARCHIVE ref: the media lives in
 *  the bucket, so the watch evidence (dedup lookup + the record itself) belongs
 *  to the BUCKET's store, not the active case — otherwise every case that
 *  indexes the same archived clip re-pays the watch, and the record would be
 *  dropped by the active case's persist seam anyway (other-case guard). Written
 *  bucket-side directly; still returned so the caller can display it. */
async function ensureArchiveWatchRecord(ctx: VerbContext, bucketName: string, ref: string): Promise<OvercastRecord | undefined> {
  const { bucket } = openBucket(bucketName, ctx.home);
  if (!bucket) return undefined;
  const rec = await ensureLocalWatchRecord({ ...ctx, case: bucket.case }, ref);
  if (rec) {
    bucket.case.writeRecord(rec);
    rec.meta = { ...rec.meta, persisted: true };
  }
  return rec;
}

/** Resolve the target index id for add/show/delete: an explicit value, else
 *  the case's sole mirrored index (optionally filtered by type). A value that
 *  was PROVIDED but is blank/whitespace is a user error (like ask/face reject blank
 *  --index) — only a truly OMITTED value falls back to the sole index, so
 *  an empty-looking flag can't silently target (and delete) the wrong one. */
function resolveTarget(c: Case, explicit?: string, type?: string): { id?: string; error?: string } {
  if (explicit !== undefined) {
    const ex = explicit.trim();
    if (!ex) return { error: "a blank index id/name was given — pass a real id/name, or omit it to use the case's sole index" };
    const ref = resolveIndexRef(c, ex); // errors on an ambiguous display name
    if (ref.error) return { error: ref.error };
    return { id: ref.entry?.id ?? ex };
  }
  let cols = listIndexes(c);
  // keep `unknown` stubs in a type-filtered fallback — `add` upgrades a stub's type
  // once a target resolves, so a sole unknown stub must still match `--type face`.
  if (type) cols = cols.filter((x) => x.type === type || x.type === "unknown");
  if (cols.length === 1) return { id: cols[0].id };
  if (cols.length === 0) return { error: "no indexes in this case — create one with `overcast index create <name> --type <media|entities|face|deepface-local|image-ransac|face-cluster|basic-clip>`" };
  return { error: `multiple indexes; specify one (ids: ${cols.map((x) => x.id).join(", ")})` };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function remoteIndexId(o: Record<string, unknown>): string | undefined {
  const nested = obj(o.collection);
  return nonEmpty(o.id) ?? nonEmpty(o.collection_id) ?? nonEmpty(o.collectionId) ?? nonEmpty(nested.id);
}

function remoteIndexName(o: Record<string, unknown>): string | undefined {
  const nested = obj(o.collection);
  return nonEmpty(o.name) ?? nonEmpty(o.display_name) ?? nonEmpty(o.title) ?? nonEmpty(nested.name);
}

function remoteIndexType(o: Record<string, unknown>): string | undefined {
  const nested = obj(o.collection);
  const raw =
    nonEmpty(o.type) ??
    nonEmpty(o.collection_type) ??
    nonEmpty(o.collectionType) ??
    nonEmpty(nested.type) ??
    nonEmpty(nested.collection_type);
  return raw ? (normalizeIndexType(raw) ?? raw) : undefined;
}

function remoteListItems(rec: OvercastRecord): Record<string, unknown>[] {
  const p = obj(rec.payload);
  const d = obj(p.detailed);
  const vals = Array.isArray(p.indexes)
    ? p.indexes
    : Array.isArray(p.collections)
      ? p.collections
      : Array.isArray(d.collections)
        ? d.collections
        : Array.isArray(d.items)
          ? d.items
          : [];
  return vals.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function remoteFiles(rec: OvercastRecord): Record<string, unknown>[] {
  const p = obj(rec.payload);
  const d = obj(p.detailed);
  const vals = Array.isArray(p.files)
    ? p.files
    : Array.isArray(d.files)
      ? d.files
      : Array.isArray(obj(d.collection).files)
        ? obj(d.collection).files as unknown[]
        : [];
  return vals.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function remoteFileRef(f: Record<string, unknown>): string | undefined {
  return (
    nonEmpty(f.ref) ??
    nonEmpty(f.file) ??
    nonEmpty(f.filename) ??
    nonEmpty(f.name) ??
    nonEmpty(f.path) ??
    nonEmpty(f.url) ??
    nonEmpty(f.file_id) ??
    nonEmpty(f.fileId) ??
    nonEmpty(f.id)
  );
}

export const indexVerb: VerbSpec = {
  name: "index",
  group: "osint",
  summary: "Manage tinycloud indexes that index a target's videos (create/attach/add/list/show/delete/remove/entities).",
  description:
    "An index is a Cloudglue-backed searchable corpus of videos, searched one way per TYPE: media-descriptions " +
    "(ask/probe), entities (same-schema extraction), face-analysis (detect + find a person). " +
    "`create <name> --type <media|entities|face>` (entities needs --prompt/--schema); `attach <remote-id-or-name>` " +
    "mirrors an existing remote index into this case; `add <video> --to <id>` " +
    "registers a video (a path, URL, or a case record id) — `--all` registers every video the case has " +
    "captured or sensed (watch/listen/face) for the target; `list`/`show <id>` inspect; `delete <id>`/`remove <video> --from <id>` " +
    "prune; `entities <id> <video>` fetches a video's extracted entities. Then read with `ask --index " +
    "<id>`, `face --match … --index <id>`, or `index entities`. Backed by tinycloud (≥ 0.3.4).",
  args: [
    { name: "action", summary: VALID_ACTIONS.join(" | "), required: true, choices: VALID_ACTIONS },
    { name: "arg", summary: "name (create) · remote id/name (attach) · video/record-id (add/remove) · index id (show/delete/entities)", required: false },
    // `entities <id> <video>` needs a SECOND positional — declared so the pi
    // AgentTool surface (which rebuilds positionals strictly from spec.args) can
    // supply it, not just the raw CLI/slash parsers. Mirrors setup's action/a/b.
    { name: "arg2", summary: "entities: the video/record-id (index entities <id> <video>)", required: false },
  ],
  flags: [
    { name: "type", summary: "create/attach: media-descriptions | entities | face-analysis | rich-transcripts | deepface-local | image-ransac | face-cluster | basic-clip | audio-fp | basic-clap | voice-print", type: "string" },
    { name: "local", summary: "create a local index instead of a tinycloud-backed index", type: "boolean" },
    { name: "description", summary: "create: human description", type: "string" },
    { name: "prompt", summary: "create entities: free-text extraction prompt", type: "string" },
    { name: "schema", summary: "create entities: path to a JSON schema file", type: "string" },
    { name: "to", summary: "add: target index id/name", type: "string" },
    { name: "from", summary: "remove: index id/name to remove the video from", type: "string" },
    { name: "all", summary: "add: register every video the case has captured or sensed (watch/listen/face)", type: "boolean" },
    { name: "force", summary: "add: re-submit to the remote index even when the local mirror already lists the video as a member (reconciles a stale membership cache after server-side deletes/failures)", type: "boolean" },
    { name: "batch", summary: "add --all: submission wave size — pauses between waves until the previous wave stops processing (default 12; 0 = single unpaced pass)", type: "number" },
    { name: "remote", summary: "list: also query tinycloud for all account indexes", type: "boolean" },
    { name: "no-upload", summary: "add: don't upload (use an already-uploaded source)", type: "boolean" },
    { name: "no-download", summary: "add: don't materialize the source locally", type: "boolean" },
    { name: "limit", summary: "entities: max entities", type: "number" },
    { name: "offset", summary: "entities: entity offset", type: "number" },
    { name: "pooling", summary: "create basic-clip/basic-clap: pool video frames / audio windows by max | mean", type: "string", choices: ["max", "mean"] },
    { name: "granularity", summary: "create basic-clip/basic-clap: video (one vector/file) | frame (moment-level / audio windows)", type: "string", choices: ["video", "frame"] },
    { name: "sampling", summary: "create basic-clip: uniform | shots (watch boundaries)", type: "string", choices: ["uniform", "shots"] },
    { name: "window", summary: "create basic-clip/basic-clap: seconds per uniform sampling window / audio chunk", type: "number" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "index",
  providerKey: "index",
  run: async (ctx) => {
    const c = ctx.case;
    const action = ctx.input;
    const env = providerEnv(c.mediaDir);
    // honor a pinned tinycloud in the profile (`setup provider index
    // "/path/to/tinycloud …"`) the same way `face` honors its binding — else
    // OVERCAST_TINYCLOUD_CMD / `tinycloud` on PATH (via tinycloudBase).
    const base = tinycloudBaseFromRun(ctx.profile.providers?.index?.run ?? ctx.profile.providers?.collection?.run);
    const tcOpts = { env, signal: ctx.signal, base };

    if (action && !VALID_ACTIONS.includes(action)) {
      return [err(`unknown index action '${action}' (expected ${VALID_ACTIONS.join(" | ")})`)];
    }

    // ---- create ----
    if (action === "create") {
      const name = ctx.rest[0]?.trim();
      if (!name) return [err("usage: index create <name> --type <media-descriptions|entities|face-analysis>")];
      // `!= null` so a provided-but-empty `--type=` flows to normalizeIndexType
      // (→ unknown-type error) instead of silently defaulting like an omitted flag.
      const rawType = ctx.opts.type != null ? String(ctx.opts.type) : "media-descriptions";
      const type = normalizeIndexType(rawType);
      if (!type) {
        return [err(`unknown --type '${rawType}' (expected media-descriptions | entities | face-analysis | rich-transcripts | deepface-local | image-ransac | face-cluster | basic-clip | audio-fp | basic-clap | voice-print)`)];
      }
      const local = ctx.opts.local === true || LOCAL_INDEX_TYPES.has(type);
      if (ctx.opts.local === true && !LOCAL_INDEX_TYPES.has(type)) {
        // derived from LOCAL_INDEX_TYPES so the message can't drift when a new
        // local type lands (it already did twice: face-cluster, basic-clip).
        return [err(`--local only supports ${[...LOCAL_INDEX_TYPES].join(" | ")} indexes (got ${type})`)];
      }
      // reject a provided-but-blank text/path flag (a typo) — sweep all of create's
      // value flags together, so a blank `--schema=`/`--prompt=`/`--description=`
      // gives a clear error instead of falling through (the generic "needs prompt
      // or schema", or a silently-dropped description).
      for (const f of ["prompt", "schema", "description"] as const) {
        if (ctx.opts[f] != null && !String(ctx.opts[f]).trim()) {
          return [err(`--${f} requires a ${f === "schema" ? "path to a JSON schema file" : "value"}`)];
        }
      }
      const prompt = ctx.opts.prompt != null ? String(ctx.opts.prompt) : undefined;
      const schema = ctx.opts.schema != null ? String(ctx.opts.schema) : undefined;
      const description = ctx.opts.description != null ? String(ctx.opts.description) : undefined;
      if (type === "entities" && !prompt && !schema) {
        return [err("an entities index needs --prompt <text> or --schema <file> (the schema to extract from every video)")];
      }
      if (schema && !existsSync(schema)) return [err(`--schema file not found: ${schema}`)];
      if (local) {
        // basic-clip / basic-clap carry a per-index config (pooling/granularity/
        // window; +sampling for CLIP); persist it to config.json so `similar` + the
        // wizard agree. audio-fp persists its fingerprint params (fixed in v1) so
        // the member cache's config_hash is stable.
        let clipConfig: ClipConfig | undefined;
        let voiceConfig: VoicePrintConfig | undefined;
        if (type === "basic-clip") {
          const built = clipConfigFromOpts(ctx.opts);
          if (built.error) return [err(`index create: ${built.error}`)];
          clipConfig = built.config;
        } else if (type === "basic-clap") {
          const built = clapConfigFromOpts(ctx.opts);
          if (built.error) return [err(`index create: ${built.error}`)];
          clipConfig = built.config;
        } else if (type === "voice-print") {
          const built = voiceConfigFromOpts(ctx.opts);
          if (built.error) return [err(`index create: ${built.error}`)];
          voiceConfig = built.config;
        }
        const id = `local_${type.replace(/-/g, "_")}_${randomBytes(4).toString("hex")}`;
        mkdirSync(localIndexDir(c, id), { recursive: true });
        let audioFpConfig: ReturnType<typeof defaultAudioFpConfig> | undefined;
        if (type === "basic-clap") {
          if (clipConfig) writeClapConfig(localIndexDir(c, id), clipConfig);
        } else if (type === "audio-fp") {
          audioFpConfig = defaultAudioFpConfig();
          writeAudioFpConfig(localIndexDir(c, id), audioFpConfig);
        } else if (type === "voice-print") {
          if (voiceConfig) writeVoicePrintConfig(localIndexDir(c, id), voiceConfig);
        } else if (clipConfig) {
          writeClipConfig(localIndexDir(c, id), clipConfig);
        }
        const entry = addIndex(c, { id, type, name, description, backend: "local" });
        // a face-cluster DB's ingest/identify records are case evidence; if a
        // saved setup already narrows memory search, back-fill the `cluster`
        // signal so the new DB isn't silently unsearchable (case setup does the
        // same when the DB pre-dates the setup).
        if (type === "face-cluster") {
          const setup = loadSetup(c);
          if (setup?.memory && !setup.memory.signals.includes("cluster")) {
            setup.memory.signals = [...setup.memory.signals, "cluster"];
            saveSetup(c, setup);
          }
        }
        // same for a voice-print DB: its add/match records are case evidence
        if (type === "voice-print") {
          const setup = loadSetup(c);
          if (setup?.memory && !setup.memory.signals.includes("voice")) {
            setup.memory.signals = [...setup.memory.signals, "voice"];
            saveSetup(c, setup);
          }
        }
        return [makeRecord({
          verb: "index",
          format: "json",
          payload: {
            op: "create",
            summary: `created local ${type} index '${name}'`,
            index: entry.id,
            name: entry.name,
            type: entry.type,
            backend: "local",
            path: localIndexDir(c, id),
            ...(clipConfig ? { config: clipConfig } : voiceConfig ? { config: voiceConfig } : audioFpConfig ? { config: audioFpConfig } : {}),
          },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        })];
      }
      const { rec, id } = await tcCollectionCreate(name, type, { ...tcOpts, description, prompt, schema });
      // mirror an accepted create (ready OR an async pending that still returned
      // a real id) so the create→add-by-name flow works; a cred gap / error has no id.
      if (id && accepted(rec)) addIndex(c, { id, type, name, description: ctx.opts.description ? String(ctx.opts.description) : undefined, backend: "tinycloud" });
      rec.meta = { ...rec.meta, case: c.dir };
      return [indexRecord(rec)];
    }

    // ---- attach ----
    if (action === "attach") {
      const requested = ctx.rest[0]?.trim();
      if (!requested) return [err("usage: index attach <remote-index-id-or-name> [--type <media|entities|face>]")];
      const typeHint = ctx.opts.type != null ? normalizeIndexType(String(ctx.opts.type)) : undefined;
      if (ctx.opts.type != null && !typeHint) {
        return [err(`unknown --type '${ctx.opts.type}' (expected media-descriptions | entities | face-analysis | rich-transcripts | deepface-local | image-ransac | face-cluster | basic-clip | audio-fp | basic-clap | voice-print)`)];
      }
      if (typeHint && LOCAL_INDEX_TYPES.has(typeHint)) {
        return [err(`index attach: ${typeHint} is local-only; create it with \`index create <name> --type ${typeHint} --local\``)];
      }

      let remoteId = requested;
      let remoteName: string | undefined;
      let remoteType: string | undefined;
      const local = findIndex(c, requested);
      if (local) {
        if (isLocalIndex(local)) {
          return [err(`index attach: index '${requested}' is local; local visual indexes cannot be attached from tinycloud`)];
        }
        remoteId = local.id;
        remoteName = local.name;
        remoteType = local.type;
      } else {
        const listed = await tcCollectionList(tcOpts);
        const matches = remoteListItems(listed.rec).filter((item) => {
          const id = remoteIndexId(item);
          const name = remoteIndexName(item);
          return id === requested || name === requested;
        });
        if (matches.length > 1) {
          return [err(`remote index name '${requested}' is ambiguous; use one of: ${matches.map((m) => remoteIndexId(m)).filter(Boolean).join(", ")}`)];
        }
        if (matches.length === 1) {
          remoteId = remoteIndexId(matches[0]) ?? requested;
          remoteName = remoteIndexName(matches[0]);
          remoteType = remoteIndexType(matches[0]);
        }
      }

      const { rec: shown } = await tcCollectionShow(remoteId, tcOpts);
      if (shown.state === "error" || shown.state === "needs_credentials") {
        shown.meta = { ...shown.meta, case: c.dir };
        return [indexRecord(shown)];
      }
      const shownPayload = obj(shown.payload);
      const shownDetailed = obj(shownPayload.detailed);
      const shownCollection = obj(shownDetailed.collection);
      remoteName = remoteName ?? remoteIndexName(shownPayload) ?? remoteIndexName(shownDetailed) ?? remoteIndexName(shownCollection) ?? remoteId;
      remoteType = remoteType ?? remoteIndexType(shownPayload) ?? remoteIndexType(shownDetailed) ?? remoteIndexType(shownCollection) ?? typeHint;
      if (typeHint && remoteType && remoteType !== "unknown" && remoteType !== typeHint) {
        return [err(`index attach: --type ${typeHint} conflicts with remote index type '${remoteType}'`)];
      }
      const type = typeHint ?? remoteType ?? "unknown";
      const entry = addIndex(c, { id: remoteId, type, name: remoteName ?? remoteId });
      const files = remoteFiles(shown);
      const members = files.flatMap((f) => {
        const ref = remoteFileRef(f);
        return ref ? [{ ref, fileId: nonEmpty(f.file_id) ?? nonEmpty(f.fileId) ?? nonEmpty(f.id) }] : [];
      });
      setMembers(c, remoteId, members);
      return [makeRecord({
        verb: "index",
        format: "json",
        payload: {
          op: "attach",
          summary: `attached ${type} index '${entry.name}' (${files.length} remote file${files.length === 1 ? "" : "s"})`,
          index: entry.id,
          name: entry.name,
          type: entry.type,
          files: files.length,
          member_count: listIndexes(c).find((x) => x.id === remoteId)?.members.length ?? entry.members.length,
          detailed: shownPayload.detailed,
        },
        meta: { provider: "tinycloud", model: "cloudglue", op: "attach", case: c.dir },
        state: "ready",
      })];
    }

    // ---- add ----
    if (action === "add") {
      // `add` targets with --to; --from is `remove`'s flag. Reject it rather than
      // ignoring it and falling back to the sole index (wrong target).
      if (ctx.opts.from != null) return [err("index add targets with --to, not --from")];
      // --force bypasses the LOCAL membership mirror (.overcast/indexes.json) —
      // the mirror can go stale when files are deleted or fail server-side, and
      // a stale `already_member` skip silently no-ops the re-add.
      const force = ctx.opts.force === true;
      const batchErr = badNumber(ctx.opts, "batch", (n) => Number.isInteger(n) && n >= 0, "a non-negative integer (0 disables batching)");
      if (batchErr) return [err(`index add: ${batchErr}`)];
      if (ctx.opts.batch != null && ctx.opts.all !== true) return [err("index add: --batch only applies with --all")];
      const typeHint = ctx.opts.type != null ? normalizeIndexType(String(ctx.opts.type)) : undefined;
      // a typo'd OR empty --type must error here (like `create`), not be silently
      // dropped — otherwise the stub stays "unknown" and face auto-pick/type guards
      // confuse later. `!= null` catches a provided-but-empty `--type=`.
      if (ctx.opts.type != null && !typeHint) {
        return [err(`unknown --type '${ctx.opts.type}' (expected media-descriptions | entities | face-analysis | rich-transcripts)`)];
      }
      // `!= null` (not truthy) so a provided-but-empty `--to=` reaches resolveTarget
      // as a blank value it rejects, rather than being treated as omitted (→ sole).
      // `--to archive:<bucket>/<index>` targets a BUCKET's index: the mirror +
      // local artifacts live in the bucket; the source media stays case-side.
      const toRaw = ctx.opts.to != null ? String(ctx.opts.to) : undefined;
      const scoped = resolveIndexScope(c, toRaw ?? "", ctx.home);
      if (scoped.error) return [err(`index add: ${scoped.error}`)];
      const scope = scoped.scope;
      const target = resolveTarget(scope, toRaw === undefined ? undefined : scoped.value, typeHint);
      if (target.error) return [err(`index add: ${target.error}`)];
      const id = target.id!;
      // Ensure the target is in the local mirror — it may have been created
      // outside this case and referenced only by id. Without this, addMember
      // no-ops (index absent) and `add --all` re-adds the same videos every
      // run. Record the --type hint when given so face auto-resolution can find
      // it; otherwise "unknown" (face --match falls back to those candidates).
      const existing = findIndex(scope, id);
      const hintedLocal = typeHint ? LOCAL_INDEX_TYPES.has(typeHint) : false;
      // a --type hint that CONTRADICTS the target's known type is a mistake, not a
      // silent no-op — reject it so the video isn't indexed into the wrong type.
      if (existing && typeHint && existing.type !== "unknown" && existing.type !== typeHint) {
        return [err(`index add: --type ${typeHint} conflicts with index ${id}'s type '${existing.type}' — omit --type, or target a ${typeHint} index`)];
      }
      if (existing && hintedLocal && existing.backend !== "local" && (existing.backend !== undefined || existing.members.length > 0)) {
        return [err(`index add: index ${id} is not a local visual index; create a local ${typeHint} index first, or choose an empty target`)];
      }
      if (!existing) {
        addIndex(scope, { id, type: typeHint ?? "unknown", name: id, backend: hintedLocal ? "local" : undefined });
      } else if (typeHint && existing.type === "unknown") {
        // a later `add --type face` classifies a previously-unknown stub (addIndex upserts).
        addIndex(scope, { id, type: typeHint, name: existing.name, description: existing.description, backend: hintedLocal ? "local" : existing.backend });
      }
      const targetEntry = findIndex(scope, id);
      // face-cluster is guarded by TYPE, above the backend dispatch — a mirror
      // entry missing its "local" stamp must still hit this error, not fall
      // through to the tinycloud add path (the type is local-only regardless).
      if (targetEntry?.type === "face-cluster") {
        return [err(`index add doesn't apply to a face-cluster index — it ingests media, not reference images. Use \`cluster add <video|image> --index ${id}\` (see \`overcast cluster --help\`).`)];
      }
      if (targetEntry && isLocalIndex(targetEntry)) {
        // local index membership IS the index (no remote copy to drift from), so
        // a stale-cache bypass has nothing to reconcile — reject rather than
        // pretending to re-add.
        if (force) {
          return [err(`index add: --force only applies to remote (tinycloud) indexes — local index membership can't go stale (use \`index remove\` to drop a member)`)];
        }
        // basic-clip members must be embedded (CLIP vectors), not just referenced —
        // that path lives on the `similar` verb, which computes + caches them.
        if (targetEntry.type === "basic-clip") {
          return [err(`index add: '${id}' is a basic-clip index — embed members with \`similar add <image|video> --index ${id}\` (it computes and caches CLIP vectors)`)];
        }
        // basic-clap members must be embedded with CLAP; audio-fp members must be
        // fingerprinted — both compute + cache artifacts on their own verb, not here.
        if (targetEntry.type === "basic-clap") {
          return [err(`index add: '${id}' is a basic-clap index — embed members with \`similar add <audio|video> --index ${id}\` (it computes and caches CLAP vectors)`)];
        }
        if (targetEntry.type === "audio-fp") {
          return [err(`index add: '${id}' is an audio-fp index — fingerprint members with \`audio add <clip> --index ${id}\` (it computes and caches constellation hashes)`)];
        }
        if (targetEntry.type === "voice-print") {
          return [err(`index add: '${id}' is a voice-print index — enroll members with \`voice add <audio|video> --index ${id}\` (it computes and caches speaker-window embeddings)`)];
        }
        if (ctx.opts["no-upload"] === true || ctx.opts["no-download"] === true) {
          return [err("index add: --no-upload/--no-download only apply to tinycloud indexes")];
        }
        if (ctx.opts.all === true) {
          const imageTargets = caseImageRefs(c);
          const seen = new Set(targetEntry.members.map((m) => m.ref));
          const refs = imageTargets.filter((m) => !seen.has(m.ref));
          if (!refs.length) return [err("index add --all: no new image records to register in the local index")];
          for (const m of refs) addMember(scope, id, m);
          mkdirSync(localIndexDir(scope, id), { recursive: true });
          return [stampArchive(makeRecord({
            verb: "index",
            format: "json",
            payload: { op: "add", index: id, backend: "local", files: refs.map((r) => r.ref), count: refs.length },
            meta: { provider: "local", case: c.dir },
            state: "ready",
          }), scoped.bucket, c.dir)];
        }
        const arg = ctx.rest[0];
        if (!arg) return [err("usage: index add <image|record-id> --to <local-index>")];
        if (targetEntry.type !== "deepface-local" && targetEntry.type !== "image-ransac") {
          return [err(`index add: local index ${id} has unsupported type '${targetEntry.type}'`)];
        }
        const img = resolveImageArg(c, arg, "index add", { home: ctx.home });
        if (img.error) return [err(img.error)];
        if (targetEntry.members.some((m) => m.ref === img.ref)) {
          return [stampArchive(makeRecord({ verb: "index", format: "json", payload: { op: "add", index: id, file: img.ref, backend: "local", already_member: true }, media: { ref: img.ref! }, meta: { case: c.dir }, state: "ready" }), scoped.bucket, c.dir)];
        }
        mkdirSync(localIndexDir(scope, id), { recursive: true });
        addMember(scope, id, { ref: img.ref!, recordId: img.recordId });
        return [stampArchive(makeRecord({
          verb: "index",
          format: "json",
          payload: { op: "add", index: id, file: img.ref, backend: "local", summary: `added image to local ${targetEntry.type} index` },
          media: { ref: img.ref! },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        }), scoped.bucket, c.dir)];
      }
      const addOpts = {
        ...tcOpts,
        noUpload: ctx.opts["no-upload"] === true,
        noDownload: ctx.opts["no-download"] === true,
      };

      // --all: register every captured/sensed video not already a member.
      if (ctx.opts.all === true) {
        // --all reads the whole case, not a positional — a stray video arg is a
        // mistake (it would be silently ignored if other videos exist).
        if (ctx.rest[0]) return [err("index add: --all registers every case video — drop the positional video, or omit --all to add just that one")];
        const col = findIndex(scope, id);
        const members = new Set(col?.members.map((m) => m.ref) ?? []);
        const caseVids = caseVideoRefs(c);
        const vids = caseVids.filter((v) => force || !members.has(v.ref));
        if (vids.length === 0) {
          // caseVideoRefs only returns READY media not already a member — so when
          // it's empty, distinguish "still processing" and "sensing failed" from a
          // genuinely empty case (same accounting predicate, so a face-search query
          // image is never miscounted as a pending/failed video).
          const unregistered = c
            .records()
            .filter((r) => isRegisterableMediaRecord(r) && !members.has(r.media!.ref!));
          const pending = unregistered.filter((r) => r.state === "pending").length;
          const failed = unregistered.filter((r) => r.state !== "pending" && !isReady(r)).length;
          return [err(
            pending > 0
              ? `index add --all: ${pending} video(s) still processing (pending) — rerun once they're ready`
              : failed > 0
                ? `index add --all: ${failed} video(s) failed to sense (state=error/needs_credentials) — re-run the sense, then --all`
                : caseVids.length > 0
                  ? `index add --all: all ${caseVids.length} ready video(s) are already listed in the local membership mirror — pass --force to re-submit them after server-side deletes/failures`
                  : "index add --all: no captured/sensed videos to register",
          )];
        }
        const batchSize = ctx.opts.batch != null ? Number(ctx.opts.batch) : DEFAULT_ADD_BATCH;
        const waves = chunkBatches(vids, batchSize);
        const recs: OvercastRecord[] = [];
        const failedRefs: string[] = [];
        for (let w = 0; w < waves.length; w++) {
          const waveIds = new Set<string>();
          for (const v of waves[w]) {
            const watched = await ensureLocalWatchRecord(ctx, v.ref);
            const { rec, fileId } = await tcCollectionAdd(v.ref, id, addOpts);
            if (accepted(rec)) addMember(scope, id, { ref: v.ref, recordId: v.recordId });
            else failedRefs.push(v.ref);
            if (fileId) waveIds.add(fileId);
            rec.meta = { ...rec.meta, case: c.dir };
            recs.push(stampArchive(indexRecord(rec), scoped.bucket, c.dir));
            if (watched) recs.push(watched);
          }
          // backpressure: pace waves so a large corpus can't flood the provider
          // (the field failure mode) — never after the last wave.
          if (w < waves.length - 1) await waitForWaveSettled(id, waveIds, waves[w].length, tcOpts, ctx.signal);
        }
        // a batched run gets one rollup so the outcome is readable without
        // paging N per-file records (single-wave runs stay exactly as before).
        if (waves.length > 1) {
          recs.push(stampArchive(makeRecord({
            verb: "index",
            format: "json",
            payload: {
              op: "add",
              index: id,
              all: true,
              summary: `registered ${vids.length - failedRefs.length}/${vids.length} videos in ${waves.length} waves of ≤${batchSize}${failedRefs.length ? ` — ${failedRefs.length} failed (re-run \`index add --all\`, or \`index add <video> --to ${id} --force\` for server-side failures)` : ""}`,
              submitted: vids.length,
              accepted: vids.length - failedRefs.length,
              failed: failedRefs.length,
              ...(failedRefs.length ? { failed_refs: failedRefs } : {}),
              waves: waves.length,
              batch_size: batchSize,
            },
            // per-file failures already carry their own error records; the rollup
            // is the accounting surface, not a second failure signal.
            meta: { provider: "tinycloud", case: c.dir },
            state: "ready",
          }), scoped.bucket, c.dir));
        }
        return recs;
      }

      const arg = ctx.rest[0];
      if (!arg) return [err("usage: index add <video|record-id> --to <id> (or --all)")];
      const v = resolveVideoArg(c, arg, "index add", { home: ctx.home });
      if (v.error) return [err(v.error)];
      const ref = v.ref!;
      // dedupe like `--all` (which filters existing members) — don't re-submit a
      // video already in the index to tinycloud. The mirror is LOCAL and can go
      // stale (server-side deletes/failures don't clear it): --force re-submits
      // anyway, and tells the reader that's what happened.
      const wasMember = findIndex(scope, id)?.members.some((m) => m.ref === ref) === true;
      if (wasMember && !force) {
        return [stampArchive(makeRecord({ verb: "index", format: "json", payload: { op: "add", index: id, file: ref, already_member: true, note: "skipped from the local membership mirror — pass --force to re-submit (e.g. after a server-side delete/failure)" }, meta: { case: c.dir }, state: "ready" }), scoped.bucket, c.dir)];
      }
      const watched = v.archive
        ? await ensureArchiveWatchRecord(ctx, v.archive, ref)
        : await ensureLocalWatchRecord(ctx, ref);
      const { rec } = await tcCollectionAdd(ref, id, addOpts);
      if (accepted(rec)) addMember(scope, id, { ref, recordId: v.recordId });
      if (wasMember && rec.payload && typeof rec.payload === "object") {
        (rec.payload as Record<string, unknown>).forced = true;
      }
      rec.meta = { ...rec.meta, case: c.dir };
      // stamp only the add record — a bucket-persisted `watched` side-record
      // must keep its bucket ownership, not be re-homed to the case
      return watched ? [stampArchive(indexRecord(rec), scoped.bucket, c.dir), watched] : [stampArchive(indexRecord(rec), scoped.bucket, c.dir)];
    }

    // ---- list ----
    // A pure read — transient like `finding list`, so callers that poll it (the
    // vscode sidebar re-lists on every store change) don't append an audit row
    // per poll: each write would re-fire the store watcher and grow index.jsonl
    // forever. Mutations (create/add/delete/…) stay persisted.
    if (action === "list" || action === undefined) {
      const mirror = listIndexes(c).map((x) => ({ id: x.id, type: x.type, backend: x.backend ?? "tinycloud", name: x.name, members: x.members.length }));
      if (ctx.opts.remote === true) {
        const { rec } = await tcCollectionList(tcOpts);
        (rec.payload as Record<string, unknown>).mirror = mirror;
        rec.meta = { ...rec.meta, case: c.dir, transient: true };
        return [indexRecord(rec)];
      }
      return [makeRecord({ verb: "index", format: "json", payload: { op: "list", indexes: mirror, count: mirror.length }, meta: { case: c.dir, transient: true }, state: "ready" })];
    }

    // ---- show ----
    if (action === "show") {
      const stray = strayTargetFlag(ctx);
      if (stray) return [err(`index show takes a positional id: \`index show <id>\` (saw ${stray}, which doesn't apply here)`)];
      // `index show archive:<bucket>/<index>` reads a bucket's mirror entry.
      const scoped = resolveIndexScope(c, ctx.rest[0] ?? "", ctx.home);
      if (scoped.error) return [err(`index show: ${scoped.error}`)];
      const scope = scoped.scope;
      const target = resolveTarget(scope, ctx.rest[0] === undefined ? undefined : scoped.value);
      if (target.error) return [err(`index show: ${target.error}`)];
      const local = findIndex(scope, target.id!);
      if (local && isLocalIndex(local)) {
        return [stampArchive(makeRecord({
          verb: "index",
          format: "json",
          payload: {
            op: "show",
            index: local.id,
            name: local.name,
            type: local.type,
            backend: local.backend ?? "local",
            path: localIndexDir(scope, local.id),
            members: local.members,
            member_count: local.members.length,
          },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        }), scoped.bucket, c.dir)];
      }
      const { rec } = await tcCollectionShow(target.id!, tcOpts);
      rec.meta = { ...rec.meta, case: c.dir };
      return [stampArchive(indexRecord(rec), scoped.bucket, c.dir)];
    }

    // ---- delete ----
    if (action === "delete") {
      // guard the destructive op: a misused --to/--from with no positional must not
      // silently delete the case's sole index.
      const stray = strayTargetFlag(ctx);
      if (stray) return [err(`index delete takes a positional id: \`index delete <id>\` (saw ${stray}, which doesn't apply here)`)];
      // delete requires an EXPLICIT id — unlike show, it must never fall back to the
      // case's sole index (a bare `index delete` would be silent data loss).
      if (!ctx.rest[0]) return [err("usage: index delete <id> (an explicit id is required — delete won't default to your only index)")];
      // `index delete archive:<bucket>/<index>` administers a BUCKET's index
      // (mirror + local artifacts in the bucket), like add/show.
      const scoped = resolveIndexScope(c, ctx.rest[0], ctx.home);
      if (scoped.error) return [err(`index delete: ${scoped.error}`)];
      const scope = scoped.scope;
      const target = resolveTarget(scope, scoped.value);
      if (target.error) return [err(`index delete: ${target.error}`)];
      const local = findIndex(scope, target.id!);
      if (local && isLocalIndex(local)) {
        removeIndex(scope, target.id!);
        rmSync(localIndexDir(scope, target.id!), { recursive: true, force: true });
        return [stampArchive(makeRecord({
          verb: "index",
          format: "json",
          payload: { op: "delete", index: target.id, backend: "local", deleted: true },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        }), scoped.bucket, c.dir)];
      }
      const { rec } = await tcCollectionDelete(target.id!, tcOpts);
      if (accepted(rec)) removeIndex(scope, target.id!);
      rec.meta = { ...rec.meta, case: c.dir };
      return [stampArchive(indexRecord(rec), scoped.bucket, c.dir)];
    }

    // ---- remove ----
    if (action === "remove") {
      // `remove` targets with --from; --to is `add`'s flag. Reject it rather than
      // ignoring it and falling back to the sole index (wrong target).
      if (ctx.opts.to != null) return [err("index remove targets with --from, not --to")];
      const arg = ctx.rest[0];
      if (!arg) return [err("usage: index remove <video|record-id> --from <id>")];
      // `--from archive:<bucket>/<index>` un-indexes from a BUCKET's index —
      // the member list + cached embeddings/fingerprints live bucket-side.
      const fromRaw = ctx.opts.from != null ? String(ctx.opts.from) : undefined;
      const scoped = resolveIndexScope(c, fromRaw ?? "", ctx.home);
      if (scoped.error) return [err(`index remove: ${scoped.error}`)];
      const scope = scoped.scope;
      const from = resolveTarget(scope, fromRaw === undefined ? undefined : scoped.value);
      if (from.error) return [err(`index remove: ${from.error}`)];
      const local = findIndex(scope, from.id!);
      if (local?.type === "face-cluster") {
        return [err(`index remove doesn't apply to a face-cluster index — it stores face assignments in faces.jsonl/clusters.json. Create a new face-cluster index or rebuild with \`cluster recluster --index ${from.id}\`.`)];
      }
      if (local && isLocalIndex(local)) {
        // basic-clip/basic-clap/audio-fp/voice-print members can be videos or audio
        // (image-ransac/deepface store stills), so accept AV for those; also drop
        // the removed member's cached embedding/fingerprint.
        const avTypes = new Set(["basic-clip", "basic-clap", "audio-fp", "voice-print"]);
        const resolved = avTypes.has(local.type)
          ? (local.type === "basic-clip"
              ? resolveVisualArg(c, arg, "index remove", { requireExists: false, requireReady: false, home: ctx.home })
              : resolveVideoArg(c, arg, "index remove", { requireExists: false, requireReady: false, home: ctx.home }))
          : resolveImageArg(c, arg, "index remove", { requireExists: false, requireReady: false, home: ctx.home });
        if (resolved.error) return [err(resolved.error)];
        const removed = removeMember(scope, from.id!, resolved.ref!);
        if (removed) {
          const dir = localIndexDir(scope, from.id!);
          // voice-print caches share the basic-clip emb/<sha1(ref)> layout
          if (local.type === "basic-clip" || local.type === "basic-clap" || local.type === "voice-print") removeClipEmbedding(dir, resolved.ref!);
          else if (local.type === "audio-fp") removeAudioFingerprint(dir, resolved.ref!);
        }
        return [stampArchive(makeRecord({
          verb: "index",
          format: "json",
          payload: { op: "remove", index: from.id, file: resolved.ref, backend: "local", removed },
          media: { ref: resolved.ref! },
          meta: { provider: "local", case: c.dir },
          state: "ready",
        }), scoped.bucket, c.dir)];
      }
      // same media filters as add/entities (reject scan/face-search/non-AV refs),
      // but allow a gone local file / errored record — you should still be able to
      // un-index a video that's no longer on disk or whose sense later failed.
      const v = resolveVideoArg(c, arg, "index remove", { requireExists: false, requireReady: false, home: ctx.home });
      if (v.error) return [err(v.error)];
      const ref = v.ref!;
      const { rec } = await tcCollectionRemove(ref, from.id!, tcOpts);
      // mirror on ready OR pending (an async remove still removed the member),
      // matching how `add` tracks membership via accepted().
      if (accepted(rec)) removeMember(scope, from.id!, ref);
      rec.meta = { ...rec.meta, case: c.dir };
      return [stampArchive(indexRecord(rec), scoped.bucket, c.dir)];
    }

    // ---- entities ----
    if (action === "entities") {
      // entities takes a POSITIONAL index id; --to/--from are add/remove flags
      // and don't apply — reject them rather than silently using the positional
      // (consistent with add/remove/show/delete).
      if (ctx.opts.to != null || ctx.opts.from != null) {
        return [err("index entities takes a positional id: `index entities <id> <video>` (--to/--from don't apply here)")];
      }
      const id = ctx.rest[0]?.trim(); // trim so a blank/padded id doesn't bypass mirror lookup
      const videoArg = ctx.rest[1];
      if (!id || !videoArg) return [err("usage: index entities <index-id> <video|record-id>")];
      // validate the numeric paging flags via the SHARED validator (matches face/ask)
      // — it also rejects a blank `--offset=`, which the old inline `n < 0` check let
      // through as 0 (Number("") === 0).
      const numErr =
        badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number") ??
        badNumber(ctx.opts, "offset", (n) => n >= 0, "a non-negative number");
      if (numErr) return [err(`index entities: ${numErr}`)];
      const limit = numFlag(ctx.opts, "limit");
      const offset = numFlag(ctx.opts, "offset");
      // resolve the index id, surfacing an ambiguous-name error (like ask/add)
      // and rejecting a mirrored index whose type isn't entities (entities are
      // only readable from an entities index), consistent with ask/face.
      // `archive:<bucket>/<index>` resolves through the BUCKET's mirror.
      const scoped = resolveIndexScope(c, id, ctx.home);
      if (scoped.error) return [err(`index entities: ${scoped.error}`)];
      const colRef = resolveIndexRef(scoped.scope, scoped.value);
      if (colRef.error) return [err(`index entities: ${colRef.error}`)];
      const colEntry = colRef.entry;
      if (colEntry && colEntry.type !== "entities" && colEntry.type !== "unknown") {
        return [err(`index ${colEntry.id} is type '${colEntry.type}', not entities — \`index entities\` only reads entities indexes`)];
      }
      const colId = colEntry?.id ?? scoped.value;
      // same media filters as `add` (reject scan/face-search/non-AV refs), but
      // requireExists:false — entities reads PRE-EXTRACTED data for a video already
      // indexed remotely, so its local file may be gone (matches `remove`).
      const v = resolveVideoArg(c, videoArg, "index entities", { requireExists: false, requireReady: false, home: ctx.home });
      if (v.error) return [err(v.error)];
      const { rec } = await tcCollectionEntities(colId, v.ref!, { ...tcOpts, limit, offset });
      rec.meta = { ...rec.meta, case: c.dir };
      return [stampArchive(indexRecord(rec), scoped.bucket, c.dir)];
    }

    return [err(`usage: index <${VALID_ACTIONS.join("|")}>`)];
  },
};
