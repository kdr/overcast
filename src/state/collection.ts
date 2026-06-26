// collection registry = the tinycloud collections this case manages, mirrored
// to .overcast/collections.json. A collection is a remote (Cloudglue) index of
// videos that makes them searchable one way per TYPE:
//   media-descriptions → ask / probe / search   (general Q&A + semantic search)
//   entities           → collection entities      (same schema across all videos)
//   face-analysis      → face list / face search  (detect + find a person)
//   rich-transcripts   → transcript artifacts
// The lifecycle ops live on tinycloud (create/add/show/delete); this file is the
// LOCAL mirror so the case knows which collections + members it owns, the OSINT
// twin of the source/target registries.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Case } from "../case.js";

/** The canonical tinycloud collection types. */
export type CollectionType =
  | "media-descriptions"
  | "entities"
  | "face-analysis"
  | "rich-transcripts";

export interface CollectionMember {
  /** the video ref registered (path / URL) */
  ref: string;
  /** the case record this member came from (capture/watch/scan), if any */
  recordId?: string;
  /** tinycloud file id, when reported by `collections add` */
  fileId?: string;
  added: string;
}

export interface CollectionEntry {
  /** the tinycloud collection id (col_…) — the key ask/face/entities address */
  id: string;
  /** collection type (drives which read verb can use it) */
  type: CollectionType | string;
  name: string;
  description?: string;
  members: CollectionMember[];
  created: string;
}

export interface CollectionStore {
  collections: CollectionEntry[];
}

/** Friendly aliases → canonical tinycloud type. Returns undefined for unknown. */
export function normalizeCollectionType(input: string): CollectionType | undefined {
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
    case "rich-transcripts":
    case "rich-transcript":
    case "transcripts":
    case "transcript":
      return "rich-transcripts";
    default:
      return undefined;
  }
}

function load(c: Case): CollectionStore {
  if (!existsSync(c.collectionsFile)) return { collections: [] };
  try {
    return JSON.parse(readFileSync(c.collectionsFile, "utf8")) as CollectionStore;
  } catch {
    return { collections: [] };
  }
}

function save(c: Case, store: CollectionStore): void {
  mkdirSync(join(c.collectionsFile, ".."), { recursive: true });
  writeFileSync(c.collectionsFile, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function listCollections(c: Case): CollectionEntry[] {
  return load(c).collections;
}

export function collectionsByType(c: Case, type: CollectionType | string): CollectionEntry[] {
  return load(c).collections.filter((x) => x.type === type);
}

/** Resolve a collection by id (exact) or by a UNIQUE display name. An ambiguous
 *  name (shared by >1 entry) returns undefined here — callers should use
 *  resolveCollectionRef when they want a clear ambiguity error. */
export function findCollection(c: Case, idOrName: string): CollectionEntry | undefined {
  const all = load(c).collections;
  const byId = all.find((x) => x.id === idOrName);
  if (byId) return byId;
  const byName = all.filter((x) => x.name === idOrName);
  return byName.length === 1 ? byName[0] : undefined;
}

/** Resolve an id/name to a single mirror entry, distinguishing "ambiguous name"
 *  (an error) from "not mirrored" (the value is likely a raw remote id). An id
 *  match always wins; a name shared by >1 entry is an error rather than a silent
 *  first-match that could hit the wrong index. */
export function resolveCollectionRef(
  c: Case,
  idOrName: string,
): { entry?: CollectionEntry; error?: string } {
  const all = load(c).collections;
  const byId = all.find((x) => x.id === idOrName);
  if (byId) return { entry: byId };
  const byName = all.filter((x) => x.name === idOrName);
  if (byName.length > 1) {
    return { error: `'${idOrName}' matches ${byName.length} collections by name; use the id (${byName.map((x) => x.id).join(", ")})` };
  }
  if (byName.length === 1) return { entry: byName[0] };
  return {}; // not in the mirror — treat as a raw tinycloud id
}

/** Record a newly-created collection in the mirror (upsert by id). */
export function addCollection(
  c: Case,
  entry: { id: string; type: CollectionType | string; name: string; description?: string },
): CollectionEntry {
  const store = load(c);
  const existing = store.collections.find((x) => x.id === entry.id);
  if (existing) {
    existing.type = entry.type;
    existing.name = entry.name;
    if (entry.description !== undefined) existing.description = entry.description;
    save(c, store);
    return existing;
  }
  const created: CollectionEntry = {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    description: entry.description,
    members: [],
    created: new Date().toISOString(),
  };
  store.collections.push(created);
  save(c, store);
  return created;
}

/** Remove a mirrored collection by its tinycloud id ONLY — callers resolve a
 *  user-given name to the id first (findCollection), so matching `name` here too
 *  would let one delete drop an unrelated entry that merely shares the string as
 *  its display name. */
export function removeCollection(c: Case, id: string): boolean {
  const store = load(c);
  const before = store.collections.length;
  store.collections = store.collections.filter((x) => x.id !== id);
  save(c, store);
  return store.collections.length < before;
}

/** Add a member video to a mirrored collection (dedupe by ref). Matches by
 *  tinycloud id ONLY (callers resolve names first) — matching `name` too could
 *  record the member on the wrong entry, the same hazard removeCollection avoids.
 *  Returns false when the id isn't in the mirror. */
export function addMember(c: Case, id: string, member: Omit<CollectionMember, "added">): boolean {
  const store = load(c);
  const col = store.collections.find((x) => x.id === id);
  if (!col) return false;
  if (!col.members.some((m) => m.ref === member.ref)) {
    col.members.push({ ...member, added: new Date().toISOString() });
    save(c, store);
  }
  return true;
}

export function removeMember(c: Case, id: string, ref: string): boolean {
  const store = load(c);
  const col = store.collections.find((x) => x.id === id); // id-only (see addMember)
  if (!col) return false;
  const before = col.members.length;
  col.members = col.members.filter((m) => m.ref !== ref);
  save(c, store);
  return col.members.length < before;
}
