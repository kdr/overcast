// `case` verb — inspect/manage the current case (the .overcast/ store). Case is
// a folder (invariant #4); this is the read/seed surface over it + the bound
// memory providers. Subcommands: init | info | records | memory | clear.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRecord, type OvercastRecord } from "../record.js";
import { openCase } from "../case.js";
import { humanSize } from "../render.js";
import { matchesMemoryProvider, resolveMemory } from "../providers/memory/index.js";
import { parseSince } from "../providers/memory/local.js";
import { tokenizeCommand } from "../providers/sources/index.js";
import { payloadFields, pageText, fieldNames, getField } from "../render.js";
import { redactSecrets } from "../env.js";
import { addSource, listSources, parseSourceSpec, removeSource } from "../state/source.js";
import { addTarget, listTargets, removeTarget } from "../state/target.js";
import { addIndex, listIndexes, normalizeIndexType, removeIndex } from "../state/index.js";
import { emptySetup, loadSetup, saveSetup, setupSummary, type CaseSetup, type SetupIndex } from "../state/setup.js";
import { indexVerb } from "./index.js";
import { isAv } from "./media-ref.js";
import { findProviderChoice } from "../providers/catalog.js";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "case", format: "json", payload: { error: message }, error: message, state: "error" });
}

const DEFAULT_SIGNAL_BY_INDEX_TYPE: Record<string, string[]> = {
  "media-descriptions": ["watch", "index add"],
  "face-analysis": ["face", "index add"],
  entities: ["watch", "index add"],
};
const DEFAULT_LOCAL_MEMORY_SIGNALS = ["note", "watch", "listen", "see", "scan"];

function csv(v: unknown): string[] {
  if (v == null) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

function textList(v: unknown): string[] {
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

function parseProviderSelections(v: unknown): Array<{ verb: string; choice: string }> {
  return csv(v).map((spec) => {
    const idx = spec.indexOf(":");
    return idx < 0
      ? { verb: "", choice: spec.trim() }
      : { verb: spec.slice(0, idx).trim(), choice: spec.slice(idx + 1).trim() };
  });
}

function normalizeSetupMemory(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (value === "local" || value === "local-grep") return "local-grep";
  if (value === "qmd") return "qmd";
  return undefined;
}

function summarizeSavedSetup(setup: CaseSetup | undefined): Record<string, unknown> {
  return setupSummary(setup);
}

function parseIndexSpec(spec: string, signals: string[]): SetupIndex {
  const parts = spec.split(":").map((p) => p.trim()).filter(Boolean);
  let id: string | undefined;
  let name = parts[0] ?? spec;
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
  };
}

function setupHealth(ctx: VerbContext, setup: CaseSetup | undefined): Record<string, unknown> {
  const mirrored = new Set(listIndexes(ctx.case).map((i) => i.id));
  const missingIndexes = (setup?.indexes ?? [])
    .filter((i) => i.id && !mirrored.has(i.id))
    .map((i) => i.id);
  const incompleteIndexes = (setup?.indexes ?? [])
    .filter((i) => !i.id && i.mode !== "attach")
    .map((i) => ({ name: i.name, type: i.type }));
  const missingVideos = (setup?.media.videos ?? [])
    .filter((v) => !/^https?:\/\//i.test(v) && !existsSync(v));
  return {
    setup: summarizeSavedSetup(setup),
    registry: {
      targets: listTargets(ctx.case).length,
      sources: listSources(ctx.case).length,
      indexes: listIndexes(ctx.case).length,
    },
    missing_indexes: missingIndexes,
    incomplete_indexes: incompleteIndexes,
    missing_videos: missingVideos,
  };
}

interface SetupChange {
  setup: CaseSetup;
  operations: string[];
  noteRecords: OvercastRecord[];
}

const accepted = (rec: OvercastRecord) => rec.state === "ready" || rec.state === "pending";

function cloneSetup(setup: CaseSetup): CaseSetup {
  return JSON.parse(JSON.stringify(setup)) as CaseSetup;
}

function targetValuesForRemoval(ctx: VerbContext, removals: string[]): Set<string> {
  const values = new Set(removals);
  for (const existing of listTargets(ctx.case)) {
    if (removals.includes(existing.id)) values.add(existing.value);
  }
  return values;
}

function sourceSpecsForRemoval(ctx: VerbContext, removals: string[]): Set<string> {
  const specs = new Set(removals);
  for (const existing of listSources(ctx.case)) {
    if (removals.includes(existing.id)) specs.add(`${existing.type}:${existing.ref}`);
  }
  return specs;
}

function setupFromExistingRegistries(ctx: VerbContext, caseName: string): CaseSetup {
  const setup = emptySetup(caseName);
  setup.targets = listTargets(ctx.case).map((t) => t.value);
  setup.sources = listSources(ctx.case).map((s) => `${s.type}:${s.ref}`);
  setup.indexes = listIndexes(ctx.case).map((i) => {
    const type = normalizeIndexType(i.type) ?? i.type;
    const defaultSignals = DEFAULT_SIGNAL_BY_INDEX_TYPE[type] ?? [];
    setup.default_signals[i.id] = defaultSignals;
    return {
      id: i.id,
      name: i.name,
      type,
      mode: "attach",
      default_signals: defaultSignals,
    };
  });
  const videoRefs = [...new Set(listIndexes(ctx.case).flatMap((i) => i.members.map((m) => m.ref)))];
  setup.media.videos = videoRefs;
  setup.media.routes = videoRefs.map((ref) => ({
    ref,
    signals: ["watch"],
    indexes: setup.indexes.map(setupIndexRef),
  }));
  return setup;
}

function setupIndexRef(index: SetupIndex): string {
  return index.id ?? index.name;
}

function refreshSetupRouteIndexes(setup: CaseSetup): void {
  const indexRefs = setup.indexes.map(setupIndexRef);
  for (const route of setup.media.routes) route.indexes = [...indexRefs];
}

function addVideoRoute(setup: CaseSetup, ref: string, signals: string[]): void {
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

function folderMediaFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isAv(path)) out.push(path);
    }
  };
  try {
    if (statSync(folder).isDirectory()) walk(folder);
    else if (statSync(folder).isFile() && isAv(folder)) out.push(folder);
  } catch {
    return [];
  }
  return out.sort();
}

