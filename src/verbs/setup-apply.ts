// Setup-indexing engine shared by `case setup` and `archive setup`: parse index
// specs, maintain media routes on a CaseSetup, and drive the index/similar/
// cluster verbs to create indexes + route media through them. Extracted from
// verbs/case.ts unchanged so both wizards apply the SAME routing semantics
// against whatever Case the ctx carries (a case dir or an archive bucket).

import { existsSync, readdirSync, statSync } from "node:fs";
import type { OvercastRecord } from "../record.js";
import { normalizeIndexType } from "../state/index.js";
import type { CaseSetup, SetupIndex, SetupIndexConfig } from "../state/setup.js";
import type { VerbContext } from "../registry/types.js";
import { indexVerb } from "./index.js";
import { similarVerb } from "./similar.js";
import { clusterVerb } from "./cluster.js";
import { voiceVerb } from "./voice.js";
import { isAv, isImage } from "./media-ref.js";
import { join } from "node:path";

export const DEFAULT_SIGNAL_BY_INDEX_TYPE: Record<string, string[]> = {
  "media-descriptions": ["watch", "index add"],
  "face-analysis": ["face", "index add"],
  entities: ["watch", "index add"],
  // local face DB: `cluster add` feeds it (NOT `index add`, which would error) —
  // setup stands the DB up alongside other indexes; clustering stays explicit.
  "face-cluster": ["cluster add"],
  // local speaker DB: `voice add` enrolls members (index add errors, like cluster)
  "voice-print": ["voice add"],
};
export const DEFAULT_LOCAL_MEMORY_SIGNALS = ["note", "watch", "listen", "see", "scan"];

export function csv(v: unknown): string[] {
  if (v == null) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

export function textList(v: unknown): string[] {
  if (v == null) return [];
  const raw = String(v).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    /* not JSON; fall through */
  }
  if (raw.includes("\n")) return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return [raw];
}

export function normalizeSetupMemory(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (value === "local" || value === "local-grep") return "local-grep";
  if (value === "qmd") return "qmd";
  return undefined;
}

/** Parse an optional trailing `@k=v;k=v` config suffix (basic-clip). Pairs are
 *  `;`-separated (NOT comma — `--index` is itself a comma-separated list). Split
 *  off BEFORE the `:` split so it doesn't collide with the `id:type:name` attach
 *  form. Keys: pooling, granularity, sampling, window, max-frames|maxFrames, fps. */
function parseIndexConfigSuffix(spec: string): { base: string; config?: SetupIndexConfig } {
  const at = spec.indexOf("@");
  if (at < 0) return { base: spec };
  const base = spec.slice(0, at);
  const config: SetupIndexConfig = {};
  for (const pair of spec.slice(at + 1).split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (!value) continue;
    if (key === "pooling") config.pooling = value;
    else if (key === "granularity") config.granularity = value;
    else if (key === "sampling") config.sampling = value;
    else if (key === "window") config.window = Number(value);
    else if (key === "max-frames" || key === "maxframes") config.maxFrames = Number(value);
    else if (key === "fps") config.fps = Number(value);
  }
  return { base, config: Object.keys(config).length ? config : undefined };
}

export function parseIndexSpec(spec: string, signals: string[]): SetupIndex {
  const { base, config } = parseIndexConfigSuffix(spec);
  const parts = base.split(":").map((p) => p.trim()).filter(Boolean);
  let id: string | undefined;
  let name = parts[0] ?? base;
  let rawType = parts[1] ?? "media-descriptions";
  if (parts.length >= 3) {
    id = parts[0];
    rawType = parts[1];
    name = parts.slice(2).join(":");
  }
  const type = normalizeIndexType(rawType) ?? rawType;
  return {
    id,
    name,
    type,
    mode: id ? "attach" : "create",
    default_signals: signals.length ? signals : (DEFAULT_SIGNAL_BY_INDEX_TYPE[type] ?? []),
    ...(config ? { config } : {}),
  };
}

export const accepted = (rec: OvercastRecord) => rec.state === "ready" || rec.state === "pending";

export function cloneSetup(setup: CaseSetup): CaseSetup {
  return JSON.parse(JSON.stringify(setup)) as CaseSetup;
}

export function setupIndexRef(index: SetupIndex): string {
  return index.id ?? index.name;
}

export function refreshSetupRouteIndexes(setup: CaseSetup): void {
  const indexRefs = setup.indexes.map(setupIndexRef);
  for (const route of setup.media.routes) route.indexes = [...indexRefs];
}

export function addVideoRoute(setup: CaseSetup, ref: string, signals: string[]): void {
  if (!setup.media.videos.includes(ref)) setup.media.videos.push(ref);
  const route = setup.media.routes.find((r) => r.ref === ref);
  const indexRefs = setup.indexes.map(setupIndexRef);
  if (route) {
    route.signals = signals.length ? signals : route.signals;
    route.indexes = indexRefs.length ? indexRefs : route.indexes;
  } else {
    setup.media.routes.push({ ref, signals: signals.length ? signals : ["watch"], indexes: indexRefs });
  }
}

/** Enumerate media files under a folder for setup routing. `includeImages` picks
 *  up still images too — an ARCHIVE bucket stores images and routes every item
 *  (incl. stills, via backfill) into image-capable indexes, so its `--folder`
 *  must not silently drop a folder of reference photos. Case setup stays AV-only
 *  (its `--folder` is investigation footage; it never auto-routes images). */
