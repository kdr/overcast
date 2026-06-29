// index registry = the tinycloud-backed indexes this case manages, mirrored
// to .overcast/indexes.json. An index is a remote (Cloudglue) corpus of
// videos that makes them searchable one way per TYPE:
//   media-descriptions → ask / probe / search   (general Q&A + semantic search)
//   entities           → index entities           (same schema across all videos)
//   face-analysis      → face list / face search  (detect + find a person)
//   rich-transcripts   → transcript artifacts
// The lifecycle ops live on tinycloud (create/add/show/delete); this file is the
// LOCAL mirror so the case knows which indexes + members it owns, the OSINT
// twin of the source/target registries.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Case } from "../case.js";

/** The canonical tinycloud index types. */
export type IndexType =
  | "media-descriptions"
  | "entities"
  | "face-analysis"
  | "rich-transcripts"
  | "deepface-local"
  | "image-ransac";

export interface IndexMember {
  /** the video ref registered (path / URL) */
  ref: string;
  /** the case record this member came from (capture/watch/scan), if any */
  recordId?: string;
  /** tinycloud file id, when reported by `index add` */
  fileId?: string;
  added: string;
}

export interface IndexEntry {
  /** the tinycloud-backed index id (col_…) — the key ask/face/entities address */
  id: string;
  /** index type (drives which read verb can use it) */
  type: IndexType | string;
  /** where the searchable data lives; omitted legacy entries are tinycloud */
  backend?: "tinycloud" | "local" | string;
  name: string;
  description?: string;
  members: IndexMember[];
  created: string;
}

export interface IndexStore {
  indexes: IndexEntry[];
}

interface LegacyCollectionStore {
  collections?: IndexEntry[];
}

/** Friendly aliases → canonical tinycloud type. Returns undefined for unknown. */
export function normalizeIndexType(input: string): IndexType | undefined {
  const t = input.trim().toLowerCase().replace(/_/g, "-");
  switch (t) {
    case "media-descriptions":
    case "media-description":
    case "media":
    case "descriptions":
    case "description":
    case "ask":
      return "media-descriptions";
    case "entities":
    case "entity":
      return "entities";
    case "face-analysis":
    case "face":
    case "faces":
      return "face-analysis";
    case "deepface-local":
    case "local-face":
    case "local-faces":
      return "deepface-local";
    case "image-ransac":
    case "image":
    case "images":
    case "visual":
      return "image-ransac";
    case "rich-transcripts":
    case "rich-transcript":
    case "transcripts":
    case "transcript":
      return "rich-transcripts";
    default:
      return undefined;
  }
}

function load(c: Case): IndexStore {
  const readStore = (file: string): IndexStore => {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<IndexStore> & LegacyCollectionStore;
    // guard valid-JSON-but-wrong-shape (hand edit, partial write, schema drift):
    // every caller does .find/.filter/.map on .indexes, so a non-array would
    // throw on every command and never self-heal. Fall back to empty instead.
    if (parsed && Array.isArray(parsed.indexes)) return parsed as IndexStore;
    if (parsed && Array.isArray(parsed.collections)) return { indexes: parsed.collections };
    return { indexes: [] };
  };
  try {
    if (existsSync(c.indexesFile)) return readStore(c.indexesFile);
    const legacyFile = join(c.storeDir, "collections.json");
    if (existsSync(legacyFile)) return readStore(legacyFile);
    return { indexes: [] };
  } catch {
    return { indexes: [] };
  }
}

