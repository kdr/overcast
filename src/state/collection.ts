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

/** Resolve a collection by id (exact) or, failing that, by name. */
export function findCollection(c: Case, idOrName: string): CollectionEntry | undefined {
  const all = load(c).collections;
  return all.find((x) => x.id === idOrName) ?? all.find((x) => x.name === idOrName);
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

export function removeCollection(c: Case, id: string): boolean {
  const store = load(c);
  const before = store.collections.length;
  store.collections = store.collections.filter((x) => x.id !== id && x.name !== id);
  save(c, store);
  return store.collections.length < before;
}

/** Add a member video to a mirrored collection (dedupe by ref). Returns false
 *  when the collection isn't in the mirror. */
export function addMember(c: Case, id: string, member: Omit<CollectionMember, "added">): boolean {
  const store = load(c);
  const col = store.collections.find((x) => x.id === id || x.name === id);
  if (!col) return false;
  if (!col.members.some((m) => m.ref === member.ref)) {
    col.members.push({ ...member, added: new Date().toISOString() });
    save(c, store);
  }
  return true;
}

export function removeMember(c: Case, id: string, ref: string): boolean {
  const store = load(c);
  const col = store.collections.find((x) => x.id === id || x.name === id);
  if (!col) return false;
  const before = col.members.length;
  col.members = col.members.filter((m) => m.ref !== ref);
  save(c, store);
  return col.members.length < before;
}
