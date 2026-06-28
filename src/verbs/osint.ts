// Phase 3 OSINT verbs: scan (sweep sources), capture (fetch a ref), monitor
// (scan on a loop + diff seen-set), plus the state verbs target/source and the
// prebrief case wizard. Source providers live in providers/sources.

import { join, basename, dirname } from "node:path";
import { copyFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeRecord, type OvercastRecord } from "../record.js";
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
import { addTarget, listTargets, removeTarget, primaryTarget } from "../state/target.js";
import { listIndexes } from "../state/index.js";
import { loadSetup } from "../state/setup.js";
import { loadSeen, saveSeen, hitKey } from "../state/seen.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { runListen } from "../providers/tinycloud/listen.js";
import { isCustomBinding, runBoundProvider } from "../providers/run.js";
import { providerEnv } from "../providers/provider-env.js";
import { parseSince } from "../providers/memory/local.js";
import { isAv } from "./media-ref.js";
import { faceVerb } from "./face.js";
import { seeVerb, enhanceVerb } from "./senses.js";
import { indexVerb } from "./index.js";
import { makeFinding } from "./finding.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
}

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

function localMediaRefs(ctx: VerbContext): string[] {
  const setup = loadSetup(ctx.case);
  const refs = [
    ...(setup?.media.videos ?? []),
    ...ctx.case.records().flatMap((r) => (r.media?.ref && isAv(r.media.ref) ? [r.media.ref] : [])),
    ...listIndexes(ctx.case).flatMap((i) => i.members.map((m) => m.ref)),
  ];
  return [...new Set(refs)].filter((ref) => !/^https?:\/\//i.test(ref) ? existsSync(ref) : true).sort();
}

async function scanLocalCase(ctx: VerbContext): Promise<OvercastRecord[]> {
  const targets = listTargets(ctx.case);
  const imageTargets = targets.filter((t) => t.kind === "image");
  const nameTargets = targets.filter((t) => t.kind !== "image").map((t) => t.value);
  const indexes = listIndexes(ctx.case);
  const faceIndexes = indexes.filter((i) => i.type === "face-analysis");
  const mediaIndexes = indexes.filter((i) => i.type === "media-descriptions");
  const refs = localMediaRefs(ctx);
  const suggested: string[] = [];
  if (imageTargets.length && faceIndexes.length) {
    suggested.push(`overcast face --match ${imageTargets.at(-1)!.value} --index ${faceIndexes.map((i) => i.id).join(",")}`);
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
      suggested_commands: suggested,
    },
    meta: { provider: "scan:local", case: ctx.case.dir },
    state: "ready",
  });

  if (imageTargets.length && faceIndexes.length) {
    const match = imageTargets.at(-1)!.value;
    const index = faceIndexes.map((i) => i.id).join(",");
    const faceRecords = await faceVerb.run({ ...ctx, input: undefined, rest: [], opts: { match, index } });
    return [summary, ...faceRecords];
  }
  return [summary];
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
  return out;
}

