// Phase 3 OSINT verbs: scan (sweep sources), capture (fetch a ref), monitor
// (scan on a loop + diff seen-set), plus the state verbs target/source and the
// prebrief case wizard. Source providers live in providers/sources.

import { join, basename, dirname } from "node:path";
import { copyFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeRecord, errRecord, type OvercastRecord } from "../record.js";
import { sniffExt } from "../media/fetch.js";
import {
  builtinDescriptor,
  enumerateSource,
  fetchSource,
} from "../providers/sources/index.js";
import {
  resolveSources,
  enabledSources,
  addSource,
  listSources,
  setEnabled,
  removeSource,
} from "../state/source.js";
import { addTarget, listTargets, removeTarget, primaryTarget, setTargetStatus, isTargetClosed } from "../state/target.js";
import { listIndexes } from "../state/index.js";
import { loadSetup } from "../state/setup.js";
import { loadSeen, saveSeen, loadEphemeralFails, saveEphemeralFails, hitKey } from "../state/seen.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { runListen } from "../providers/tinycloud/listen.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerBinding } from "../providers/bindings.js";
import { providerEnv } from "../providers/provider-env.js";
import { parseSince } from "../providers/memory/local.js";
import { isAv, isImage, resolveMediaRef } from "./media-ref.js";
import { ARCHIVE_REF_PREFIX, provenanceCase, sha256File } from "../archive.js";
import { isReady } from "../record.js";
import { faceVerb } from "./face.js";
import { imageVerb } from "./image.js";
import { seeVerb, enhanceVerb } from "./senses.js";
import { exifVerb, verifyVerb } from "./forensics.js";
import { indexVerb } from "./index.js";
import { evaluateTriggers, resolveFindingsPolicy } from "../signals/triggers.js";
import { provenanceFromCapture, scanHitProvenance, stampProvenance } from "./provenance.js";
import { redactSecrets } from "../env.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const err = errRecord;

function scanFlagError(ctx: VerbContext, verb = "scan"): OvercastRecord | undefined {
  if (ctx.opts.limit != null) {
    const n = Number(ctx.opts.limit);
    if (!Number.isFinite(n) || n <= 0) {
      return err(verb, `invalid --limit: ${ctx.opts.limit} (expected a positive number)`);
    }
  }
  const since = ctx.opts.since ? String(ctx.opts.since) : undefined;
  if (since && parseSince(since) == null) {
    return err(verb, `invalid --since: ${since} (expected e.g. 24h, 7d, 2026-06-01)`);
  }
  return undefined;
}

const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|m2ts|mts|ts|wmv|flv|3gp|3g2|ogv|mxf)$/i;
const isVideoRef = (ref: string): boolean => !/^https?:\/\//i.test(ref) && VIDEO_RE.test(ref.replace(/[?#].*$/, ""));
const isLocalVisualRef = (ref: string): boolean => isVideoRef(ref) || isImage(ref);

