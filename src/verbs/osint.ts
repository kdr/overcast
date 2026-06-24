// Phase 3 OSINT verbs: scan (sweep sources), capture (fetch a ref), monitor
// (scan on a loop + diff seen-set), plus the state verbs target/source and the
// prebrief case wizard. Source providers live in providers/sources.

import { join, basename, dirname } from "node:path";
import { copyFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
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
import { loadSeen, saveSeen, hitKey } from "../state/seen.js";
import { runWatch } from "../providers/tinycloud/watch.js";
import { runListen } from "../providers/tinycloud/listen.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
}

// ---- scan ------------------------------------------------------------------

async function enumerateAll(ctx: VerbContext): Promise<OvercastRecord[]> {
  const sourceIds = ctx.opts.source ? String(ctx.opts.source).split(",").map((s) => s.trim()) : undefined;
  const sources = resolveSources(ctx.case, sourceIds);
  const query =
    (ctx.opts.query ? String(ctx.opts.query) : undefined) ??
    primaryTarget(ctx.case)?.value;
  const limit = ctx.opts.limit != null ? Number(ctx.opts.limit) : undefined;
  const since = ctx.opts.since ? String(ctx.opts.since) : undefined;

  if (sources.length === 0) {
    return [err("scan", "no sources registered/enabled (try `overcast source add <type>:<ref>`)")];
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
        query: query ?? s.ref,
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
  summary: "Sweep registered sources for the target(s); emit scan.hit records (--pull to capture+sense).",
  description:
    "Enumerates the case's enabled sources for the active target (or --query). With --pull, each hit " +
    "is immediately captured and routed to a sense (one-shot recon).",
  args: [],
  flags: [
    { name: "query", summary: "Ad-hoc keyword search across sources", type: "string" },
    { name: "source", summary: "Restrict to source ids/types (comma list)", type: "string" },
    { name: "since", summary: "Only items newer than e.g. 24h, 2026-06-01", type: "string" },
    { name: "limit", summary: "Max hits per source", type: "number" },
    { name: "pull", summary: "Auto-capture + sense each hit", type: "boolean" },
    { name: "pipe", summary: "Sense to run on pulled hits (watch|listen)", type: "string" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "scan.hit",
  providerKey: "scan",
  run: async (ctx) => {
    const hits = await enumerateAll(ctx);
    if (!ctx.opts.pull) return hits;

    // --pull: capture + sense each non-error hit
    const out: OvercastRecord[] = [...hits];
    for (const hit of hits) {
      if (hit.state === "error" || !hit.media?.ref) continue;
      const cap = await captureRef(ctx, hit.media.ref, { sourceType: hitSourceType(hit) });
      out.push(cap);
      if (cap.state !== "error" && cap.media?.ref) {
        const pipe = ctx.opts.pipe ? String(ctx.opts.pipe) : "watch";
        const sensed = await pipeSense(ctx, pipe, cap.media.ref);
        if (sensed) out.push(sensed);
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
  // a local file → copy into the case (fixture/folder sources, ad-hoc paths)
  if (existsSync(ref)) {
    const dest = opts.out ? opts.out : join(outDir, basename(ref));
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
  verb: string,
  ref: string,
): Promise<OvercastRecord | undefined> {
  if (verb === "watch") {
    const r = await runWatch(ref, { run: ctx.profile.providers?.watch?.run, signal: ctx.signal });
    r.meta = { ...r.meta, case: ctx.case.dir };
    return r;
  }
  if (verb === "listen") {
    const r = await runListen(ref, { run: ctx.profile.providers?.listen?.run, signal: ctx.signal });
    r.meta = { ...r.meta, case: ctx.case.dir };
    return r;
  }
  return undefined;
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
    if (!ctx.input) return [err("capture", "capture requires a ref (URL/path/scan.hit id)")];
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
  const hits = await enumerateAll(ctx);
  const errorHits = hits.filter((h) => h.state === "error");
  const realHits = hits.filter((h) => h.state !== "error");
  const out: OvercastRecord[] = [...errorHits];
  const newHits: OvercastRecord[] = [];
  let newCount = 0;
  for (const hit of realHits) {
    const key = hitKey(hit);
    if (seen.has(key)) continue;
    out.push(hit);
    // Only mark an item seen once it has been processed (no capturable media, or
    // capture succeeded). A failed capture stays unseen so a later pass retries
    // it instead of silently dropping it.
    let captureFailed = false;
    if (hit.media?.ref) {
      const cap = await captureRef(ctx, hit.media.ref, { sourceType: hitSourceType(hit) });
      out.push(cap);
      if (cap.state !== "error" && cap.media?.ref) {
        const sensed = await pipeSense(ctx, ctx.opts.pipe ? String(ctx.opts.pipe) : "watch", cap.media.ref);
        if (sensed) out.push(sensed);
      } else {
        captureFailed = true;
      }
    }
    if (!captureFailed) {
      seen.add(key);
      newCount++;
      newHits.push(hit);
    }
  }
  out.unshift(
    makeRecord({
      verb: "monitor",
      format: "json",
      payload: { new_items: newCount, total_hits: realHits.length, seen_size: seen.size, source_errors: errorHits.length },
      meta: { provider: "monitor", case: ctx.case.dir },
      state: errorHits.length ? "error" : "ready",
      error: errorHits.length ? `${errorHits.length} source(s) failed to enumerate` : undefined,
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
    { name: "pipe", summary: "Sense to run on new items (watch|listen)", type: "string" },
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
    const writeAlert = (recs: OvercastRecord[]) => {
      if (!alertSink) return;
      const lines = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
      if (alertSink === "stdout") process.stdout.write(lines);
      else { mkdirSync(dirname(alertSink), { recursive: true }); appendFileSync(alertSink, lines); }
    };

    // continuous mode: --every set and NOT --once → blocking loop, stream each pass.
    if (everyStr && ctx.opts.once !== true) {
      const intervalMs = parseInterval(everyStr) ?? 0;
      if (intervalMs <= 0) return [makeRecord({ verb: "monitor", format: "json", payload: { error: `bad --every '${everyStr}'` }, error: "bad interval", state: "error" })];
      const seen = loadSeen(ctx.case);
      const maxPasses = process.env.OVERCAST_MONITOR_MAX_PASSES ? Number(process.env.OVERCAST_MONITOR_MAX_PASSES) : Infinity;
      let pass = 0;
      let errorPasses = 0;
      process.stderr.write(`monitor: every ${everyStr}, Ctrl-C to stop\n`);
      while (pass < maxPasses && !ctx.signal?.aborted) {
        pass++;
        const recs = await monitorPass(ctx, seen);
        for (const r of recs) { ctx.case.writeRecord(r); process.stdout.write(JSON.stringify(r) + "\n"); }
        saveSeen(ctx.case, seen);
        writeAlert(recs.filter((r) => r.verb !== "monitor"));
        if (recs.some((r) => r.state === "error")) errorPasses++;
        if (pass >= maxPasses || ctx.signal?.aborted) break;
        await sleep(intervalMs, ctx.signal);
      }
      // records already streamed + persisted per pass; return a final summary so
      // the exit code reflects whether any pass errored (schedulers rely on it).
      return [
        makeRecord({
          verb: "monitor",
          format: "json",
          payload: { passes: pass, error_passes: errorPasses },
          meta: { provider: "monitor", case: ctx.case.dir },
          state: errorPasses ? "error" : "ready",
          error: errorPasses ? `${errorPasses}/${pass} pass(es) had errors` : undefined,
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