export function folderMediaFiles(folder: string, opts: { includeImages?: boolean } = {}): string[] {
  if (!existsSync(folder)) return [];
  const wanted = (path: string) => isAv(path) || (opts.includeImages === true && isImage(path));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && wanted(path)) out.push(path);
    }
  };
  try {
    if (statSync(folder).isDirectory()) walk(folder);
    else if (statSync(folder).isFile() && wanted(folder)) out.push(folder);
  } catch {
    return [];
  }
  return out.sort();
}

function remoteIndexId(rec: OvercastRecord): string | undefined {
  const payload = rec.payload && typeof rec.payload === "object" ? rec.payload as Record<string, unknown> : {};
  const detailed = payload.detailed && typeof payload.detailed === "object" ? payload.detailed as Record<string, unknown> : {};
  const collection = detailed.collection && typeof detailed.collection === "object" ? detailed.collection as Record<string, unknown> : {};
  for (const value of [payload.id, payload.index, payload.collection_id, detailed.id, detailed.collection_id, collection.id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function indexingOperationLabel(recs: OvercastRecord[]): "indexing started" | "index already member" | "indexing attempted" {
  if (recs.some((rec) => {
    const payload = rec.payload && typeof rec.payload === "object" ? rec.payload as Record<string, unknown> : {};
    return accepted(rec) && payload.already_member !== true;
  })) return "indexing started";
  if (recs.some((rec) => {
    const payload = rec.payload && typeof rec.payload === "object" ? rec.payload as Record<string, unknown> : {};
    return accepted(rec) && payload.already_member === true;
  })) return "index already member";
  return "indexing attempted";
}

export async function applySetupIndexing(ctx: VerbContext, setup: CaseSetup, operations: string[]): Promise<OvercastRecord[]> {
  const records: OvercastRecord[] = [];
  const createdByName = new Map<string, string>();

  for (const index of setup.indexes) {
    if (index.id) continue;
    const recs = await indexVerb.run({
      ...ctx,
      input: "create",
      rest: [index.name],
      opts: { type: index.type, ...indexConfigToFlags(index.config) },
    });
    records.push(...recs);
    const created = recs.find(accepted);
    const id = created ? remoteIndexId(created) : undefined;
    if (!id) {
      operations.push(`index create attempted: ${index.name}`);
      continue;
    }
    const oldRef = setupIndexRef(index);
    index.id = id;
    index.mode = "attach";
    createdByName.set(oldRef, id);
    setup.default_signals[id] = setup.default_signals[oldRef] ?? index.default_signals;
    if (oldRef !== id) delete setup.default_signals[oldRef];
    operations.push(`index created: ${index.name} (${id})`);
  }

  if (createdByName.size) {
    for (const route of setup.media.routes) {
      route.indexes = route.indexes.map((ref) => createdByName.get(ref) ?? ref);
    }
  }
  refreshSetupRouteIndexes(setup);

  for (const route of setup.media.routes) {
    for (const index of setup.indexes) {
      const id = index.id;
      if (!id || !route.indexes.includes(id)) continue;
      const signals = new Set([...route.signals, ...(setup.default_signals[id] ?? index.default_signals)]);
      // basic-clip embeds members via the `similar` verb. The generic `index add`
      // signal opts in too — the standard "watch,index add" route must not leave
      // a CLIP index silently empty just because it embeds through a different verb.
      if (index.type === "basic-clip") {
        if (!signals.has("similar add") && !signals.has("similar") && !signals.has("index add")) continue;
        const recs = await similarVerb.run({ ...ctx, input: "add", rest: [route.ref], opts: { index: id } });
        records.push(...recs);
        // label from the similar (embed) record only — shots sampling can return
        // a READY auxiliary watch record next to a FAILED embed, which would
        // otherwise read as "indexing started" with no member registered.
        const embed = recs.filter((r) => r.verb === "similar");
        operations.push(`${indexingOperationLabel(embed.length ? embed : recs)}: ${route.ref} -> ${id}`);
        continue;
      }
      if (index.type === "face-cluster") {
        if (!signals.has("cluster add") && !signals.has("cluster") && !signals.has("index add")) continue;
        const recs = await clusterVerb.run({ ...ctx, input: "add", rest: [route.ref], opts: { index: id } });
        records.push(...recs);
        operations.push(`${indexingOperationLabel(recs)}: ${route.ref} -> ${id}`);
        continue;
      }
      if (index.type === "voice-print") {
        // voice-print enrolls via the `voice` verb (index add errors, like cluster)
        if (!signals.has("voice add") && !signals.has("voice") && !signals.has("index add")) continue;
        const recs = await voiceVerb.run({ ...ctx, input: "add", rest: [route.ref], opts: { index: id } });
        records.push(...recs);
        operations.push(`${indexingOperationLabel(recs)}: ${route.ref} -> ${id}`);
        continue;
      }
      if (!signals.has("index add")) continue;
      const recs = await indexVerb.run({
        ...ctx,
        input: "add",
        rest: [route.ref],
        opts: { to: id, type: index.type },
      });
      records.push(...recs);
      operations.push(`${indexingOperationLabel(recs)}: ${route.ref} -> ${id}`);
    }
  }

  return records;
}

/** Map a saved SetupIndexConfig into `index create` flags (basic-clip). */
function indexConfigToFlags(config: SetupIndexConfig | undefined): Record<string, string | number> {
  if (!config) return {};
  const flags: Record<string, string | number> = {};
  if (config.pooling) flags.pooling = config.pooling;
  if (config.granularity) flags.granularity = config.granularity;
  if (config.sampling) flags.sampling = config.sampling;
  if (config.window != null) flags.window = config.window;
  if (config.maxFrames != null) flags["max-frames"] = config.maxFrames;
  if (config.fps != null) flags.fps = config.fps;
  return flags;
}