function localMediaRefs(ctx: VerbContext): string[] {
  const setup = loadSetup(ctx.case);
  const refs = [
    ...(setup?.media.videos ?? []),
    ...ctx.case.records().flatMap((r) => (r.media?.ref && isLocalVisualRef(r.media.ref) ? [r.media.ref] : [])),
    ...listIndexes(ctx.case).flatMap((i) => i.members.map((m) => m.ref).filter(isLocalVisualRef)),
  ];
  return [...new Set(refs)].filter((ref) => !/^https?:\/\//i.test(ref) ? existsSync(ref) : true).sort();
}

function localVisualCandidates(refs: string[], imageTargets: Array<{ value: string }>, localIndexes: ReturnType<typeof listIndexes>): string[] {
  const excluded = new Set([
    ...imageTargets.map((t) => t.value),
    ...localIndexes.flatMap((i) => i.members.map((m) => m.ref)),
  ]);
  return refs.filter((ref) => !excluded.has(ref));
}

async function scanLocalCase(ctx: VerbContext): Promise<OvercastRecord[]> {
  const targets = listTargets(ctx.case);
  // closed lines (answered/dead-end) must not seed local matching either — same
  // invariant primaryTarget enforces for external scan seeding, so a dead image
  // line stops auto-producing match candidates + suggested findings.
  const openTargets = targets.filter((t) => !isTargetClosed(t));
  const imageTargets = openTargets.filter((t) => t.kind === "image");
  const nameTargets = openTargets.filter((t) => t.kind !== "image").map((t) => t.value);
  const indexes = listIndexes(ctx.case);
  const faceIndexes = indexes.filter((i) => i.type === "face-analysis");
  const localFaceIndexes = indexes.filter((i) => i.backend === "local" && i.type === "deepface-local");
  const localImageIndexes = indexes.filter((i) => i.backend === "local" && i.type === "image-ransac");
  const mediaIndexes = indexes.filter((i) => i.type === "media-descriptions");
  const refs = localMediaRefs(ctx);
  const localLimit = ctx.opts.limit != null ? Number(ctx.opts.limit) : 5;
  const localCandidatesAll = localVisualCandidates(refs, imageTargets, [...localFaceIndexes, ...localImageIndexes]);
  const localImageCandidates = localCandidatesAll.slice(0, localLimit);
  const localFaceCandidatesAll = localCandidatesAll.filter(isVideoRef);
  const localFaceCandidates = localFaceCandidatesAll.slice(0, localLimit);
  const suggested: string[] = [];
  if (imageTargets.length && faceIndexes.length) {
    suggested.push(`overcast face --match ${imageTargets.at(-1)!.value} --index ${faceIndexes.map((i) => i.id).join(",")}`);
  }
  if (imageTargets.length && localFaceIndexes.length && localFaceCandidates.length) {
    suggested.push(`overcast face ${localFaceCandidates[0]} --match ${imageTargets.at(-1)!.value} --index ${localFaceIndexes[0].id}`);
  }
  if (imageTargets.length && localImageIndexes.length && localImageCandidates.length) {
    suggested.push(`overcast image match ${localImageCandidates[0]} --index ${localImageIndexes[0].id}`);
  }
  if (nameTargets.length) suggested.push(`overcast ask ${JSON.stringify(`where is ${nameTargets.at(-1)} and what is happening?`)}`);
  if (mediaIndexes.length) suggested.push(`overcast ask ${JSON.stringify(`where is ${nameTargets.at(-1) ?? "the target"} and what is happening?`)} --index ${mediaIndexes[0].id} --probe`);

  const summary = makeRecord({
    verb: "scan",
    format: "json",
    payload: {
      op: "local",
      summary: `local scan: ${refs.length} media file${refs.length === 1 ? "" : "s"}, ${faceIndexes.length} face index${faceIndexes.length === 1 ? "" : "es"}, ${mediaIndexes.length} media-description index${mediaIndexes.length === 1 ? "" : "es"}`,
      reason: "no enabled external sources; scanned local setup, case memory, and mirrored indexes instead",
      targets: targets.map((t) => ({ id: t.id, kind: t.kind, value: t.value })),
      media: refs,
      indexes: indexes.map((i) => ({ id: i.id, name: i.name, type: i.type, members: i.members.length })),
      local_visual_candidates: localImageCandidates.length,
      local_visual_candidates_total: localCandidatesAll.length,
      local_face_candidates: localFaceCandidates.length,
      local_face_candidates_total: localFaceCandidatesAll.length,
      local_visual_limit: localLimit,
      suggested_commands: suggested,
    },
    meta: { provider: "scan:local", case: ctx.case.dir },
    state: "ready",
  });

  const out: OvercastRecord[] = [summary];
  if (imageTargets.length && faceIndexes.length) {
    const match = imageTargets.at(-1)!.value;
    const index = faceIndexes.map((i) => i.id).join(",");
    const faceRecords = await faceVerb.run({ ...ctx, input: undefined, rest: [], opts: { match, index } });
    out.push(...faceRecords);
  }
  if (imageTargets.length && localFaceIndexes.length && localFaceCandidates.length) {
    const match = imageTargets.at(-1)!.value;
    const index = localFaceIndexes[0].id;
    for (const ref of localFaceCandidates) {
      const faceRecords = await faceVerb.run({ ...ctx, input: ref, rest: [], opts: { match, index } });
      out.push(...faceRecords);
    }
  }
  if (imageTargets.length && localImageIndexes.length && localImageCandidates.length) {
    const index = localImageIndexes[0].id;
    for (const ref of localImageCandidates) {
      const imageRecords = await imageVerb.run({ ...ctx, input: "match", rest: [ref], opts: { index } });
      out.push(...imageRecords);
    }
  }
  return out;
}

// ---- scan ------------------------------------------------------------------

async function enumerateAll(ctx: VerbContext, verb = "scan"): Promise<OvercastRecord[]> {
  const sourceIds = ctx.opts.source ? String(ctx.opts.source).split(",").map((s) => s.trim()) : undefined;
  const sources = resolveSources(ctx.case, sourceIds);
  // an explicit --query overrides everything; otherwise each source enumerates
  // its OWN ref (channel/playlist/handle/keyword), falling back to the standing
  // target only when the source has no ref. (Previously the target shadowed
  // every source's ref, so a bound `youtube:@channel` was searched by keyword.)
  const adhocQuery = ctx.opts.query ? String(ctx.opts.query) : undefined;
  const targetValue = primaryTarget(ctx.case)?.value;
  // a non-finite --limit is rejected rather than forwarded as "NaN"
  let limit: number | undefined;
  const flagError = scanFlagError(ctx, verb);
  if (flagError) return [flagError];
  if (ctx.opts.limit != null) limit = Number(ctx.opts.limit);
  const since = ctx.opts.since ? String(ctx.opts.since) : undefined;

  if (sources.length === 0) {
    return [err(verb, "no sources registered/enabled (try `overcast source add <type>:<ref>`)")];
  }

  const out: OvercastRecord[] = [];
  for (const s of sources) {
    const desc = builtinDescriptor(s.type);
    if (!desc) {
      out.push(err("scan", `unknown source type '${s.type}' (no provider)`));
      continue;
    }
    try {
      const hits = await enumerateSource(desc, {
        query: adhocQuery ?? (s.ref || targetValue),
        ref: s.ref,
        limit,
        since,
        // same env sense/enhance providers get, plus the case root: lets a
        // source materialize hit artifacts (e.g. lens match thumbnails) into
        // the case media dir and resolve case-relative query paths.
        env: providerEnv(ctx.case.mediaDir, ctx.case.dir),
        signal: ctx.signal,
      });
      for (const h of hits) {
        if (typeof h.payload === "object") (h.payload as Record<string, unknown>).source_id = s.id;
        out.push(h);
      }
    } catch (e) {
      out.push(err("scan", `source ${s.type} enumerate error: ${(e as Error).message}`));
    }
  }
  const credFailures = out.filter((r) => r.state === "needs_credentials" && /source .* enumerate failed/.test(String(r.error ?? "")));
  if (credFailures.length > 1) {
    const affected = sources
      .filter((s) => credFailures.some((r) => String(r.error ?? "").includes(`source ${s.type} enumerate failed`)))
      .map((s) => `${s.type}:${s.ref}`);
    const missing = [...new Set(credFailures.map((r) => String(r.error ?? "").includes("APIFY_TOKEN") ? "APIFY_TOKEN" : "source credentials"))];
    out.unshift(makeRecord({
      verb,
      format: "json",
      payload: {
        blocked: true,
        missing,
        affected_sources: affected,
        fix: missing.includes("APIFY_TOKEN")
          ? "put APIFY_TOKEN in .env before launching overcast, or export it in the shell; verify with `overcast doctor --sources`"
          : "check source-provider credentials with `overcast doctor --sources`",
      },
      error: `${affected.length || credFailures.length} source scan(s) blocked by missing credentials: ${missing.join(", ")}`,
      state: "needs_credentials",
    }));
  }
  return out;
}

function checkpoint(ctx: VerbContext, rec: OvercastRecord): OvercastRecord {
  rec.meta = { ...rec.meta, case: ctx.case.dir };
  ctx.case.writeRecord(rec);
  rec.meta = { ...rec.meta, persisted: true };
  return rec;
}

function scanProgress(ctx: VerbContext, payload: Record<string, unknown>, state: string = "pending"): OvercastRecord {
  return checkpoint(ctx, makeRecord({
    verb: "scan",
    format: "json",
    payload: { op: "pull_progress", ...payload },
    meta: { provider: "scan:progress", case: ctx.case.dir },
    state,
  }));
}

function scanProgressState(outcome: HitProcessOutcome): string {
  if (outcome === "pending" || outcome === "completed_with_pending") return "pending";
  if (outcome === "needs_credentials" || outcome === "completed_with_credential_gap") return "needs_credentials";
  if (outcome === "failed") return "error";
  return "ready";
}

function isTikTokUrl(ref: string): boolean {
  try {
    const host = new URL(ref).hostname.toLowerCase();
    return host === "tiktok.com" || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

function canSenseRemoteDirect(ctx: VerbContext, verb: string, ref: string): boolean {
  if (!isTikTokUrl(ref)) return false;
  if (verb !== "watch" && verb !== "face") return false;
  return !isCustomBinding(providerBinding(ctx, verb));
}

type DirectSensePlan = {
  verb: string;
  explicitPipe: boolean;
  remainingAutoSense: string[];
};

function directSensePlan(ctx: VerbContext, ref: string): DirectSensePlan | undefined {
  const explicitPipe = ctx.opts.pipe ? String(ctx.opts.pipe) : undefined;
  if (explicitPipe) {
    return canSenseRemoteDirect(ctx, explicitPipe, ref)
      ? { verb: explicitPipe, explicitPipe: true, remainingAutoSense: [] }
      : undefined;
  }
  const autoChain = loadSetup(ctx.case)?.automation?.auto_sense ?? [];
  const first = autoChain[0];
  return first && canSenseRemoteDirect(ctx, first, ref)
    ? { verb: first, explicitPipe: false, remainingAutoSense: autoChain.slice(1) }
    : undefined;
}

type HitProcessOutcome = "completed" | "completed_with_error" | "completed_with_pending" | "completed_with_credential_gap" | "pending" | "failed" | "needs_credentials";

interface ProcessHitResult {
  ref?: string;
  records: OvercastRecord[];
  outcome: HitProcessOutcome;
  submittedRemote: number;
}

function hitFetchRef(hit: OvercastRecord): string | undefined {
  const hitUrl = (hit.payload as Record<string, unknown>)?.url;
  return hit.media?.ref ?? (typeof hitUrl === "string" ? hitUrl : undefined);
}

function hitProcessKey(hit: OvercastRecord): string {
  return `${hitKey(hit)}\u001f${hitFetchRef(hit) ?? ""}`;
}

/** An "ephemeral" hit is a live resource (a webcam's CURRENT still) whose content
 *  changes every poll: `monitor` should re-capture it each pass WITHOUT persisting
 *  it to the seen-set (which would otherwise grow unbounded). Source opts in with
 *  `payload.recapture: true`. */
function isEphemeralHit(hit: OvercastRecord): boolean {
  return (hit.payload as Record<string, unknown> | undefined)?.recapture === true;
}

/** After this many CONSECUTIVE hard failures, an ephemeral hit is marked seen
 *  (given up) so a permanently-broken live resource stops re-running the pull
 *  pipeline every interval. A single success resets the count. */
const EPHEMERAL_MAX_FAILS = 5;

/** Perception + forensic senses whose records are the PRIMARY result of pulling a
 *  hit. One source of truth so the pull/monitor plumbing — outcome classification,
 *  provenance stamping, index-retry, auto_sense dispatch — never drifts when a new
 *  sense verb is added. (Visual-DB ops image/similar/cluster stay auxiliary.) */
const PRIMARY_SENSE_VERBS = ["watch", "listen", "see", "face", "enhance", "exif", "verify"];

function classifyHitRecords(records: OvercastRecord[]): HitProcessOutcome {
  if (records.length === 0) return "failed";
  const primary = records.filter((r) => r.verb === "capture" || PRIMARY_SENSE_VERBS.includes(r.verb));
  const senses = primary.filter((r) => r.verb !== "capture");
  const hasReadySense = senses.some((r) => r.state !== "error" && r.state !== "needs_credentials" && r.state !== "pending");
  const auxiliary = primary.length ? records.filter((r) => !primary.includes(r)) : [];
  if (hasReadySense) {
    if (primary.some((r) => r.state === "error")) return "completed_with_error";
    if (auxiliary.some((r) => r.state === "error")) return "failed";
    if (primary.some((r) => r.state === "needs_credentials") || auxiliary.some((r) => r.state === "needs_credentials")) return "completed_with_credential_gap";
    if (primary.some((r) => r.state === "pending") || auxiliary.some((r) => r.state === "pending")) return "completed_with_pending";
    return "completed";
  }
  const basis = primary.length ? primary : records;
  if (basis.some((r) => r.state === "needs_credentials")) return "needs_credentials";
  if (basis.some((r) => r.state === "pending")) return "pending";
  if (basis.some((r) => r.state === "error")) return "failed";
  if (auxiliary.some((r) => r.state === "error")) return "failed";
  if (auxiliary.some((r) => r.state === "needs_credentials")) return "completed_with_credential_gap";
  if (auxiliary.some((r) => r.state === "pending")) return "completed_with_pending";
  return "completed";
}

async function processPulledHit(ctx: VerbContext, caller: "scan" | "monitor", hit: OvercastRecord): Promise<ProcessHitResult> {
  const ref = hitFetchRef(hit);
  if (!ref) {
    const label = caller === "scan"
      ? `pull hit ${hit.id} has no media.ref or url`
      : `scan hit has no fetchable ref or url: ${String((hit.payload as Record<string, unknown>)?.title ?? hitKey(hit))}`;
    return { records: [err(caller, label)], outcome: "failed", submittedRemote: 0 };
  }

  const explicitPipe = ctx.opts.pipe ? String(ctx.opts.pipe) : undefined;
  const directPlan = directSensePlan(ctx, ref);
  const records: OvercastRecord[] = [];
  let submittedRemote = 0;

  // Every evidence record derived from this hit (capture + sensed transcripts /
  // detections) inherits the originating post's provenance — a direct-pipe or
  // auto-sense transcript must trace back to the tweet just like a standalone
  // `listen` does. Stamped once at the return boundary so no producer path
  // (pipeSense's direct runWatch/runListen, automation chains) can miss it.
  const prov = scanHitProvenance(hit);
  const finish = (): ProcessHitResult => {
    for (const r of records) {
      if (r.verb === "capture" || r.verb === "image" || PRIMARY_SENSE_VERBS.includes(r.verb)) stampProvenance(r, prov);
    }
    return { ref, records, outcome: classifyHitRecords(records), submittedRemote };
  };

  if (directPlan) {
    submittedRemote++;
    const hasRemainingAutoSense = directPlan.remainingAutoSense.length > 0;
    const sensedRecords = directPlan.explicitPipe
      ? await runExplicitPipeWithPolicy(ctx, caller, directPlan.verb, ref)
      : await runAutomationChain(ctx, caller, ref, [directPlan.verb], { autoIndex: !hasRemainingAutoSense });
    records.push(...(sensedRecords.length ? sensedRecords : [err(caller, `direct ${directPlan.verb} produced no records for ${ref}`)]));

    if (hasRemainingAutoSense) {
      const cap = await captureRef(ctx, ref, { sourceType: hitSourceType(hit) });
      records.push(cap);
      if (cap.state !== "error" && cap.state !== "needs_credentials" && cap.media?.ref) {
        const remainingRecords = await runAutomationChain(ctx, caller, cap.media.ref, directPlan.remainingAutoSense);
        records.push(...(remainingRecords.length ? remainingRecords : [err(caller, `automation produced no records for ${cap.media.ref}`)]));
      }
    }
    return finish();
  }

  const cap = await captureRef(ctx, ref, { sourceType: hitSourceType(hit) });
  records.push(cap);
  if (cap.state !== "error" && cap.state !== "needs_credentials" && cap.media?.ref) {
    // sense the capture when it's A/V OR a still image: an image capture (an
    // Instagram/webcam still) must feed the configured auto_sense chain — exif /
    // verify / see — even though the DEFAULT sense (watch) is A/V-only. An
    // explicit --pipe always runs.
    if (explicitPipe || isSenseableMedia(cap.media.ref) || isImage(cap.media.ref)) {
      if (explicitPipe) {
        const sensedRecords = await runExplicitPipeWithPolicy(ctx, caller, explicitPipe, cap.media.ref);
        records.push(...(sensedRecords.length ? sensedRecords : [err(caller, `explicit --pipe ${explicitPipe} produced no records for ${cap.media.ref}`)]));
      } else {
        const automated = await runSetupAutomation(ctx, caller, cap.media.ref);
        if (automated.length) records.push(...automated);
        // no configured chain → default watch, but only for A/V; a still image
        // has no default sense (forensic/image senses must be set via auto_sense).
        else if (isAv(cap.media.ref)) records.push(...await runDefaultWatchWithPolicy(ctx, caller, cap.media.ref));
      }
    }
  }
  return finish();
}

export const scanVerb: VerbSpec = {
  name: "scan",
  group: "osint",
  summary: "Sweep sources, or local case media/indexes when no sources exist; emit scan.hit records (--pull to capture+sense).",
  description:
    "Enumerates each enabled source by its bound ref (channel/handle/hashtag/keyword); an explicit " +
    "--query overrides, and the active target is the fallback when a source has no ref. With --pull, " +
    "each hit uses the same media.ref/payload.url, capture, sense, and failure semantics as monitor. If the case has no " +
    "enabled external sources, scan falls back to local case media/indexes and can run a face-index " +
    "search when an image target and face-analysis index are available.",
  args: [],
  flags: [
    { name: "query", summary: "Ad-hoc keyword search across sources", type: "string" },
    { name: "source", summary: "Restrict to source ids/types (comma list)", type: "string" },
    { name: "since", summary: "Only items newer than e.g. 24h, 2026-06-01", type: "string" },
    { name: "limit", summary: "Max hits per source; with --local, max local visual DB candidates", type: "number" },
    { name: "local", summary: "Scan local case media/indexes instead of external sources", type: "boolean" },
    { name: "pull", summary: "Auto-capture + sense each hit", type: "boolean" },
    { name: "pipe", summary: "Sense to run on pulled hits (watch|listen|face)", type: "string" },
    { name: "describe", summary: "With --pipe listen: full audio-scene describe (not speech-only)", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "scan.hit",
  providerKey: "scan",
  run: async (ctx) => {
    const flagError = scanFlagError(ctx);
    if (flagError) return [flagError];
    if (ctx.opts.local === true) return scanLocalCase(ctx);
    if (!ctx.opts.source && !ctx.opts.query && resolveSources(ctx.case, undefined).length === 0) return scanLocalCase(ctx);
    const hits = await enumerateAll(ctx);
    if (!ctx.opts.pull) return hits;

    // --pull: capture + sense each non-error hit. Persist the enumerated hits
    // before downstream progress/sense checkpoints so interrupted pulls leave a
    // coherent case log.
    const out: OvercastRecord[] = hits.map((hit) => checkpoint(ctx, hit));
    out.push(scanProgress(ctx, {
      stage: "started",
      total_hits: hits.filter((h) => h.state !== "error" && h.state !== "needs_credentials").length,
      requested_limit: ctx.opts.limit ?? null,
      pipe: ctx.opts.pipe ? String(ctx.opts.pipe) : null,
      note: "scan --pull writes progress records as each hit is submitted/processed",
    }));
    let processed = 0;
    let submitted_remote = 0;
    let completed = 0;
    let pending = 0;
    let skipped_duplicates = 0;
    const pullSeen = new Set<string>();
    const enumerate_errors = hits.filter((h) => h.state === "error").length;
    const enumerate_cred_gaps = hits.filter((h) => h.state === "needs_credentials").length;
    let failed = enumerate_errors;
    let process_cred_gaps = enumerate_cred_gaps;
    for (const hit of hits) {
      // skip enumerate FAILURES (error + needs_credentials) — they're not items to
      // capture/sense, matching monitorPass.
      if (hit.state === "error" || hit.state === "needs_credentials") continue;
      const key = hitProcessKey(hit);
      if (pullSeen.has(key)) {
        skipped_duplicates++;
        continue;
      }
      pullSeen.add(key);
      try {
        const item = await processPulledHit(ctx, "scan", hit);
        submitted_remote += item.submittedRemote;
        if (item.submittedRemote) out.push(scanProgress(ctx, { stage: "submitted", ref: item.ref, via: "direct-url", submitted_remote, completed, pending, failed, process_cred_gaps, enumerate_errors, enumerate_cred_gaps }));
        const saved = item.records.map((r) => checkpoint(ctx, r));
        out.push(...saved);
        if (item.outcome === "pending" || item.outcome === "completed_with_pending") pending++;
        else if (item.outcome === "needs_credentials") process_cred_gaps++;
        else if (item.outcome === "completed_with_credential_gap") {
          completed++;
          process_cred_gaps++;
        }
        else if (item.outcome === "failed") failed++;
        else if (item.outcome === "completed_with_error") {
          completed++;
          failed++;
        }
        else completed++;
        processed++;
        out.push(scanProgress(ctx, { stage: "processed", ref: item.ref ?? null, hit: hit.id, processed, submitted_remote, completed, pending, failed, process_cred_gaps, enumerate_errors, enumerate_cred_gaps, outcome: item.outcome }, scanProgressState(item.outcome)));
      } catch (e) {
        // a provider timeout / spawn failure rejects — record it and keep pulling
        // the remaining hits instead of aborting the whole scan.
        failed++;
        processed++;
        const ref = hitFetchRef(hit);
        const saved = checkpoint(ctx, err("scan", `pull of ${ref ?? hit.id} failed: ${(e as Error).message}`));
        out.push(saved);
        out.push(scanProgress(ctx, { stage: "processed", ref: ref ?? null, hit: hit.id, processed, submitted_remote, completed, pending, failed, process_cred_gaps, enumerate_errors, enumerate_cred_gaps }, "error"));
      }
    }
    // The terminal pull_progress summary is the authoritative outcome for the run:
    // it folds partial success → ready, total failure → error, and credential gaps
    // with no completions → needs_credentials. Mark every per-hit / per-stage error &
    // credential-gap record it subsumes as non_fatal so the CLI exit code follows the
    // summary, not a single partial failure within an otherwise-successful pull. The
    // summary is built AFTER this sweep so it stays untagged and drives the code.
    for (const rec of out) {
      if (rec.state === "error" || rec.state === "needs_credentials") {
        rec.meta = { ...rec.meta, non_fatal: true };
      }
    }
    out.push(scanProgress(ctx, { stage: "complete", processed, submitted_remote, completed, pending, failed, process_cred_gaps, enumerate_errors, enumerate_cred_gaps, skipped_duplicates }, failed && completed === 0 ? "error" : process_cred_gaps && completed === 0 ? "needs_credentials" : pending && completed === 0 ? "pending" : "ready"));
    return out;
  },
};

// ---- capture ---------------------------------------------------------------

/** A collision-resistant output filename for a URL download. Many URLs share a
 *  basename (e.g. every `youtube.com/watch?v=…` → `watch`), so distinguish by a
 *  short hash of the full URL while preserving any extension. */
function uniqueName(url: string): string {
  const base = basename(url.split("?")[0]) || "download";
  const h = createHash("sha1").update(url).digest("hex").slice(0, 8);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}_${h}${base.slice(dot)}` : `${base}_${h}`;
}

/** Best-effort source provider for an ad-hoc URL by host. Video hosts map to
 *  their downloaders; anything else to the generic `web` page fetcher. */
export function hostSourceType(url: string): string {
  // match on the parsed hostname — a substring regex over the whole URL misses
  // bare apex domains (x.com has no subdomain, so `(^|\.)x\.com` never fired)
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "web";
  }
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "youtube";
  // twimg.com = X's media CDN — the x provider downloads those directly
  if (/(^|\.)(x\.com|twitter\.com|twimg\.com)$/.test(host)) return "x";
  // platforms with a dedicated source provider — route to it (CDN download or
  // yt-dlp) instead of the generic `web` HTML fetcher, like the hosts above.
  // Include the Instagram-only CDN host (cdninstagram) that scan hits point
  // media.ref at, so an ad-hoc capture of one downloads the asset via
  // instagram.sh's curl path. fbcdn.net is deliberately NOT routed here — it's a
  // SHARED Meta CDN (Instagram AND Facebook), so a bare fbcdn URL would mislabel
  // Facebook assets as source:instagram; the IG scan→capture flow routes by the
  // hit's meta.provider (hitSourceType), not by host, so it's unaffected.
  if (/(^|\.)(instagram\.com|cdninstagram\.com)$/.test(host)) return "instagram";
  if (/(^|\.)t\.me$/.test(host)) return "telegram";
  // A direct Internet Archive media DOWNLOAD (a gdelttv clip's media.ref, e.g.
  // /download/<id>/<id>.mp4?start=…) → gdelttv.sh's curl+content-type fetch. Other
  // archive.org URLs (detail pages, books, non-media items) fall through to the
  // web fetcher so their provenance isn't mislabeled source:gdelttv.
  if (/(^|\.)archive\.org$/.test(host)) {
    try {
      const p = new URL(url).pathname;
      if (/^\/download\//.test(p) && /\.(mp4|m4v|mov|webm|mkv|ts|mp3|m4a|wav|jpe?g|png|webp|gif)$/i.test(p)) {
        return "gdelttv";
      }
    } catch {
      /* malformed → web */
    }
    return "web";
  }
  // video hosts yt-dlp handles but that lack a dedicated source → the generic
  // `dl` downloader, so `capture <url>` pulls the video instead of curling an
  // HTML page (the `web` fallback). Keep in sync with dl.sh's coverage note.
  if (
    /(^|\.)(rumble\.com|bitchute\.com|odysee\.com|vk\.com|vkvideo\.ru|bilibili\.com|b23\.tv|vimeo\.com|dailymotion\.com|dai\.ly|reddit\.com|redd\.it|twitch\.tv|kick\.com|streamable\.com|facebook\.com|fb\.watch)$/.test(
      host,
    )
  ) {
    return "dl";
  }
  return "web";
}

/** Whether a captured artifact is audio/video the default watch/listen senses
 *  can process — so a `web` hit captured as an .html page isn't auto-routed to
 *  tinycloud watch (which would just error every pass). Shares the single
 *  audio/video allowlist with index/face intake (media-ref.ts) so the
 *  auto-route gate and the registration gate can't drift apart. */
const isSenseableMedia = isAv;

/** The source provider type a scan.hit came from (from its meta.provider). */
function hitSourceType(rec: OvercastRecord | undefined): string | undefined {
  const prov = rec?.meta?.provider;
  if (typeof prov === "string" && prov.startsWith("source:")) {
    return prov.slice("source:".length);
  }
  return undefined;
}

export async function captureRef(
  ctx: VerbContext,
  ref: string,
  opts: { sourceType?: string; out?: string } = {},
): Promise<OvercastRecord> {
  const outDir = ctx.case.mediaDir;
  // a local file → copy into the case (fixture/folder sources, ad-hoc paths).
  // Use a collision-resistant name (like the URL path) so two distinct sources
  // sharing a basename don't clobber each other / share a capture_id.
  if (existsSync(ref)) {
    const dest = opts.out ? opts.out : join(outDir, uniqueName(ref));
    mkdirSync(dirname(dest), { recursive: true }); // a nested --out needs its parent first
    try {
      copyFileSync(ref, dest);
    } catch (e) {
      return err("capture", `copy failed: ${(e as Error).message}`);
    }
    return makeRecord({
      verb: "capture",
      format: "json",
      payload: { capture_id: "cap_" + basename(dest), path: dest, kind: "file", source: "local", source_ref: ref },
      media: { ref: dest },
      meta: { provider: "capture:local", case: ctx.case.dir },
      state: "ready",
    });
  }
  // only fetch things that actually look like URLs — a bogus/unresolved ref
  // (e.g. a scan.hit id that didn't resolve) must NOT be shipped to yt-dlp.
  if (!/^https?:\/\//i.test(ref)) {
    return err("capture", `could not resolve ref to media: ${ref} (not a local path or URL)`);
  }
  // Prefer the originating source provider (from the scan.hit); only fall back
  // to host-sniffing for ad-hoc URLs with no known source. A generic host maps
  // to the `web` page fetcher, not yt-dlp.
  const type = opts.sourceType ?? hostSourceType(ref);
  const desc = builtinDescriptor(type);
  if (!desc) {
    return err("capture", `no source provider can fetch ${ref} (source type '${type}')`);
  }
  const dest = opts.out ? opts.out : join(outDir, uniqueName(ref));
  mkdirSync(dirname(dest), { recursive: true }); // a nested --out needs its parent first
  return fetchSource(desc, { url: ref, out: dest, signal: ctx.signal });
}

async function pipeSense(
  ctx: VerbContext,
  caller: string,
  verb: string,
  ref: string,
): Promise<OvercastRecord | undefined> {
  if (verb === "watch" || verb === "listen") {
    const binding = providerBinding(ctx, verb);
    // dispatch the same way the top-level verbs do, so a bound custom provider's
    // record-mapping isn't bypassed (custom → pass-through; default → mapper).
    // Use the same generous 15-min timeout the standalone verbs give exec
    // providers, so long media doesn't time out under pull/monitor.
    // honor --describe (listen audio-scene) when piping, matching `listen --describe`
    const describe = ctx.opts.describe === true;
    const extraArgs = verb === "listen" && describe ? ["--describe"] : [];
    let r: OvercastRecord;
    if (isCustomBinding(binding)) {
      // pass the case media dir + system ffmpeg/ffprobe (like see/enhance), so a
      // bound provider can extract frames / write into .overcast/media here too.
      r = await runBoundProvider(verb, binding!, ref, {
        env: providerEnv(ctx.case.mediaDir),
        extraArgs,
        signal: ctx.signal,
        timeoutMs: 15 * 60_000,
      });
    } else if (verb === "watch") {
      r = await runWatch(ref, { run: binding?.run, signal: ctx.signal });
    } else {
      r = await runListen(ref, { run: binding?.run, describe, signal: ctx.signal });
    }
    r.meta = { ...r.meta, case: ctx.case.dir };
    return r;
  }
  if (verb === "face") {
    const [rec] = await faceVerb.run({ ...ctx, input: ref, rest: [], opts: {} });
    return rec;
  }
  if (verb === "exif" || verb === "verify") {
    const [rec] = await (verb === "exif" ? exifVerb : verifyVerb).run({ ...ctx, input: ref, rest: [], opts: {} });
    return rec;
  }
  // an unknown --pipe value (typo, or see/enhance) must surface, not silently
  // produce nothing — labelled with the ACTIVE command (monitor/scan).
  return err(caller, `unknown --pipe '${verb}' (expected watch | listen | face | exif | verify)`);
}

async function runAutomationSense(ctx: VerbContext, caller: string, verb: string, ref: string): Promise<OvercastRecord> {
  if (verb === "watch" || verb === "listen") {
    const rec = await pipeSense(ctx, caller, verb, ref);
    return rec ?? err(caller, `sense '${verb}' produced no record`);
  }
  if (verb === "see") {
    const opts = autoSeeOpts(ctx);
    const [rec] = await seeVerb.run({ ...ctx, input: ref, rest: [], opts });
    return rec;
  }
  if (verb === "face") {
    const [rec] = await faceVerb.run({ ...ctx, input: ref, rest: [], opts: {} });
    return rec;
  }
  if (verb === "enhance") {
    const [rec] = await enhanceVerb.run({ ...ctx, input: ref, rest: [], opts: {} });
    return rec;
  }
  if (verb === "exif" || verb === "verify") {
    const [rec] = await (verb === "exif" ? exifVerb : verifyVerb).run({ ...ctx, input: ref, rest: [], opts: {} });
    return rec;
  }
  return err(caller, `unknown automated sense '${verb}'`);
}

async function runExplicitPipeWithPolicy(ctx: VerbContext, caller: string, verb: string, ref: string): Promise<OvercastRecord[]> {
  const sensed = await pipeSense(ctx, caller, verb, ref);
  if (!sensed) return [];
  const out = [sensed, ...automatedFindings(ctx, sensed, `${caller}:${verb}`)];
  if (sensed.state !== "error" && sensed.state !== "needs_credentials") {
    const indexedRef = sensed.media?.ref ?? ref;
    out.push(...await autoIndexNewMedia(ctx, indexedRef, { skipLocalWatch: hasUsableWatch([sensed], indexedRef) }));
  }
  return out;
}

/** Chain-inline finding triggers (scan/monitor sense chains). The shared
 *  implementation lives in signals/triggers.ts — the persist seam re-runs it
 *  for standalone verb runs; dedup keeps the two passes idempotent. */
function automatedFindings(ctx: VerbContext, rec: OvercastRecord, trigger: string, pending: OvercastRecord[] = []): OvercastRecord[] {
  return evaluateTriggers({
    fresh: [rec],
    existing: ctx.case.records(),
    pending,
    targets: listTargets(ctx.case),
    policy: resolveFindingsPolicy(loadSetup(ctx.case)),
    via: trigger,
  });
}

async function autoIndexNewMedia(ctx: VerbContext, ref: string, opts: { skipLocalWatch?: boolean } = {}): Promise<OvercastRecord[]> {
  const setup = loadSetup(ctx.case);
  if (setup?.automation?.auto_index_new !== true) return [];
  const out: OvercastRecord[] = [];
  for (const index of setup.indexes ?? []) {
    if (!index.id) continue;
    const signals = new Set([...(index.default_signals ?? []), ...(setup.default_signals[index.id] ?? [])]);
    if (!signals.has("index add")) continue;
    const recs = await indexVerb.run({
      ...ctx,
      input: "add",
      rest: [ref],
      opts: {
        to: index.id,
        type: index.type,
        ...(opts.skipLocalWatch ? { "__skip-local-watch": true } : {}),
      },
    });
    for (const rec of recs) {
      if (rec.verb === "index" && !rec.media?.ref) rec.media = { ref };
    }
    out.push(...recs);
  }
  return out;
}

async function retryAuxiliaryForSeenHit(ctx: VerbContext, hit: OvercastRecord): Promise<OvercastRecord[]> {
  if (loadSetup(ctx.case)?.automation?.auto_index_new !== true) return [];
  const refs = priorSuccessfulSenseRefs(ctx, hit);
  const ref = refs.find((candidate) => hasRetryableIndexGap(ctx, candidate));
  if (!ref) return [];
  return autoIndexNewMedia(ctx, ref, { skipLocalWatch: true });
}

function priorSuccessfulSenseRefs(ctx: VerbContext, hit: OvercastRecord): string[] {
  const ref = hitFetchRef(hit);
  if (!ref) return [];
  const records = ctx.case.records().slice().reverse();
  const cap = records.find((r) =>
    r.verb === "capture" &&
    r.state !== "error" &&
    r.state !== "needs_credentials" &&
    typeof r.media?.ref === "string" &&
    (r.media.ref === ref ||
      (r.payload as Record<string, unknown> | undefined)?.url === ref ||
      (r.payload as Record<string, unknown> | undefined)?.source_ref === ref)
  );
  const mediaRef = cap?.media?.ref ?? ref;
  const sensed = records.find((r) =>
    PRIMARY_SENSE_VERBS.includes(r.verb) &&
    r.state !== "error" &&
    r.state !== "needs_credentials" &&
    r.state !== "pending" &&
    (r.media?.ref === mediaRef || r.media?.ref === ref)
  );
  if (!sensed?.media?.ref) return [];
  return Array.from(new Set([mediaRef, sensed.media.ref]));
}

function hasRetryableIndexGap(ctx: VerbContext, ref: string): boolean {
  return ctx.case.records().some((r) =>
    r.verb === "index" &&
    (r.state === "needs_credentials" || r.state === "pending") &&
    recordRef(r) === ref
  );
}

function recordRef(rec: OvercastRecord): string | undefined {
  const payload = rec.payload && typeof rec.payload === "object" ? rec.payload as Record<string, unknown> : {};
  return rec.media?.ref ??
    (typeof payload.file === "string" ? payload.file : undefined) ??
    (typeof payload.ref === "string" ? payload.ref : undefined) ??
    (typeof payload.path === "string" ? payload.path : undefined);
}

async function runAutomationChain(
  ctx: VerbContext,
  caller: string,
  ref: string,
  chain: string[],
  opts: { autoIndex?: boolean } = {},
): Promise<OvercastRecord[]> {
  if (!chain.length) return [];
  const out: OvercastRecord[] = [];
  let currentRef = ref;
  for (const verb of chain) {
    const rec = await runAutomationSense(ctx, caller, verb, currentRef);
    rec.meta = { ...rec.meta, case: ctx.case.dir, triggered_by: `${caller}:automation` };
    out.push(rec, ...automatedFindings(ctx, rec, `${caller}:${verb}`, out));
    if (rec.state !== "error" && rec.state !== "needs_credentials" && rec.media?.ref) currentRef = rec.media.ref;
  }
  if (opts.autoIndex !== false) {
    out.push(...await autoIndexNewMedia(ctx, currentRef, { skipLocalWatch: hasUsableWatch(out, currentRef) }));
  }
  return out;
}

async function runSetupAutomation(ctx: VerbContext, caller: string, ref: string): Promise<OvercastRecord[]> {
  const setup = loadSetup(ctx.case);
  return runAutomationChain(ctx, caller, ref, setup?.automation?.auto_sense ?? []);
}

function hasUsableWatch(records: OvercastRecord[], ref: string): boolean {
  return records.some((r) =>
    r.verb === "watch" &&
    r.media?.ref === ref &&
    r.state !== "error" &&
    r.state !== "needs_credentials"
  );
}

function autoSeeOpts(ctx: VerbContext): VerbContext["opts"] {
  const profileRun = ctx.profile.providers?.see?.run;
  if (profileRun != null) {
    if (!/detect\.py\b/.test(String(profileRun))) return {};
  } else {
    const setup = loadSetup(ctx.case);
    const choice = setup?.providers?.see?.choice;
    const run = String(providerBinding(ctx, "see")?.run ?? "");
    if (choice !== "owl-local" && !/detect\.py\b/.test(run)) return {};
  }
  const labels = listTargets(ctx.case)
    .filter((t) => t.kind !== "image" && !isTargetClosed(t))
    .map((t) => t.value.trim())
    .filter(Boolean);
  return labels.length ? { detect: labels.join(", ") } : {};
}

async function runDefaultWatchWithPolicy(ctx: VerbContext, caller: string, ref: string): Promise<OvercastRecord[]> {
  const sensed = await pipeSense(ctx, caller, "watch", ref);
  if (!sensed) return [];
  const out = [sensed, ...automatedFindings(ctx, sensed, `${caller}:watch`)];
  if (sensed.state !== "error" && sensed.state !== "needs_credentials") {
    out.push(...await autoIndexNewMedia(ctx, sensed.media?.ref ?? ref, { skipLocalWatch: true }));
  }
  return out;
}

// sniffExt (magic-byte extension) lives in media/fetch.ts — shared with the
// see URL-download path so piped and downloaded bytes classify identically.

/** `capture -` — ingest bytes piped on stdin into the case as a capture record. */
async function captureStdin(ctx: VerbContext, out?: string): Promise<OvercastRecord> {
  if (process.stdin.isTTY) return err("capture", "capture - expects media piped on stdin (none detected)");
  const buf: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
  if (buf.length === 0) return err("capture", "capture -: stdin was empty");
  const hash = createHash("sha1").update(buf).digest("hex").slice(0, 8);
  const dest = out ?? join(ctx.case.mediaDir, `stdin-${hash}${sniffExt(buf)}`);
  try {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
  } catch (e) {
    return err("capture", `stdin write failed: ${(e as Error).message}`);
  }
  return makeRecord({
    verb: "capture",
    format: "json",
    payload: { capture_id: "cap_" + basename(dest), path: dest, kind: "file", source: "stdin", bytes: buf.length },
    media: { ref: dest },
    meta: { provider: "capture:stdin", case: ctx.case.dir },
    state: "ready",
  });
}

export const captureVerb: VerbSpec = {
  name: "capture",
  group: "osint",
  summary: "Fetch a resource (URL / scan.hit / local path) into the case as a capture record.",
  description:
    "Acquires media/content into .overcast/media/: a local path is copied in; a URL is downloaded via " +
    "the matching source provider. Emits a capture record with a capture_id usable by the senses.",
  args: [{ name: "ref", summary: "URL, scan.hit id, local path, or - for stdin", required: true }],
  flags: [
    { name: "index", summary: "Embed into the case index after capture", type: "boolean" },
    { name: "out", summary: "Output location override", type: "string" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "capture",
  providerKey: "capture",
  run: async (ctx) => {
    if (!ctx.input) return [err("capture", "capture requires a ref (URL/path/scan.hit id, or - for stdin)")];
    // `-` → ingest stdin (a piped clip/image) into the case.
    if (ctx.input === "-") return [await captureStdin(ctx, ctx.opts.out ? String(ctx.opts.out) : undefined)];
    // archive:<bucket>/<item> → pull a COPY of archived media into this case,
    // with provenance back to the bucket (and sha256 dedup against a prior pull).
    if (ctx.input.startsWith(ARCHIVE_REF_PREFIX)) {
      const resolved = resolveMediaRef(ctx.case, ctx.input, ctx.home);
      if (resolved.error) return [err("capture", resolved.error)];
      // never copy an in-flight/failed item's partial file — the bucket record's
      // state gates the pull like it gates the senses
      if (resolved.record && !isReady(resolved.record)) {
        return [err("capture", `${ctx.input}: record ${resolved.record.id} isn't ready (state=${resolved.record.state ?? "?"})`)];
      }
      let sha: string | undefined;
      try {
        sha = await sha256File(resolved.ref);
      } catch {
        /* dedup is best-effort; the copy below surfaces a real read error */
      }
      if (sha) {
        const existing = ctx.case.records().find((r) => {
          if (r.verb !== "capture" || !isReady(r) || !r.payload || typeof r.payload !== "object") return false;
          return (r.payload as Record<string, unknown>).sha256 === sha;
        });
        if (existing) {
          const p = existing.payload as Record<string, unknown>;
          return [makeRecord({
            verb: "capture",
            format: "json",
            payload: { already_present: true, capture_id: p.capture_id, record: existing.id, sha256: sha, source: "archive", source_ref: ctx.input },
            media: existing.media,
            meta: { provider: "capture:archive", case: ctx.case.dir, archive: resolved.archive, transient: true },
            state: "ready",
          })];
        }
      }
      const archiveCap = await captureRef(ctx, resolved.ref, { out: ctx.opts.out ? String(ctx.opts.out) : undefined });
      if (archiveCap.payload && typeof archiveCap.payload === "object") {
        const p = archiveCap.payload as Record<string, unknown>;
        p.source = "archive";
        p.source_ref = ctx.input;
        if (sha) p.sha256 = sha;
        p.origin = {
          ...(p.origin && typeof p.origin === "object" ? (p.origin as Record<string, unknown>) : {}),
          bucket: resolved.archive,
          ...(resolved.recordId ? { record: resolved.recordId } : {}),
        };
      }
      archiveCap.meta = { ...archiveCap.meta, archive: resolved.archive };
      // carry the bucket item's originating-post provenance (source_url/author/
      // text) onto the pulled case copy — the owning capture lives in the BUCKET,
      // so look it up there (same as a sense on the ref via provenanceCase)
      stampProvenance(archiveCap, provenanceFromCapture(provenanceCase(ctx.case, resolved.archive, ctx.home), resolved.ref));
      return [archiveCap];
    }
    // resolve a scan.hit record id → its media ref (and source provider). Fall
    // back to payload.url when the hit has a url but no media field (matches
    // hitKey/hitsToRecords).
    let ref = ctx.input;
    const rec = ctx.case.recordById(ctx.input);
    if (rec?.media?.ref) ref = rec.media.ref;
    else if (rec && typeof rec.payload === "object") {
      const url = (rec.payload as Record<string, unknown>).url;
      if (typeof url === "string" && url) ref = url;
    }
    const cap = await captureRef(ctx, ref, {
      sourceType: hitSourceType(rec),
      out: ctx.opts.out ? String(ctx.opts.out) : undefined,
    });
    // stamp where it came from (tweet/video URL, author, text, date) so a later
    // match/finding on this file traces back to the originating post
    stampProvenance(cap, scanHitProvenance(rec));
    // --index: flag the artifact for memory recall. The case store IS the local
    // memory index (records are written there), so this records the intent.
    if (ctx.opts.index === true && typeof cap.payload === "object") {
      (cap.payload as Record<string, unknown>).indexed = true;
    }
    return [cap];
  },
};

// ---- monitor (--once) ------------------------------------------------------

/** Parse a cadence like "15m"/"6h"/"30s"/"1d"/"2w" into milliseconds. Units
 *  match the shared s/m/h/d/w duration grammar (parseSince). */
export function parseInterval(s: string): number | undefined {
  const m = s.match(/^(\d+)\s*([smhdw])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2];
  return n * (u === "s" ? 1e3 : u === "m" ? 60e3 : u === "h" ? 3600e3 : u === "d" ? 86400e3 : 7 * 86400e3);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    if (ms <= 0) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

/** One monitor pass: enumerate, diff against `seen` (mutated), capture+sense new items. */
async function monitorPass(ctx: VerbContext, seen: Set<string>, ephemeralFails: Map<string, number>): Promise<OvercastRecord[]> {
  const hits = await enumerateAll(ctx, "monitor");
  // a real hit is a scan.hit (ready/unstated); error AND needs_credentials
  // enumerate results are failures, not items to capture/count/mark seen.
  const failedHits = hits.filter((h) => h.state === "error" || h.state === "needs_credentials");
  const realHits = hits.filter((h) => h.state !== "error" && h.state !== "needs_credentials");
  const out: OvercastRecord[] = [...failedHits];
  const newHits: OvercastRecord[] = [];
  let newCount = 0;
  let procErrors = 0; // hard capture/sense failures this pass
  let procCredGaps = 0; // capture/sense failures that need setup (retry-able)
  const passSeen = new Set<string>();
  for (const hit of realHits) {
    // Two dedup keys by design: the cross-pass `seen` store uses hitKey (the
    // hit's stable logical identity — its url) so novelty detection can't be
    // shifted by run-varying fetch artifacts (e.g. a lens thumbnail that
    // decodes on one pass and not the next). hitProcessKey (identity + fetch
    // ref) only gates WITHIN-pass fan-out, where finer granularity is safe.
    const key = hitKey(hit);
    const processKey = hitProcessKey(hit);
    // A hit in `seen` is done — skip it. An ephemeral hit (a webcam's current
    // still) is NOT added to `seen` on success, so it re-captures every pass; it
    // only lands in `seen` once monitor GIVES UP on it (too many consecutive hard
    // failures, below), and from then on this check must stop it like any other.
    const ephemeral = isEphemeralHit(hit);
    if (seen.has(key)) {
      const retry = await retryAuxiliaryForSeenHit(ctx, hit);
      out.push(...retry);
      if (retry.some((r) => r.state === "error")) procErrors++;
      if (retry.some((r) => r.state === "needs_credentials")) procCredGaps++;
      continue;
    }
    if (passSeen.has(processKey)) continue;
    passSeen.add(processKey);
    out.push(hit);
    // Classify the outcome:
    //  - transient (needs_credentials / pending): a recoverable gap → leave the
    //    item UNSEEN so a later pass retries once it's fixed.
    //  - hard error (e.g. piping `watch` at captured HTML): PERMANENT → mark seen
    //    so `monitor --every` doesn't reprocess it forever, and flag the pass.
    let outcome: HitProcessOutcome = "failed";
    try {
      const item = await processPulledHit(ctx, "monitor", hit);
      outcome = item.outcome;
      out.push(...item.records);
    } catch (e) {
      // execCapture rejects on provider timeout / spawn failure — convert it to a
      // per-hit error so the loop keeps processing the rest (and --every keeps
      // looping) instead of throwing out of the whole pass.
      outcome = "failed";
      out.push(err("monitor", `processing ${hitFetchRef(hit) ?? hit.id} failed: ${(e as Error).message}`));
    }
    if (outcome === "pending" || outcome === "needs_credentials") {
      if (outcome === "needs_credentials") procCredGaps++;
      continue;
    }
    // a hard error is permanent → mark seen (no infinite retry) but DON'T count it
    // as a successfully-ingested new item; the summary reports it via process_errors.
    if (!ephemeral) {
      seen.add(key);
    } else if (outcome === "failed" || outcome === "completed_with_error") {
      // ephemeral hits normally skip `seen` so they re-capture every pass — but a
      // hit stuck on a HARD error (capture `failed`, or a sense that errors every
      // pass → `completed_with_error`) must not re-run the pull pipeline forever.
      // Count CONSECUTIVE hard-error passes and give up (mark seen) past the cap.
      // completed_with_pending / _credential_gap are recoverable (a sub-sense is
      // transiently pending / needs creds), so they fall through to the reset.
      const n = (ephemeralFails.get(key) ?? 0) + 1;
      if (n >= EPHEMERAL_MAX_FAILS) {
        seen.add(key);
        ephemeralFails.delete(key);
      } else {
        ephemeralFails.set(key, n);
      }
    } else {
      // this pass captured successfully → the resource is alive; reset its run.
      ephemeralFails.delete(key);
    }
    if (outcome === "failed") procErrors++;
    else if (outcome === "completed_with_error") {
      procErrors++;
      newCount++;
      newHits.push(hit);
    }
    else if (outcome === "completed_with_credential_gap") {
      procCredGaps++;
      newCount++;
      newHits.push(hit);
    }
    else { newCount++; newHits.push(hit); }
  }
  // summary state reflects BOTH enumerate-time and capture/sense failures: a hard
  // error → error; only setup gaps → needs_credentials; else ready.
  const hardErrors = failedHits.filter((h) => h.state === "error").length + procErrors;
  const credGaps = failedHits.filter((h) => h.state === "needs_credentials").length + procCredGaps;
  out.unshift(
    makeRecord({
      verb: "monitor",
      format: "json",
      payload: {
        new_items: newCount,
        total_hits: realHits.length,
        seen_size: seen.size,
        source_errors: failedHits.length,
        process_errors: procErrors,
        process_cred_gaps: procCredGaps,
      },
      meta: { provider: "monitor", case: ctx.case.dir },
      state: hardErrors ? "error" : credGaps ? "needs_credentials" : "ready",
      error:
        hardErrors || credGaps
          ? `${hardErrors} failed, ${credGaps} need credentials (sources + capture/sense)`
          : undefined,
    }),
  );
  // --brief: a short summary record of the new batch (only the genuinely new
  // items found this pass, not the first N of all enumerated hits).
  if (ctx.opts.brief === true && newCount > 0) {
    const titles = newHits
      .filter((h) => typeof h.payload === "object")
      .map((h) => (h.payload as Record<string, unknown>).title)
      .filter(Boolean);
    out.push(makeRecord({ verb: "brief", format: "md", payload: { report: `## Monitor — ${newCount} new\n${titles.map((t) => `- ${t}`).join("\n")}`, total: newCount }, meta: { case: ctx.case.dir }, state: "ready" }));
  }
  return out;
}

export const monitorVerb: VerbSpec = {
  name: "monitor",
  group: "osint",
  summary: "scan on a loop; diff against the seen-set; pipe new items into a sense. --once or --every <interval>.",
  description:
    "Enumerates sources, diffs against .overcast/seen.json, and for each NEW item uses the shared scan --pull processor: " +
    "resolve media.ref/payload.url, capture when needed, then run explicit --pipe or setup automation/default watch. " +
    "Hard processing failures are surfaced and marked seen; pending/credential gaps remain retryable. " +
    "--once = single diff pass (scheduler-friendly). --every <15m|6h|…> = continuous blocking loop " +
    "(run under tmux; Ctrl-C to stop); each pass streams its records. --brief summarizes the new batch; " +
    "--alert <stdout|file> mirrors new records to a sink.",
  args: [],
  flags: [
    { name: "source", summary: "Restrict to source ids/types", type: "string" },
    { name: "query", summary: "Ad-hoc keyword search across sources", type: "string" },
    { name: "since", summary: "Only items newer than e.g. 24h, 2026-06-01", type: "string" },
    { name: "limit", summary: "Max hits per source", type: "number" },
    { name: "pipe", summary: "Sense to run on new items (watch|listen|face)", type: "string" },
    { name: "describe", summary: "With --pipe listen: full audio-scene describe (not speech-only)", type: "boolean" },
    { name: "once", summary: "Single diff pass then exit", type: "boolean" },
    { name: "every", summary: "Continuous loop cadence (e.g. 15m, 6h)", type: "string" },
    { name: "brief", summary: "Summarize the new batch into a brief record", type: "boolean" },
    { name: "alert", summary: "Mirror new records to a file sink (they already stream to stdout)", type: "string" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "scan.hit",
  providerKey: "monitor",
  run: async (ctx) => {
    const everyStr = ctx.opts.every ? String(ctx.opts.every) : "";
    const alertSink = ctx.opts.alert ? String(ctx.opts.alert) : "";
    // honor --json/--format for the streamed records (defaults to JSON-lines,
    // the natural machine format for a continuous loop).
    const streamFmt =
      ctx.opts.json === true || ctx.opts.format === "json"
        ? "json"
        : (ctx.opts.format as string) || "json";
    const streamRender = (r: OvercastRecord): string => {
      let rendered: string;
      if (streamFmt === "md" || streamFmt === "txt") {
        if (typeof r.payload === "string") return redactSecrets(r.payload);
        const p = r.payload as Record<string, unknown>;
        for (const k of ["content", "text", "report"]) {
          if (typeof p[k] === "string" && p[k]) {
            rendered = p[k] as string;
            return redactSecrets(rendered);
          }
        }
      }
      rendered = JSON.stringify(r);
      return redactSecrets(rendered);
    };
    const writeAlert = (recs: OvercastRecord[]) => {
      // FILE sinks only. Records already reach stdout via the normal monitor
      // output (the per-pass stream in --every; runCli printing the returned
      // records in --once), so mirroring them to stdout would double every line.
      if (!alertSink || alertSink === "stdout" || recs.length === 0) return;
      const lines = recs.map((r) => redactSecrets(JSON.stringify(r))).join("\n") + "\n";
      mkdirSync(dirname(alertSink), { recursive: true });
      appendFileSync(alertSink, lines);
    };

    // continuous mode: --every set and NOT --once → blocking loop, stream each pass.
    if (everyStr && ctx.opts.once !== true) {
      const intervalMs = parseInterval(everyStr) ?? 0;
      if (intervalMs <= 0) return [makeRecord({ verb: "monitor", format: "json", payload: { error: `bad --every '${everyStr}'` }, error: "bad interval", state: "error" })];
      const seen = loadSeen(ctx.case);
      const ephemeralFails = loadEphemeralFails(ctx.case);
      // track which ephemeral keys we loaded so a save can tell disk which keys
      // THIS process deleted (success/give-up) vs. never touched — the merge drops
      // ours without resurrecting another process's live failing hits.
      let ephemeralBaseline = new Set(ephemeralFails.keys());
      // cap passes from the env var; a non-numeric/≤0 value is ignored (→ Infinity)
      // rather than becoming NaN, which would make `pass < maxPasses` never run.
      const rawMax = Number(process.env.OVERCAST_MONITOR_MAX_PASSES);
      const maxPasses = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Infinity;
      let pass = 0;
      let errorPasses = 0;
      let credPasses = 0;
      // de-dupe across passes: a recurring record (e.g. the same source-enumerate
      // error every pass) is persisted / streamed / alerted ONCE — not re-written
      // to the case JSONL with a new id, re-streamed, or re-appended to the sink.
      // de-dup key: verb + error + media.ref + a FULL-payload hash (not a 100-char
      // prefix, which conflated two records sharing a long prefix but differing
      // later — the second was then silently never persisted/streamed/alerted).
      const EMITTED_CAP = 10_000;
      const emitted = new Set<string>();
      const recKey = (r: OvercastRecord) =>
        `${r.verb}|${r.error ?? ""}|${(r.media?.ref as string) ?? ""}|` +
        createHash("sha1").update(JSON.stringify(r.payload ?? {})).digest("hex");
      process.stderr.write(`monitor: every ${everyStr}, Ctrl-C to stop\n`);
      while (pass < maxPasses && !ctx.signal?.aborted) {
        pass++;
        // re-sync disk truth into the in-memory seen-set before each pass so a
        // concurrent monitor/scan process's newly-seen keys are honored (not
        // re-captured) — the merge-on-save keeps our additions too.
        for (const k of loadSeen(ctx.case)) seen.add(k);
        // same symmetry for the ephemeral-fail counters, but a CLEAR+refill (not a
        // union) because — unlike the monotone seen-set — this map has keys DELETED
        // on success/give-up. If a concurrent monitor cleared a key (saveEphemeralFails
        // with `deleted`), a stale in-memory entry here would be re-added by our own
        // "our entries win" save, undoing the peer's success/give-up. Reloading disk
        // truth into the SAME Map (monitorPass holds it by reference — mutate, don't
        // reassign) drops the peer-deleted key; the merge-on-save still preserves keys
        // we never touched. Reset the baseline so deletion-tracking matches the reload.
        ephemeralFails.clear();
        for (const [k, v] of loadEphemeralFails(ctx.case)) ephemeralFails.set(k, v);
        ephemeralBaseline = new Set(ephemeralFails.keys());
        let recs: OvercastRecord[];
        try {
          recs = await monitorPass(ctx, seen, ephemeralFails);
        } catch (e) {
          // a thrown pass (timeout, spawn failure) becomes one failed-pass error
          // record — the long-running loop keeps going, it doesn't crash.
          recs = [err("monitor", `monitor pass failed: ${(e as Error).message}`)];
        } finally {
          // persist accumulated seen-set + ephemeral failure counts even if a pass
          // throws mid-way. Both merge with disk so a concurrent writer isn't
          // clobbered; the ephemeral merge must be told which keys we deleted.
          saveSeen(ctx.case, seen);
          const deleted = new Set([...ephemeralBaseline].filter((k) => !ephemeralFails.has(k)));
          saveEphemeralFails(ctx.case, ephemeralFails, deleted);
          // refresh the baseline so a key deleted this pass isn't re-reported as
          // deleted forever (which would fight a later process re-adding it).
          ephemeralBaseline = new Set(ephemeralFails.keys());
        }
        for (const r of recs) {
          // a per-pass monitor SUMMARY is always emitted (consecutive passes can
          // legitimately repeat the same payload); only hit/error records dedupe
          // so a recurring enumerate error isn't re-persisted/re-streamed each pass.
          if (r.verb !== "monitor") {
            const k = recKey(r);
            if (emitted.has(k)) continue;
            emitted.add(k);
            // bound the set: a monitor left running for weeks would otherwise grow
            // without limit. A Set iterates in insertion order, so evicting the
            // oldest is deleting the first value.
            if (emitted.size > EMITTED_CAP) emitted.delete(emitted.values().next().value!);
          }
          ctx.case.writeRecord(r);
          process.stdout.write(streamRender(r) + "\n");
          if (r.verb !== "monitor") writeAlert([r]); // file sink only (no-op for stdout)
        }
        if (recs.some((r) => r.state === "error")) errorPasses++;
        else if (recs.some((r) => r.state === "needs_credentials")) credPasses++;
        if (pass >= maxPasses || ctx.signal?.aborted) break;
        await sleep(intervalMs, ctx.signal);
      }
      // records already streamed + persisted per pass; return a final summary so
      // the exit code reflects whether any pass errored OR needed credentials.
      const failedPasses = errorPasses + credPasses;
      return [
        makeRecord({
          verb: "monitor",
          format: "json",
          payload: { passes: pass, error_passes: errorPasses, cred_passes: credPasses },
          meta: { provider: "monitor", case: ctx.case.dir },
          state: errorPasses ? "error" : credPasses ? "needs_credentials" : "ready",
          error: failedPasses ? `${failedPasses}/${pass} pass(es) failed or need credentials` : undefined,
        }),
      ];
    }

    // single pass (--once or default). Persist the seen-set even if the pass
    // throws mid-way, so accumulated progress isn't lost.
    const seen = loadSeen(ctx.case);
    const ephemeralFails = loadEphemeralFails(ctx.case);
    const ephemeralBaseline = new Set(ephemeralFails.keys());
    let out: OvercastRecord[] = [];
    try {
      out = await monitorPass(ctx, seen, ephemeralFails);
    } finally {
      // merge with disk so a concurrent monitor/scan process isn't clobbered;
      // the ephemeral merge is told which keys we deleted (success/give-up).
      saveSeen(ctx.case, seen);
      const deleted = new Set([...ephemeralBaseline].filter((k) => !ephemeralFails.has(k)));
      saveEphemeralFails(ctx.case, ephemeralFails, deleted);
    }
    writeAlert(out.filter((r) => r.verb !== "monitor"));
    return out;
  },
};

// ---- target (state verb) ---------------------------------------------------

export const targetVerb: VerbSpec = {
  name: "target",
  group: "state",
  summary: "Define/refine the standing scope, a.k.a. a line of investigation (add|list|rm|show|close|reopen). Persisted to .overcast/target.json.",
  description:
    "A target is a line of investigation. `add --question` records what would resolve it; `close <id> --as answered|dead-end --note` " +
    "marks the line done (closed lines stop seeding scan/monitor); `reopen <id>` reactivates it. Status feeds the brief/status thread cards.",
  args: [
    { name: "action", summary: "add | list | rm | show | close | reopen", required: true, choices: ["add", "list", "rm", "show", "close", "reopen"] },
    { name: "value", summary: "target value (for add) or id (for rm/close/reopen)" },
  ],
  flags: [
    { name: "image", summary: "Treat the value as a reference image path", type: "boolean" },
    { name: "question", summary: "add: what would resolve this line of investigation", type: "string" },
    { name: "as", summary: "close: answered | dead-end", type: "string", choices: ["answered", "dead-end"] },
    { name: "note", summary: "close: why (answered how / why it's a dead end)", type: "string" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "target",
  providerKey: "target",
  run: async (ctx) => {
    const action = ctx.input;
    const value = ctx.rest[0];
    if (action === "add") {
      if (!value) return [err("target", "target add requires a value")];
      const t = addTarget(ctx.case, value, {
        image: ctx.opts.image === true,
        question: ctx.opts.question ? String(ctx.opts.question) : undefined,
      });
      return [makeRecord({ verb: "target", format: "json", payload: { ...t }, state: "ready" })];
    }
    if (action === "rm") {
      if (!value) return [err("target", "target rm requires an id")];
      const ok = removeTarget(ctx.case, value);
      return [makeRecord({ verb: "target", format: "json", payload: { removed: ok, id: value }, state: "ready" })];
    }
    if (action === "close") {
      if (!value) return [err("target", "target close requires a target id")];
      const as = ctx.opts.as ? String(ctx.opts.as) : "answered";
      if (as !== "answered" && as !== "dead-end") return [err("target", `unknown --as '${as}' (expected answered | dead-end)`)];
      const updated = setTargetStatus(ctx.case, value, as, ctx.opts.note ? String(ctx.opts.note) : undefined);
      if (!updated) return [err("target", `target not found: ${value}`)];
      return [makeRecord({ verb: "target", format: "json", payload: { op: "close", ...updated }, state: "ready" })];
    }
    if (action === "reopen") {
      if (!value) return [err("target", "target reopen requires a target id")];
      const updated = setTargetStatus(ctx.case, value, "active");
      if (!updated) return [err("target", `target not found: ${value}`)];
      return [makeRecord({ verb: "target", format: "json", payload: { op: "reopen", ...updated }, state: "ready" })];
    }
    // an unrecognized action shouldn't silently fall through to a list
    if (action && action !== "list" && action !== "show") {
      return [err("target", `unknown target action '${action}' (expected add|list|rm|show|close|reopen)`)];
    }
    // list / show
    return [
      makeRecord({
        verb: "target",
        format: "json",
        payload: { targets: listTargets(ctx.case), primary: primaryTarget(ctx.case) ?? null },
        state: "ready",
      }),
    ];
  },
};

// ---- source (state verb) ---------------------------------------------------

export const sourceVerb: VerbSpec = {
  name: "source",
  group: "state",
  summary: "Register where to look (add <type>:<ref> | list | enable|disable <id> | rm <id>).",
  args: [
    { name: "action", summary: "add | list | enable | disable | rm", required: true, choices: ["add", "list", "enable", "disable", "rm"] },
    { name: "value", summary: "<type>:<ref> (add) or source id" },
  ],
  flags: [
    { name: "name", summary: "Friendly name for the source", type: "string" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "source",
  providerKey: "source",
  run: async (ctx) => {
    const action = ctx.input;
    const value = ctx.rest[0];
    if (action === "add") {
      if (!value) return [err("source", "source add requires <type>:<ref>")];
      const s = addSource(ctx.case, value, { name: ctx.opts.name ? String(ctx.opts.name) : undefined });
      return [makeRecord({ verb: "source", format: "json", payload: { ...s }, state: "ready" })];
    }
    if (action === "enable" || action === "disable") {
      if (!value) return [err("source", `source ${action} requires an id`)];
      const ok = setEnabled(ctx.case, value, action === "enable");
      return [makeRecord({ verb: "source", format: "json", payload: { id: value, enabled: action === "enable", ok }, state: "ready" })];
    }
    if (action === "rm") {
      if (!value) return [err("source", "source rm requires an id")];
      return [makeRecord({ verb: "source", format: "json", payload: { removed: removeSource(ctx.case, value), id: value }, state: "ready" })];
    }
    // an unrecognized action (e.g. `disbale`) shouldn't read as a successful list
    if (action && action !== "list") {
      return [err("source", `unknown source action '${action}' (expected add|list|enable|disable|rm)`)];
    }
    return [makeRecord({ verb: "source", format: "json", payload: { sources: listSources(ctx.case), enabled: enabledSources(ctx.case).length }, state: "ready" })];
  },
};

// ---- prebrief (case wizard) ------------------------------------------------

export const prebriefVerb: VerbSpec = {
  name: "prebrief",
  group: "config",
  summary: "Stand up a case: name + target + source in one shot (non-interactive via flags).",
  description:
    "A lightweight case kickoff. Initializes the .overcast/ store, sets the case name, and optionally " +
    "seeds a target (--target) and a source (--source <type>:<ref>).",
  args: [{ name: "name", summary: "Case name" }],
  flags: [
    { name: "target", summary: "Seed target (name/prompt)", type: "string" },
    { name: "source", summary: "Seed source <type>:<ref>", type: "string" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "prebrief",
  providerKey: "prebrief",
  run: async (ctx) => {
    // Persist the provided case name (not just echo it), per the verb contract.
    const info = ctx.input ? ctx.case.setName(String(ctx.input)) : ctx.case.ensure();
    const seeded: Record<string, unknown> = { case: info.id, name: info.name };
    if (ctx.opts.target) seeded.target = addTarget(ctx.case, String(ctx.opts.target));
    if (ctx.opts.source) seeded.source = addSource(ctx.case, String(ctx.opts.source));
    return [makeRecord({ verb: "prebrief", format: "json", payload: seeded, meta: { case: ctx.case.dir }, state: "ready" })];
  },
};