function save(c: Case, store: IndexStore): void {
  mkdirSync(dirname(c.indexesFile), { recursive: true });
  writeFileSync(c.indexesFile, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function listIndexes(c: Case): IndexEntry[] {
  return load(c).indexes;
}

export function indexesByType(c: Case, type: IndexType | string): IndexEntry[] {
  return load(c).indexes.filter((x) => x.type === type);
}

/** Resolve an index by id (exact) or by a UNIQUE display name. An ambiguous
 *  name (shared by >1 entry) returns undefined here — callers should use
 *  resolveIndexRef when they want a clear ambiguity error. */
export function findIndex(c: Case, idOrName: string): IndexEntry | undefined {
  const all = load(c).indexes;
  const byId = all.find((x) => x.id === idOrName);
  if (byId) return byId;
  const byName = all.filter((x) => x.name === idOrName);
  return byName.length === 1 ? byName[0] : undefined;
}

/** Resolve an id/name to a single mirror entry, distinguishing "ambiguous name"
 *  (an error) from "not mirrored" (the value is likely a raw remote id). An id
 *  match always wins; a name shared by >1 entry is an error rather than a silent
 *  first-match that could hit the wrong index. */
export function resolveIndexRef(
  c: Case,
  idOrName: string,
): { entry?: IndexEntry; error?: string } {
  const all = load(c).indexes;
  const byId = all.find((x) => x.id === idOrName);
  if (byId) return { entry: byId };
  const byName = all.filter((x) => x.name === idOrName);
  if (byName.length > 1) {
    return { error: `'${idOrName}' matches ${byName.length} indexes by name; use the id (${byName.map((x) => x.id).join(", ")})` };
  }
  if (byName.length === 1) return { entry: byName[0] };
  return {}; // not in the mirror — treat as a raw tinycloud id
}

/** Record a newly-created index in the mirror (upsert by id). */
export function addIndex(
  c: Case,
  entry: { id: string; type: IndexType | string; name: string; description?: string; backend?: "tinycloud" | "local" | string },
): IndexEntry {
  const store = load(c);
  const existing = store.indexes.find((x) => x.id === entry.id);
  if (existing) {
    existing.type = entry.type;
    existing.name = entry.name;
    if (entry.backend !== undefined) existing.backend = entry.backend;
    if (entry.description !== undefined) existing.description = entry.description;
    save(c, store);
    return existing;
  }
  const created: IndexEntry = {
    id: entry.id,
    type: entry.type,
    backend: entry.backend,
    name: entry.name,
    description: entry.description,
    members: [],
    created: new Date().toISOString(),
  };
  store.indexes.push(created);
  save(c, store);
  return created;
}

/** Remove a mirrored index by its tinycloud id ONLY — callers resolve a
 *  user-given name to the id first (findIndex), so matching `name` here too
 *  would let one delete drop an unrelated entry that merely shares the string as
 *  its display name. */
export function removeIndex(c: Case, id: string): boolean {
  const store = load(c);
  const before = store.indexes.length;
  store.indexes = store.indexes.filter((x) => x.id !== id);
  save(c, store);
  return store.indexes.length < before;
}

/** Add a member video to a mirrored index (dedupe by ref). Matches by
 *  tinycloud id ONLY (callers resolve names first) — matching `name` too could
 *  record the member on the wrong entry, the same hazard removeIndex avoids.
 *  Returns false when the id isn't in the mirror. */
export function addMember(c: Case, id: string, member: Omit<IndexMember, "added">): boolean {
  const store = load(c);
  const col = store.indexes.find((x) => x.id === id);
  if (!col) return false;
  if (!col.members.some((m) => m.ref === member.ref)) {
    col.members.push({ ...member, added: new Date().toISOString() });
    save(c, store);
  }
  return true;
}

/** Replace the mirrored membership list for a remote index. Used by attach/sync
 *  so stale remote files disappear locally instead of accumulating forever. */
export function setMembers(c: Case, id: string, members: Omit<IndexMember, "added">[]): boolean {
  const store = load(c);
  const col = store.indexes.find((x) => x.id === id);
  if (!col) return false;
  const existingAdded = new Map(col.members.map((m) => [m.ref, m.added]));
  const seen = new Set<string>();
  const now = new Date().toISOString();
  col.members = [];
  for (const member of members) {
    if (seen.has(member.ref)) continue;
    seen.add(member.ref);
    col.members.push({ ...member, added: existingAdded.get(member.ref) ?? now });
  }
  save(c, store);
  return true;
}

export function removeMember(c: Case, id: string, ref: string): boolean {
  const store = load(c);
  const col = store.indexes.find((x) => x.id === id); // id-only (see addMember)
  if (!col) return false;
  const before = col.members.length;
  col.members = col.members.filter((m) => m.ref !== ref);
  save(c, store);
  return col.members.length < before;
}
