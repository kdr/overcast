// source registry = where to look, persisted to .overcast/sources.json. Each
// source has a `type` backed by a source provider (the OSINT twin of a sense
// provider). `scan`/`monitor` enumerate sources; `capture` fetches. There is no
// separate `scrape` verb — binding a source IS the scraper.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Case } from "../case.js";

export interface SourceEntry {
  id: string;
  /** provider type: youtube | tiktok | web | rss | folder | fixture | ... */
  type: string;
  /** the bound ref: handle/channel/playlist/hashtag/keyword/url/path */
  ref: string;
  name?: string;
  enabled: boolean;
  created: string;
}

export interface SourceStore {
  sources: SourceEntry[];
}

function load(c: Case): SourceStore {
  if (!existsSync(c.sourcesFile)) return { sources: [] };
  try {
    return JSON.parse(readFileSync(c.sourcesFile, "utf8")) as SourceStore;
  } catch {
    return { sources: [] };
  }
}

function save(c: Case, store: SourceStore): void {
  mkdirSync(join(c.sourcesFile, ".."), { recursive: true });
  writeFileSync(c.sourcesFile, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** Parse a `<type>:<ref>` source spec (ref may itself contain ':'). */
export function parseSourceSpec(spec: string): { type: string; ref: string } {
  const idx = spec.indexOf(":");
  if (idx < 0) return { type: spec, ref: "" };
  return { type: spec.slice(0, idx), ref: spec.slice(idx + 1) };
}

export function listSources(c: Case): SourceEntry[] {
  return load(c).sources;
}

export function enabledSources(c: Case): SourceEntry[] {
  return load(c).sources.filter((s) => s.enabled);
}

export function addSource(
  c: Case,
  spec: string,
  opts: { name?: string } = {},
): SourceEntry {
  const { type, ref } = parseSourceSpec(spec);
  const store = load(c);
  const entry: SourceEntry = {
    id: "src_" + randomBytes(3).toString("hex"),
    type,
    ref,
    name: opts.name,
    enabled: true,
    created: new Date().toISOString(),
  };
  store.sources.push(entry);
  save(c, store);
  return entry;
}

export function setEnabled(c: Case, id: string, enabled: boolean): boolean {
  const store = load(c);
  const s = store.sources.find((x) => x.id === id);
  if (!s) return false;
  s.enabled = enabled;
  save(c, store);
  return true;
}

export function removeSource(c: Case, id: string): boolean {
  const store = load(c);
  const before = store.sources.length;
  store.sources = store.sources.filter((s) => s.id !== id);
  save(c, store);
  return store.sources.length < before;
}

/** Resolve sources by id list (default: all enabled). */
export function resolveSources(c: Case, ids?: string[]): SourceEntry[] {
  const all = listSources(c);
  if (ids && ids.length) {
    const set = new Set(ids);
    return all.filter((s) => set.has(s.id) || set.has(s.type));
  }
  return all.filter((s) => s.enabled);
}