export const scanVerb: VerbSpec = {
  name: "scan",
  group: "osint",
  summary: "Sweep sources, or local case media/indexes when no sources exist; emit scan.hit records (--pull to capture+sense).",
  description:
    "Enumerates each enabled source by its bound ref (channel/handle/hashtag/keyword); an explicit " +
    "--query overrides, and the active target is the fallback when a source has no ref. With --pull, " +
    "each AV hit is immediately captured and routed to a sense (one-shot recon). If the case has no " +
    "enabled external sources, scan falls back to local case media/indexes and can run a face-index " +
    "search when an image target and face-analysis index are available.",
  args: [],
  flags: [
    { name: "query", summary: "Ad-hoc keyword search across sources", type: "string" },
    { name: "source", summary: "Restrict to source ids/types (comma list)", type: "string" },
    { name: "since", summary: "Only items newer than e.g. 24h, 2026-06-01", type: "string" },
    { name: "limit", summary: "Max hits per source", type: "number" },
    { name: "local", summary: "Scan local case media/indexes instead of external sources", type: "boolean" },
    { name: "pull", summary: "Auto-capture + sense each hit", type: "boolean" },
    { name: "pipe", summary: "Sense to run on pulled hits (watch|listen)", type: "string" },
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

    // --pull: capture + sense each non-error hit
    const out: OvercastRecord[] = [...hits];
    for (const hit of hits) {
      // skip enumerate FAILURES (error + needs_credentials) — they're not items to
      // capture/sense, matching monitorPass.
      if (hit.state === "error" || hit.state === "needs_credentials") continue;
      // resolve the fetch target from media.ref OR payload.url (a hit may carry
      // only a URL) — same fallback as monitorPass + captureRef.
      const hitUrl = (hit.payload as Record<string, unknown>)?.url;
      const ref = hit.media?.ref ?? (typeof hitUrl === "string" ? hitUrl : undefined);
      if (!ref) continue;
      try {
        const cap = await captureRef(ctx, ref, { sourceType: hitSourceType(hit) });
        out.push(cap);
        if (cap.state !== "error" && cap.media?.ref) {
          const explicitPipe = ctx.opts.pipe ? String(ctx.opts.pipe) : undefined;
          // only auto-sense AV captures; honor an explicit --pipe for anything.
          if (explicitPipe || isSenseableMedia(cap.media.ref)) {
            if (explicitPipe) {
              const sensed = await pipeSense(ctx, "scan", explicitPipe, cap.media.ref);
              if (sensed) out.push(sensed);
            } else {
              const automated = await runSetupAutomation(ctx, "scan", cap.media.ref);
              if (automated.length) out.push(...automated);
              else {
                const sensed = await pipeSense(ctx, "scan", "watch", cap.media.ref);
                if (sensed) out.push(sensed);
              }
            }
          }
        }
      } catch (e) {
        // a provider timeout / spawn failure rejects — record it and keep pulling
        // the remaining hits instead of aborting the whole scan.
        out.push(err("scan", `pull of ${ref} failed: ${(e as Error).message}`));
      }
    }
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
function hostSourceType(url: string): string {
  if (/(^|\.)tiktok\.com/i.test(url)) return "tiktok";
  if (/(^|\.)(youtube\.com|youtu\.be)/i.test(url)) return "youtube";
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

async function captureRef(
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
    try {
      copyFileSync(ref, dest);
    } catch (e) {
      return err("capture", `copy failed: ${(e as Error).message}`);
    }
    return makeRecord({
      verb: "capture",
      format: "json",
      payload: { capture_id: "cap_" + basename(dest), path: dest, kind: "file", source: "local" },
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
  return fetchSource(desc, { url: ref, out: dest, signal: ctx.signal });
}

async function pipeSense(
  ctx: VerbContext,
  caller: string,
  verb: string,
  ref: string,
): Promise<OvercastRecord | undefined> {
  if (verb === "watch" || verb === "listen") {
    const binding = ctx.profile.providers?.[verb];
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
  // an unknown --pipe value (typo, or see/enhance) must surface, not silently
  // produce nothing — labelled with the ACTIVE command (monitor/scan).
  return err(caller, `unknown --pipe '${verb}' (expected watch | listen)`);
}

async function runAutomationSense(ctx: VerbContext, caller: string, verb: string, ref: string): Promise<OvercastRecord> {
  if (verb === "watch" || verb === "listen") {
    const rec = await pipeSense(ctx, caller, verb, ref);
    return rec ?? err(caller, `sense '${verb}' produced no record`);
  }
  if (verb === "see") {
    const [rec] = await seeVerb.run({ ...ctx, input: ref, rest: [], opts: {} });
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
  return err(caller, `unknown automated sense '${verb}'`);
}

function payloadText(rec: OvercastRecord): string {
  if (typeof rec.payload === "string") return rec.payload;
  try {
    return JSON.stringify(rec.payload);
  } catch {
    return "";
  }
}

function automatedFindings(ctx: VerbContext, rec: OvercastRecord, trigger: string): OvercastRecord[] {
  const setup = loadSetup(ctx.case);
  if (setup?.findings?.mode !== "review" || rec.state === "error" || rec.state === "needs_credentials") return [];
  const haystack = payloadText(rec).toLowerCase();
  const out: OvercastRecord[] = [];
  for (const target of listTargets(ctx.case).filter((t) => t.kind !== "image").map((t) => t.value)) {
    const needle = target.trim().toLowerCase();
    if (!needle || !haystack.includes(needle)) continue;
    out.push(makeFinding({
      text: `Automated match for target '${target}' in ${rec.verb} record ${rec.id}`,
      target,
      sourceRecord: rec,
      trigger,
    }));
  }
  return out;
}

async function autoIndexNewMedia(ctx: VerbContext, ref: string): Promise<OvercastRecord[]> {
  const setup = loadSetup(ctx.case);
  if (setup?.automation?.auto_index_new !== true) return [];
  const out: OvercastRecord[] = [];
  for (const index of setup.indexes ?? []) {
    if (!index.id) continue;
    const signals = new Set([...(index.default_signals ?? []), ...(setup.default_signals[index.id] ?? [])]);
    if (!signals.has("index add")) continue;
    const recs = await indexVerb.run({ ...ctx, input: "add", rest: [ref], opts: { to: index.id, type: index.type } });
    out.push(...recs);
  }
  return out;
}

async function runSetupAutomation(ctx: VerbContext, caller: string, ref: string): Promise<OvercastRecord[]> {
  const setup = loadSetup(ctx.case);
  const chain = setup?.automation?.auto_sense ?? [];
  if (!chain.length) return [];
  const out: OvercastRecord[] = [];
  let currentRef = ref;
  for (const verb of chain) {
    const rec = await runAutomationSense(ctx, caller, verb, currentRef);
    rec.meta = { ...rec.meta, case: ctx.case.dir, triggered_by: `${caller}:automation` };
    out.push(rec, ...automatedFindings(ctx, rec, `${caller}:${verb}`));
    if (rec.state !== "error" && rec.state !== "needs_credentials" && rec.media?.ref) currentRef = rec.media.ref;
  }
  out.push(...await autoIndexNewMedia(ctx, currentRef));
  return out;
}

/** Best-effort media extension from leading magic bytes (so a piped clip lands
 *  with a sensible extension the senses/ffmpeg can classify). */
function sniffExt(b: Buffer): string {
  const at = (off: number, s: string) => b.length >= off + s.length && b.slice(off, off + s.length).toString("latin1") === s;
  if (at(4, "ftyp")) return ".mp4"; // ISO-BMFF: mp4/mov/m4a
  if (at(0, "RIFF") && at(8, "WEBP")) return ".webp";
  if (at(0, "RIFF") && at(8, "WAVE")) return ".wav";
  if (at(0, "RIFF") && at(8, "AVI ")) return ".avi";
  if (b[0] === 0x89 && at(1, "PNG")) return ".png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (at(0, "GIF8")) return ".gif";
  if (at(0, "OggS")) return ".ogg";
  if (at(0, "fLaC")) return ".flac";
  if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ".mp3";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ".webm";
  return ".bin";
}

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
    // --index: flag the artifact for memory recall. The case store IS the local
    // memory index (records are written there), so this records the intent.
    if (ctx.opts.index === true && typeof cap.payload === "object") {
      (cap.payload as Record<string, unknown>).indexed = true;
    }
    return [cap];
  },
};

// ---- monitor (--once) ------------------------------------------------------

/** Parse a cadence like "15m"/"6h"/"30s"/"1d" into milliseconds. */
export function parseInterval(s: string): number | undefined {
  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2];
  return n * (u === "s" ? 1e3 : u === "m" ? 60e3 : u === "h" ? 3600e3 : 86400e3);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    if (ms <= 0) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

/** One monitor pass: enumerate, diff against `seen` (mutated), capture+sense new items. */
async function monitorPass(ctx: VerbContext, seen: Set<string>): Promise<OvercastRecord[]> {
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
  for (const hit of realHits) {
    const key = hitKey(hit);
    if (seen.has(key)) continue;
    out.push(hit);
    // capture from media.ref OR a payload.url (a scan hit may carry only a URL,
    // no media object — `capture` falls back the same way, so monitor must too).
    const hitUrl = (hit.payload as Record<string, unknown>)?.url;
    const ref = hit.media?.ref ?? (typeof hitUrl === "string" ? hitUrl : undefined);
    if (!ref) {
      // nothing fetchable: surface the scan.hit, mark seen (don't re-surface every
      // pass), but don't count it as a processed new item.
      seen.add(key);
      continue;
    }
    // Classify the outcome:
    //  - transient (needs_credentials / pending): a recoverable gap → leave the
    //    item UNSEEN so a later pass retries once it's fixed.
    //  - hard error (e.g. piping `watch` at captured HTML): PERMANENT → mark seen
    //    so `monitor --every` doesn't reprocess it forever, and flag the pass.
    let transient = false;
    let procError = false;
    try {
      const cap = await captureRef(ctx, ref, { sourceType: hitSourceType(hit) });
      out.push(cap);
      if (cap.state === "needs_credentials") {
        transient = true; procCredGaps++;
      } else if (cap.state === "error" || !cap.media?.ref) {
        procError = true;
      } else {
        const explicitPipe = ctx.opts.pipe ? String(ctx.opts.pipe) : undefined;
        if (explicitPipe || isSenseableMedia(cap.media.ref)) {
          const sensedRecords = explicitPipe
            ? [await pipeSense(ctx, "monitor", explicitPipe, cap.media.ref)].filter((r): r is OvercastRecord => !!r)
            : await runSetupAutomation(ctx, "monitor", cap.media.ref);
          if (sensedRecords.length) out.push(...sensedRecords);
          else {
            const sensed = await pipeSense(ctx, "monitor", "watch", cap.media.ref);
            if (sensed) sensedRecords.push(sensed);
            if (sensed) out.push(sensed);
          }
          for (const sensed of sensedRecords) {
            const st = sensed.state;
            if (st === "needs_credentials") { transient = true; procCredGaps++; }
            else if (st === "pending") { transient = true; }
            else if (st === "error") { procError = true; }
          }
        }
      }
    } catch (e) {
      // execCapture rejects on provider timeout / spawn failure — convert it to a
      // per-hit error so the loop keeps processing the rest (and --every keeps
      // looping) instead of throwing out of the whole pass.
      procError = true;
      out.push(err("monitor", `processing ${ref} failed: ${(e as Error).message}`));
    }
    if (transient) continue; // recoverable gap → leave unseen, retry next pass
    // a hard error is permanent → mark seen (no infinite retry) but DON'T count it
    // as a successfully-ingested new item; the summary reports it via process_errors.
    seen.add(key);
    if (procError) procErrors++;
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
    "Enumerates sources, diffs against .overcast/seen.json, and for each NEW item runs capture → --pipe " +
    "sense. --once = single diff pass (scheduler-friendly). --every <15m|6h|…> = continuous blocking loop " +
    "(run under tmux; Ctrl-C to stop); each pass streams its records. --brief summarizes the new batch; " +
    "--alert <stdout|file> mirrors new records to a sink.",
  args: [],
  flags: [
    { name: "source", summary: "Restrict to source ids/types", type: "string" },
    { name: "query", summary: "Ad-hoc keyword search across sources", type: "string" },
    { name: "since", summary: "Only items newer than e.g. 24h, 2026-06-01", type: "string" },
    { name: "limit", summary: "Max hits per source", type: "number" },
    { name: "pipe", summary: "Sense to run on new items (watch|listen)", type: "string" },
    { name: "describe", summary: "With --pipe listen: full audio-scene describe (not speech-only)", type: "boolean" },
    { name: "once", summary: "Single diff pass then exit", type: "boolean" },
    { name: "every", summary: "Continuous loop cadence (e.g. 15m, 6h)", type: "string" },
    { name: "brief", summary: "Summarize the new batch into a brief record", type: "boolean" },
    { name: "alert", summary: "Mirror new records to a sink (stdout | <file>)", type: "string" },
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
      if (streamFmt === "md" || streamFmt === "txt") {
        if (typeof r.payload === "string") return r.payload;
        const p = r.payload as Record<string, unknown>;
        for (const k of ["content", "text", "report"]) {
          if (typeof p[k] === "string" && p[k]) return p[k] as string;
        }
      }
      return JSON.stringify(r);
    };
    const writeAlert = (recs: OvercastRecord[]) => {
      // FILE sinks only. Records already reach stdout via the normal monitor
      // output (the per-pass stream in --every; runCli printing the returned
      // records in --once), so mirroring them to stdout would double every line.
      if (!alertSink || alertSink === "stdout" || recs.length === 0) return;
      const lines = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
      mkdirSync(dirname(alertSink), { recursive: true });
      appendFileSync(alertSink, lines);
    };

    // continuous mode: --every set and NOT --once → blocking loop, stream each pass.
    if (everyStr && ctx.opts.once !== true) {
      const intervalMs = parseInterval(everyStr) ?? 0;
      if (intervalMs <= 0) return [makeRecord({ verb: "monitor", format: "json", payload: { error: `bad --every '${everyStr}'` }, error: "bad interval", state: "error" })];
      const seen = loadSeen(ctx.case);
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
      const emitted = new Set<string>();
      const recKey = (r: OvercastRecord) =>
        `${r.verb}|${r.error ?? ""}|${(r.media?.ref as string) ?? ""}|${JSON.stringify(r.payload ?? {}).slice(0, 100)}`;
      process.stderr.write(`monitor: every ${everyStr}, Ctrl-C to stop\n`);
      while (pass < maxPasses && !ctx.signal?.aborted) {
        pass++;
        let recs: OvercastRecord[];
        try {
          recs = await monitorPass(ctx, seen);
        } catch (e) {
          // a thrown pass (timeout, spawn failure) becomes one failed-pass error
          // record — the long-running loop keeps going, it doesn't crash.
          recs = [err("monitor", `monitor pass failed: ${(e as Error).message}`)];
        } finally {
          // persist accumulated seen-set even if a pass throws mid-way.
          saveSeen(ctx.case, seen);
        }
        for (const r of recs) {
          // a per-pass monitor SUMMARY is always emitted (consecutive passes can
          // legitimately repeat the same payload); only hit/error records dedupe
          // so a recurring enumerate error isn't re-persisted/re-streamed each pass.
          if (r.verb !== "monitor") {
            const k = recKey(r);
            if (emitted.has(k)) continue;
            emitted.add(k);
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
    let out: OvercastRecord[] = [];
    try {
      out = await monitorPass(ctx, seen);
    } finally {
      saveSeen(ctx.case, seen);
    }
    writeAlert(out.filter((r) => r.verb !== "monitor"));
    return out;
  },
};

// ---- target (state verb) ---------------------------------------------------

export const targetVerb: VerbSpec = {
  name: "target",
  group: "state",
  summary: "Define/refine the standing scope (add|list|rm|show). Persisted to .overcast/target.json.",
  args: [
    { name: "action", summary: "add | list | rm | show", required: true },
    { name: "value", summary: "target value (for add) or id (for rm)" },
  ],
  flags: [
    { name: "image", summary: "Treat the value as a reference image path", type: "boolean" },
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
      const t = addTarget(ctx.case, value, { image: ctx.opts.image === true });
      return [makeRecord({ verb: "target", format: "json", payload: { ...t }, state: "ready" })];
    }
    if (action === "rm") {
      if (!value) return [err("target", "target rm requires an id")];
      const ok = removeTarget(ctx.case, value);
      return [makeRecord({ verb: "target", format: "json", payload: { removed: ok, id: value }, state: "ready" })];
    }
    // an unrecognized action shouldn't silently fall through to a list
    if (action && action !== "list" && action !== "show") {
      return [err("target", `unknown target action '${action}' (expected add|list|rm|show)`)];
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
    { name: "action", summary: "add | list | enable | disable | rm", required: true },
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