function isImageTargetRef(ref: string): boolean {
  return /\.(avif|bmp|gif|jpe?g|png|tiff?|webp)(?:[?#].*)?$/i.test(ref);
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

async function applySetupIndexing(ctx: VerbContext, setup: CaseSetup, operations: string[]): Promise<OvercastRecord[]> {
  const records: OvercastRecord[] = [];
  const createdByName = new Map<string, string>();

  for (const index of setup.indexes) {
    if (index.id) continue;
    const recs = await indexVerb.run({
      ...ctx,
      input: "create",
      rest: [index.name],
      opts: { type: index.type },
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

function buildSetupChange(ctx: VerbContext, base: CaseSetup, op: "startup_setup" | "startup_setup_update", apply: boolean): SetupChange {
  const signals = csv(ctx.opts.signals);
  const targets = csv(ctx.opts.target);
  const imageTargets = [...csv(ctx.opts["image-target"]), ...csv(ctx.opts["face-ref"])];
  const removeTargets = csv(ctx.opts["remove-target"]);
  const notes = textList(ctx.opts.note);
  const sources = csv(ctx.opts.source);
  const removeSources = csv(ctx.opts["remove-source"]);
  const memories = csv(ctx.opts.memory);
  const indexSignals = memories.length ? [] : signals;
  const indexes = csv(ctx.opts.index).map((s) => parseIndexSpec(s, indexSignals));
  const removeIndexes = csv(ctx.opts["remove-index"]);
  const videos = csv(ctx.opts.video);
  const folders = csv(ctx.opts.folder);
  const providerSelections = parseProviderSelections(ctx.opts.provider);
  const indexableProviders = new Set(csv(ctx.opts["provider-indexable"]));
  const indexableProvidersSpecified = ctx.opts["provider-indexable"] != null;
  const autoSense = csv(ctx.opts["auto-sense"]);
  const autoSenseSpecified = ctx.opts["auto-sense"] != null;
  const findingsMode = ctx.opts.findings != null ? String(ctx.opts.findings).trim().toLowerCase() : "";
  const setup = cloneSetup(base);
  const operations: string[] = [];
  const noteRecords: OvercastRecord[] = [];
  let indexRoutesChanged = false;

  if (ctx.opts.name) {
    setup.case_name = String(ctx.opts.name);
    operations.push(`case name: ${setup.case_name}`);
    if (apply) ctx.case.setName(setup.case_name);
  }
  for (const t of targets) {
    if (!setup.targets.includes(t)) setup.targets.push(t);
    operations.push(`target add: ${t}`);
    if (apply && !listTargets(ctx.case).some((x) => x.value === t)) addTarget(ctx.case, t, { image: isImageTargetRef(t) });
  }
  for (const t of imageTargets) {
    if (!setup.targets.includes(t)) setup.targets.push(t);
    operations.push(`image target add: ${t}`);
    if (apply && !listTargets(ctx.case).some((x) => x.value === t)) addTarget(ctx.case, t, { image: true });
  }
  if (removeTargets.length) {
    const removeTargetValues = targetValuesForRemoval(ctx, removeTargets);
    setup.targets = setup.targets.filter((t) => !removeTargetValues.has(t));
    for (const t of removeTargets) {
      operations.push(`target remove: ${t}`);
      if (apply) {
        for (const existing of listTargets(ctx.case).filter((x) => x.id === t || x.value === t)) removeTarget(ctx.case, existing.id);
      }
    }
  }
  for (const note of notes) {
    const isNew = !setup.notes.includes(note);
    if (isNew) setup.notes.push(note);
    operations.push(isNew ? "note add" : "note already present");
    if (apply && isNew) {
      noteRecords.push(makeRecord({
        verb: "note",
        format: "json",
        payload: { text: note, source: "case setup" },
        meta: { case: ctx.case.dir },
        state: "ready",
      }));
    }
  }
  for (const spec of sources) {
    if (!setup.sources.includes(spec)) setup.sources.push(spec);
    operations.push(`source add: ${spec}`);
    if (apply && !listSources(ctx.case).some((s) => `${s.type}:${s.ref}` === spec)) addSource(ctx.case, spec);
  }
  if (memories.length) {
    const backend = normalizeSetupMemory(memories.at(-1)!)!;
    setup.memory = {
      backend,
      signals: signals.length ? signals : (setup.memory?.signals ?? DEFAULT_LOCAL_MEMORY_SIGNALS),
    };
    operations.push(`memory backend: ${backend} (${setup.memory.signals.join(", ")})`);
  } else {
    setup.memory ??= { backend: "local-grep", signals: DEFAULT_LOCAL_MEMORY_SIGNALS };
  }
  if (removeSources.length) {
    const removeSourceSpecs = sourceSpecsForRemoval(ctx, removeSources);
    setup.sources = setup.sources.filter((s) => !removeSourceSpecs.has(s));
    for (const spec of removeSources) {
      operations.push(`source remove: ${spec}`);
      if (apply) {
        const parsed = parseSourceSpec(spec);
        for (const existing of listSources(ctx.case).filter((s) => s.id === spec || (s.type === parsed.type && s.ref === parsed.ref))) {
          removeSource(ctx.case, existing.id);
        }
      }
    }
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
    if (apply && current.id) addIndex(ctx.case, { id: current.id, name: current.name, type: current.type });
  }
  if (removeIndexes.length) {
    const removedIndexes = setup.indexes.filter((i) => removeIndexes.includes(i.id ?? "") || removeIndexes.includes(i.name));
    setup.indexes = setup.indexes.filter((i) => !removeIndexes.includes(i.id ?? "") && !removeIndexes.includes(i.name));
    for (const index of removedIndexes) delete setup.default_signals[setupIndexRef(index)];
    indexRoutesChanged ||= removedIndexes.length > 0;
    for (const id of removeIndexes) {
      operations.push(`index remove: ${id}`);
      if (apply) {
        for (const existing of listIndexes(ctx.case).filter((i) => i.id === id || i.name === id)) removeIndex(ctx.case, existing.id);
      }
    }
  }
  for (const video of videos) {
    addVideoRoute(setup, video, signals);
    operations.push(`video route: ${video}`);
  }
  if (indexRoutesChanged) refreshSetupRouteIndexes(setup);
  for (const folder of folders) {
    if (!setup.media.folders.includes(folder)) setup.media.folders.push(folder);
    const files = folderMediaFiles(folder);
    for (const file of files) addVideoRoute(setup, file, signals);
    operations.push(`folder select: ${folder}${files.length ? ` (${files.length} media files)` : " (no media files found)"}`);
  }
  if (providerSelections.length) {
    setup.providers ??= {};
    for (const selection of providerSelections) {
      const choice = findProviderChoice(selection.verb, selection.choice);
      if (!selection.verb || !selection.choice || !choice) {
        operations.push(`provider selection invalid: ${selection.verb || "(missing verb)"}:${selection.choice || "(missing choice)"}`);
        continue;
      }
      const existingPolicy = setup.providers[selection.verb];
      setup.providers[selection.verb] = {
        verb: selection.verb,
        choice: selection.choice,
        profile: ctx.profileName ?? ctx.profile.name,
        indexable: indexableProvidersSpecified ? indexableProviders.has(selection.verb) : existingPolicy?.indexable === true,
        descriptor: choice.descriptor,
        env: choice.env ?? [],
        missing_env: (choice.env ?? []).filter((name) => !process.env[name]),
        updated_at: new Date().toISOString(),
      };
      operations.push(`provider policy: ${selection.verb}:${selection.choice}`);
    }
  }
  if (indexableProvidersSpecified) {
    setup.providers ??= {};
    for (const [verb, existing] of Object.entries(setup.providers)) {
      setup.providers[verb] = { ...existing, indexable: indexableProviders.has(verb), updated_at: new Date().toISOString() };
    }
    for (const verb of indexableProviders) {
      const existing = setup.providers[verb] ?? { verb, choice: "configured", profile: ctx.profileName ?? ctx.profile.name };
      setup.providers[verb] = { ...existing, indexable: true, updated_at: new Date().toISOString() };
    }
    operations.push(`provider indexable: ${indexableProviders.size ? [...indexableProviders].join(",") : "none"}`);
  }
  if (autoSenseSpecified || ctx.opts["auto-index-new"] != null || ctx.opts["no-auto-index-new"] != null) {
    setup.automation = {
      auto_sense: autoSenseSpecified ? autoSense : (setup.automation?.auto_sense ?? []),
      auto_index_new: ctx.opts["no-auto-index-new"] === true
        ? false
        : ctx.opts["auto-index-new"] === true
          ? true
          : setup.automation?.auto_index_new === true,
    };
    operations.push(`automation: senses=${setup.automation.auto_sense.join(",") || "none"} auto_index_new=${setup.automation.auto_index_new}`);
  } else {
    setup.automation ??= { auto_sense: [], auto_index_new: false };
  }
  if (findingsMode) {
    setup.findings = { mode: findingsMode };
    operations.push(`findings: ${findingsMode}`);
  } else {
    setup.findings ??= { mode: "off" };
  }
  if (!operations.length && op === "startup_setup") operations.push("save empty setup");

  setup.updated_at = new Date().toISOString();
  return { setup, operations, noteRecords };
}

function quoteCommandArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function incompletePlannedIndexes(setup: CaseSetup): SetupIndex[] {
  return setup.indexes.filter((index) => !index.id && index.mode !== "attach");
}

function currentCliInvocation(): { cmd: string; args: string[] } {
  if (process.env.OVERCAST_CMD) {
    const parts = tokenizeCommand(process.env.OVERCAST_CMD);
    if (parts.length > 0) return { cmd: parts[0], args: parts.slice(1) };
  }
  const script = process.argv[1];
  if (script && existsSync(script)) return { cmd: process.execPath, args: [script] };
  return { cmd: process.execPath, args: [] };
}

export const caseVerb: VerbSpec = {
  name: "case",
  group: "state",
  summary: "Inspect/manage the current case: init | setup | info | records | memory | clear.",
  description:
    "A case is the cwd folder + its .overcast/ store. `case init [dir] --name` stands it up; " +
    "`case setup` runs/saves first-run setup and `case setup status|show|edit|plan` manages it; " +
    "`case info` shows state; `case records [--verb] [--since]` lists records; " +
    "`case memory <list|get|search|index> [q]` routes to the bound memory providers. " +
    "`case clear` previews what would be lost; add `--yes` to clear records/media/state and configured materialized memory indexes while preserving the case id. " +
    "`case memory get <id>` returns a field manifest (sizes); add `--field <name> [--offset N] " +
    "[--limit M]` to page a large field (e.g. a watch `content`) in full — never head/tail the raw jsonl.",
  args: [
    { name: "action", summary: "init | setup | info | records | memory | clear", required: true },
    { name: "sub", summary: "setup/memory subcommand, or dir for init" },
    { name: "arg", summary: "record id (memory get), query (memory search), or index action" },
  ],
  flags: [
    { name: "name", summary: "Case name (init/setup/edit)", type: "string" },
    { name: "target", summary: "setup/edit: comma-separated target values to add", type: "string" },
    { name: "image-target", summary: "setup/edit: comma-separated reference image targets to add", type: "string" },
    { name: "face-ref", summary: "setup/edit: alias for --image-target for face matching references", type: "string" },
    { name: "remove-target", summary: "setup/edit: comma-separated target ids/values to remove", type: "string" },
    { name: "note", summary: "setup/edit: note text to add as local evidence; pass JSON array or newline-separated text for multiple notes", type: "string" },
    { name: "source", summary: "setup/edit: comma-separated source specs (<type>:<ref>) to add", type: "string" },
    { name: "remove-source", summary: "setup/edit: comma-separated source ids/specs to remove", type: "string" },
    { name: "index", summary: "setup/edit: comma-separated indexes (name:type or id:type:name)", type: "string" },
    { name: "remove-index", summary: "setup/edit: comma-separated index ids/names to remove", type: "string" },
    { name: "signals", summary: "setup/edit: comma-separated signals for new indexes/videos", type: "string" },
    { name: "provider", summary: "setup/edit: comma-separated provider choices (<verb>:<choice>) for this case", type: "string" },
    { name: "provider-indexable", summary: "setup/edit: comma-separated provider output verbs eligible for memory/indexing", type: "string" },
    { name: "auto-sense", summary: "setup/edit: comma-separated senses to run on newly captured media", type: "string" },
    { name: "auto-index-new", summary: "setup/edit: automatically add newly analyzed media to configured indexes", type: "boolean" },
    { name: "no-auto-index-new", summary: "setup/edit: disable automatic indexing for newly analyzed media", type: "boolean" },
    { name: "findings", summary: "setup/edit: automated finding workflow (off | review)", type: "string" },
    { name: "video", summary: "setup/edit: comma-separated local videos/URLs to route", type: "string" },
    { name: "folder", summary: "setup/edit: comma-separated local media folders to remember", type: "string" },
    { name: "no-index", summary: "setup/edit: save setup routes without starting remote collection ingestion", type: "boolean" },
    { name: "dry-run", summary: "setup/edit: preview without saving or applying", type: "boolean" },
    { name: "verb", summary: "Filter records by kind", type: "string" },
    { name: "since", summary: "Time filter (e.g. 24h, 2026-06-01)", type: "string" },
    { name: "field", summary: "Payload field to read in full (memory get)", type: "string" },
    { name: "offset", summary: "Start char offset when paging a field (memory get)", type: "number" },
    { name: "limit", summary: "Max records/passages, or max chars when paging a field", type: "number" },
    { name: "memory", summary: "Memory provider/backend for case memory index (e.g. local-grep, qmd)", type: "string" },
    { name: "yes", summary: "Confirm destructive case clear or non-interactive setup apply", type: "boolean" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "case",
  providerKey: "case",
  run: async (ctx) => {
    const action = ctx.input;

    if (action === "init") {
      const dir = ctx.rest[0] ?? ctx.case.dir;
      const c = openCase(dir);
      const info = c.ensure();
      if (ctx.opts.name) {
        // persist the chosen name
        const cur = c.info();
        cur.name = String(ctx.opts.name);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(c.caseFile, JSON.stringify(cur, null, 2) + "\n", "utf8");
        info.name = cur.name;
      }
      // Tag the record with the case it belongs to. When `case init <dir>`
      // targets a DIFFERENT case than the active one, persist it there and tag
      // it so the framework skips writing it into the active case's timeline
      // (see the meta.case guard in cli.ts / to-agent-tool.ts).
      const rec = makeRecord({
        verb: "case",
        format: "json",
        payload: { ...info, dir: c.dir },
        meta: { case: c.dir },
        state: "ready",
      });
      if (c.dir !== ctx.case.dir) c.writeRecord(rec);
      return [rec];
    }

    if (action === "info") {
      const c = ctx.case;
      const exists = c.exists();
      const recs = c.records();
      const counts: Record<string, number> = {};
      for (const r of recs) counts[r.verb] = (counts[r.verb] ?? 0) + 1;
      return [
        makeRecord({
          verb: "case",
          format: "json",
          payload: { dir: c.dir, initialized: exists, info: exists ? c.info() : null, records: recs.length, counts },
          state: "ready",
        }),
      ];
    }

    if (action === "setup") {
      const sub = ctx.rest[0] ?? "apply";
      const saved = loadSetup(ctx.case);
      if (sub === "status") {
        return [makeRecord({ verb: "case", format: "json", payload: setupHealth(ctx, saved), state: "ready" })];
      }
      if (sub === "show") {
        return [
          makeRecord({
            verb: "case",
            format: "json",
            payload: saved ? { ...saved } : { completed: false, setup_file: ctx.case.setupFile },
            state: saved ? "ready" : "pending",
          }),
        ];
      }
      if (sub !== "apply" && sub !== "edit" && sub !== "plan") {
        return [err("usage: case setup [status|show|edit|plan] [--name ... --target ... --source ... --index ... --video ... --yes]")];
      }

      const hasInputs = [
        "name",
        "target",
        "image-target",
        "face-ref",
        "remove-target",
        "note",
        "source",
        "remove-source",
        "index",
        "remove-index",
        "signals",
        "provider",
        "provider-indexable",
        "auto-sense",
        "auto-index-new",
        "no-auto-index-new",
        "findings",
        "video",
        "folder",
        "memory",
      ].some((k) => ctx.opts[k] != null);
      if (!hasInputs && sub !== "plan" && ctx.opts.yes !== true) {
        const setupCompleted = saved?.completed ?? false;
        return [
          makeRecord({
            verb: "case",
            format: "json",
            payload: {
              completed: setupCompleted,
              status: setupCompleted ? "case setup complete" : "case has not been set up yet",
              setup_file: ctx.case.setupFile,
              wizard_steps: [
                "1. Case name",
                "2. Investigation target",
                "3. Sources or local media",
                "4. Indexes/search destinations",
                "5. Notes",
                "6. Preview and apply",
              ],
              next: [
                "overcast case setup --name \"Case name\" --target \"target\" --memory local-grep --source \"web:query\" --yes",
                "overcast case setup plan --target \"target\" --memory local-grep --source \"web:query\"",
                "overcast case setup edit --target \"new target\" --yes",
              ],
              note: setupCompleted
                ? "case setup is complete; use case setup status/show to inspect it or case setup edit to change it"
                : "case has not been set up yet; in the TUI, ask the user one wizard question at a time, or pass setup flags directly on the CLI",
            },
            meta: { transient: true },
            state: "pending",
          }),
        ];
      }

      const isPlan = sub === "plan" || ctx.opts["dry-run"] === true || ctx.opts.yes !== true;
      const caseName = saved?.case_name ?? (ctx.case.exists() ? ctx.case.info().name : ctx.case.dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "case");
      const base = saved ?? setupFromExistingRegistries(ctx, caseName);
      for (const memory of csv(ctx.opts.memory)) {
        if (!normalizeSetupMemory(memory)) return [err(`case setup needs one local memory backend: local-grep or qmd (got '${memory}')`)];
      }
      for (const selection of parseProviderSelections(ctx.opts.provider)) {
        if (!selection.verb || !selection.choice || !findProviderChoice(selection.verb, selection.choice)) {
          return [err(`unknown provider choice '${selection.choice || "(missing)"}' for verb '${selection.verb || "(missing)"}'`)];
        }
      }
      for (const verb of csv(ctx.opts["auto-sense"])) {
        if (!["watch", "listen", "see", "face", "enhance"].includes(verb)) {
          return [err(`unknown --auto-sense verb '${verb}' (expected watch, listen, see, face, enhance)`)];
        }
      }
      if (ctx.opts.findings != null && !["off", "review"].includes(String(ctx.opts.findings).trim().toLowerCase())) {
        return [err(`unknown --findings mode '${ctx.opts.findings}' (expected off | review)`)];
      }
      const op = saved ? "startup_setup_update" : "startup_setup";
      const before = summarizeSavedSetup(saved);
      const change = buildSetupChange(ctx, base, op, !isPlan);
      if (!isPlan) {
        change.setup.completed = false;
        saveSetup(ctx.case, change.setup);
      }
      const workRecords = !isPlan && ctx.opts["no-index"] !== true ? await applySetupIndexing(ctx, change.setup, change.operations) : [];
      const incompleteIndexes = incompletePlannedIndexes(change.setup);
      if (incompleteIndexes.length) change.setup.completed = false;
      else if (!isPlan) change.setup.completed = true;
      const after = summarizeSavedSetup(change.setup);
      const setupRecord = makeRecord({
        verb: "case",
        format: "json",
        payload: {
          op,
          saved: !isPlan,
          setup_file: ctx.case.setupFile,
          before,
          after,
          applied_operations: isPlan ? [] : change.operations,
          planned_operations: change.operations,
          work_preview: {
            save_setup: !isPlan,
            note_records: change.noteRecords.length,
            local_media_files: change.setup.media.videos.length,
            remote_indexes: change.setup.indexes.map((index) => ({ name: index.name, type: index.type, mode: index.mode ?? (index.id ? "attach" : "create") })),
            will_start_indexing: !isPlan && ctx.opts["no-index"] !== true && change.setup.indexes.length > 0,
            automation: change.setup.automation ?? { auto_sense: [], auto_index_new: false },
          },
          incomplete_indexes: incompleteIndexes.map((index) => ({ name: index.name, type: index.type })),
          confirmation_required: isPlan && sub !== "plan" && ctx.opts["dry-run"] !== true,
          confirm_with: isPlan && sub !== "plan" && ctx.opts["dry-run"] !== true ? "overcast case setup ... --yes" : undefined,
        },
        meta: isPlan ? { transient: true } : { case: ctx.case.dir },
        state: isPlan || incompleteIndexes.length ? "pending" : "ready",
      });
      if (!isPlan) {
        change.setup.last_update_record_id = setupRecord.id;
        saveSetup(ctx.case, change.setup);
      }
      return [...change.noteRecords, ...workRecords, setupRecord];
    }

    if (action === "clear") {
      const confirmed = ctx.opts.yes === true;
      const before = ctx.case.clearSummary();
      let memoryCleared: unknown[] = [];
      if (confirmed) {
        memoryCleared = await Promise.all(resolveMemory(ctx.case, ctx.profile)
          .filter((p) => typeof p.clear === "function")
          .map(async (p) => {
            try {
              return await p.clear!();
            } catch (e) {
              return {
                provider: p.id,
                backend: p.backend ?? p.id,
                state: "error",
                error: (e as Error).message,
              };
            }
          }));
        ctx.case.clear();
      }
      const lost = {
        records: before.records,
        counts: before.counts,
        media_files: before.media.files,
        media_size: humanSize(before.media.bytes),
        index_files: before.index.files,
        index_size: humanSize(before.index.bytes),
        artifacts: before.artifacts,
        state_files: before.stateFiles,
      };
      if (!confirmed) {
        return [
          makeRecord({
            verb: "case",
            format: "json",
            payload: {
              dir: before.dir,
              initialized: before.initialized,
              info: before.info,
              will_lose: lost,
              confirmation_required: true,
              confirm_with: "overcast case clear --yes",
              note: "case id/name are preserved; records, media, indexes, targets, sources, and seen state are cleared",
            },
            meta: { transient: true },
            state: "pending",
          }),
        ];
      }
      return [
        makeRecord({
          verb: "case",
          format: "json",
          payload: {
            dir: before.dir,
            initialized: before.initialized,
            info: before.info,
            cleared: true,
            lost,
            preserved: ["case.json"],
            memory_indexes_cleared: memoryCleared,
          },
          meta: { transient: true },
          state: "ready",
        }),
      ];
    }

    if (action === "records") {
      let recs = ctx.case.records();
      if (ctx.opts.verb) recs = recs.filter((r) => r.verb === String(ctx.opts.verb));
      if (ctx.opts.since) {
        const cutoff = parseSince(String(ctx.opts.since));
        // an unparseable --since is a user error, not a silent "no time bound"
        if (cutoff == null) {
          return [err(`invalid --since: ${ctx.opts.since} (try 24h, 7d, or 2026-06-01)`)];
        }
        recs = recs.filter((r) => {
          const t = r.meta?.time ? Date.parse(String(r.meta.time)) : NaN;
          return Number.isNaN(t) || t >= cutoff;
        });
      }
      // a non-finite/negative --limit must not silently empty or trim the list
      let limit = 50;
      if (ctx.opts.limit != null) {
        const n = Number(ctx.opts.limit);
        if (!Number.isFinite(n) || n <= 0) {
          return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
        }
        limit = n;
      }
      const view = recs.slice(0, limit).map((r) => ({
        id: r.id, verb: r.verb, state: r.state ?? "ready", media: r.media?.ref ?? null,
      }));
      return [makeRecord({ verb: "case", format: "json", payload: { count: recs.length, records: view }, state: "ready" })];
    }

    if (action === "memory") {
      const sub = ctx.rest[0];
      const providers = resolveMemory(ctx.case, ctx.profile);
      if (sub === "list") {
        return [makeRecord({
          verb: "case",
          format: "json",
          payload: {
            providers: providers.map((p) => ({
              id: p.id,
              backend: p.backend ?? p.id,
              aliases: p.aliases ?? [],
              indexable: !!p.rebuild,
            })),
          },
          state: "ready",
        })];
      }
      if (sub === "get") {
        const id = ctx.rest[1];
        if (!id) return [err("usage: case memory get <record-id> [--field <name>] [--offset N] [--limit M]")];
        const rec = ctx.case.recordById(id);
        if (!rec) {
          // records are per-case — a record saved in one case isn't visible from
          // another. Name the current case so a wrong-cwd lookup is obvious (the
          // common footgun: `cd`-ing elsewhere before re-reading a record).
          const msg = `no record ${id} in this case (${ctx.case.dir}) — records are per-case; cd back to the case you ran it in, or pass --case <dir>`;
          return [makeRecord({ verb: "case", format: "json", payload: { record: id, found: false, case: ctx.case.dir }, state: "error", error: msg })];
        }

        // A record's payload is a set of named fields — object keys, or the single
        // implicit "(text)" for a string payload. String and object travel the
        // SAME path from here (no isString branches): enumerate via fieldNames,
        // address via getField, measure/slice via fieldText.
        const field = ctx.opts.field != null ? String(ctx.opts.field) : undefined;
        const hasPaging = ctx.opts.offset != null || ctx.opts.limit != null;
        const names = fieldNames(rec.payload);

        // Bare `get <id>` (no --field, no paging flags) → a field manifest of how
        // to read the record — name/type/size + chars (the unit paging counts in).
        if (field == null && !hasPaging) {
          const fields = payloadFields(rec.payload).map((f) => ({
            name: f.name,
            type: f.type,
            size: f.size,
            chars: f.chars,
            ...(f.count != null ? { count: f.count } : {}),
            preview: redactSecrets(f.preview),
          }));
          return [
            makeRecord({
              verb: "case",
              format: "json",
              payload: { record: rec.id, verb: rec.verb, state: rec.state ?? "ready", media: rec.media ?? null, fields },
              // a preview of this envelope points paging at the TARGET record
              meta: { pageTarget: rec.id },
              state: "ready",
            }),
          ];
        }

        // Resolve the field to page. Omitting --field is only unambiguous when the
        // record has exactly one field (a string payload's "(text)"); a multi-field
        // object payload needs --field, so --offset/--limit can't silently no-op.
        let target = field;
        if (target == null) {
          if (names.length === 1) target = names[0];
          else return [err(`case memory get ${id}: --field <name> required to page an object payload (fields: ${names.join(", ")})`)];
        }
        const value = getField(rec.payload, target);
        if (value === undefined) {
          return [err(`record ${id} has no field '${target}' (fields: ${names.join(", ")})`)];
        }
        // same canonical redacted text the manifest measured (guarded; never throws)
        const text = pageText(value);
        const total = text.length;

        let offset = 0;
        if (ctx.opts.offset != null) {
          const n = Number(ctx.opts.offset);
          if (!Number.isFinite(n) || n < 0) return [err(`invalid --offset: ${ctx.opts.offset} (expected a non-negative number)`)];
          // an overshoot must NOT silently clamp to the end (looks like a clean
          // end-of-field and can stop paging before earlier ranges were read).
          if (n > total) return [err(`--offset ${n} is past the end of field '${target}' (${total} chars)`)];
          offset = n;
        }
        let limit = 16000;
        if (ctx.opts.limit != null) {
          const n = Number(ctx.opts.limit);
          if (!Number.isFinite(n) || n <= 0) return [err(`invalid --limit: ${ctx.opts.limit} (expected a positive number)`)];
          limit = n;
        }
        const chunk = text.slice(offset, offset + limit);
        const nextOffset = offset + chunk.length;
        const hasMore = nextOffset < total;
        return [
          makeRecord({
            verb: "case",
            format: "txt",
            payload: {
              record: id,
              field: target,
              offset,
              limit,
              total,
              returned: chunk.length,
              has_more: hasMore,
              next_offset: hasMore ? nextOffset : null,
              chunk,
            },
            meta: { pageTarget: id },
            state: "ready",
          }),
        ];
      }
      if (sub === "search") {
        const q = ctx.rest.slice(1).join(" ");
        if (!q) return [err("case memory search <query>")];
        let limit = 8;
        if (ctx.opts.limit != null) {
          const n = Number(ctx.opts.limit);
          if (!Number.isFinite(n) || n <= 0) {
            return [err(`case memory search: invalid --limit '${ctx.opts.limit}' (expected a positive number)`)];
          }
          limit = n;
        }
        const requested = ctx.opts.memory ? String(ctx.opts.memory) : undefined;
        const selected = requested
          ? providers.filter((p) => requested.split(",").map((s) => s.trim()).filter(Boolean).some((id) => matchesMemoryProvider(p, id)))
          : providers.filter((p) => matchesMemoryProvider(p, "local-grep"));
        if (selected.length === 0) {
          return [err(`no memory provider matches --memory ${requested} (available: ${providers.map((p) => p.id).join(", ") || "none"})`)];
        }
        const batches = await Promise.all(selected.map((p) => p.query(q, { limit })));
        const seen = new Set<string>();
        const passages = batches.flat().filter((p) => {
          const key = `${p.recordId}|${JSON.stringify(p.at)}|${p.field ?? ""}|${p.provider ?? ""}|${p.text}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).sort((a, b) => b.score - a.score).slice(0, limit);
        return [makeRecord({ verb: "case", format: "json", payload: { query: q, passages }, state: "ready" })];
      }
      if (sub === "index") {
        const action = ctx.rest[1] ?? "status";
        const providerName = ctx.opts.memory ? String(ctx.opts.memory) : undefined;
        const selected = providerName
          ? providers.filter((p) => matchesMemoryProvider(p, providerName))
          : providers;
        if (providerName && selected.length === 0) {
          return [err(`no memory provider matches --memory ${providerName} (available: ${providers.map((p) => p.id).join(", ")})`)];
        }
        if (action === "status") {
          const statuses = [];
          for (const p of selected) {
            statuses.push(p.status ? await p.status() : { provider: p.id, backend: p.backend ?? p.id, state: "ready" });
          }
          return [makeRecord({ verb: "case", format: "json", payload: { memory_index: statuses }, state: "ready" })];
        }
        if (action === "rebuild" || action === "retry") {
          const statuses = [];
          for (const p of selected) {
            statuses.push(p.rebuild ? await p.rebuild() : { provider: p.id, backend: p.backend ?? p.id, state: "ready" });
          }
          const failed = statuses.filter((s) => s.state === "error");
          return [makeRecord({ verb: "case", format: "json", payload: { memory_index: statuses }, state: failed.length ? "error" : "ready", error: failed[0]?.error })];
        }
        if (action === "start") {
          const job = `job_${Date.now().toString(36)}`;
          const jobsDir = join(ctx.case.indexDir, "jobs");
          mkdirSync(jobsDir, { recursive: true });
          const jobFile = join(jobsDir, `${job}.json`);
          const invocation = currentCliInvocation();
          const args = [
            "case", "memory", "index", "rebuild",
            "--case", ctx.case.dir,
            ...(ctx.home ? ["--home", ctx.home] : []),
            ...(ctx.profileName ? ["--profile", ctx.profileName] : []),
            ...(providerName ? ["--memory", providerName] : []),
            "--json",
          ];
          const command = [invocation.cmd, ...invocation.args, ...args].map(quoteCommandArg).join(" ");
          const logFile = join(jobsDir, `${job}.log`);
          const scriptFile = join(jobsDir, `${job}.sh`);
          const jobPayload = { id: job, state: "queued", command, provider: providerName ?? "all", created: new Date().toISOString(), log_file: logFile };
          writeFileSync(jobFile, JSON.stringify(jobPayload, null, 2) + "\n", "utf8");
          const runningPayload = { ...jobPayload, state: "running" };
          const readyPayload = { ...jobPayload, state: "ready" };
          const script = [
            "#!/bin/sh",
            `cat > ${quoteCommandArg(jobFile)} <<'JSON'`,
            JSON.stringify(runningPayload, null, 2),
            "JSON",
            `${command} > ${quoteCommandArg(logFile)} 2>&1`,
            "rc=$?",
            "if [ \"$rc\" -eq 0 ]; then",
            `cat > ${quoteCommandArg(jobFile)} <<'JSON'`,
            JSON.stringify(readyPayload, null, 2),
            "JSON",
            "else",
            `cat > ${quoteCommandArg(jobFile)} <<'JSON'`,
            JSON.stringify({ ...jobPayload, state: "error", error: "rebuild failed; see log_file" }, null, 2),
            "JSON",
            "fi",
            "",
          ].join("\n");
          writeFileSync(scriptFile, script, "utf8");
          chmodSync(scriptFile, 0o755);
          try {
            const child = spawn("/bin/sh", [scriptFile], { detached: true, stdio: "ignore", env: process.env });
            child.unref();
          } catch (e) {
            const error = (e as Error).message;
            const failed = { ...jobPayload, state: "error", error };
            writeFileSync(jobFile, JSON.stringify(failed, null, 2) + "\n", "utf8");
            return [makeRecord({ verb: "case", format: "json", payload: { job: failed, job_file: jobFile }, state: "error", error })];
          }
          return [makeRecord({ verb: "case", format: "json", payload: { job: jobPayload, job_file: jobFile }, state: "pending" })];
        }
        return [err("usage: case memory index <status|rebuild|start|retry> [--memory <provider>]")];
      }
      return [err("usage: case memory <list|get|search|index> [arg]")];
    }

    return [err("usage: case <init|setup|info|records|memory|clear>")];
  },
};
