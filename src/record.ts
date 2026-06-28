// The record — overcast's loose, indexable output contract.
//
// Invariant (CLAUDE.md #3): the record is loose. The contract is exactly
//   { id, verb, format(json|md|txt), payload, media?{ref,at}, meta?, error?, state? }
// and nothing more. We deliberately do NOT reintroduce tinycloud's rigid
// envelope; provider output is mapped to this shape at the exec boundary.
//
// `state` and `error` are the only (optional) control fields; consumers treat a
// missing `state` as "ready".

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type RecordFormat = "json" | "md" | "txt";

/** Free-string hint; producers SHOULD use these, consumers MUST tolerate any. */
export type RecordState = "ready" | "pending" | "needs_credentials" | "error" | string;

export interface MediaRef {
  /** path | uri | source-id | capture-id */
  ref: string;
  /** point-in-time anchor: a single second, or [start, end] seconds. */
  at?: number | [number, number];
}

export interface RecordMeta {
  provider?: string;
  model?: string;
  time?: string;
  case?: string;
  [k: string]: unknown;
}

export interface OvercastRecord {
  id: string;
  verb: string;
  format: RecordFormat;
  /** flat JSON map (preferred), OR a markdown string, OR plain text. */
  payload: RecordPayload;
  media?: MediaRef;
  meta?: RecordMeta;
  error?: string | null;
  state?: RecordState;
}

// payload is opaque to the framework; `format` says how to read it.
export type RecordPayload = JsonMap | string;
export type JsonMap = { [k: string]: unknown };

/**
 * Verbs whose records are read/meta outputs — `ask`/`brief` (synthesized answers
 * & reports) and `case` (inspection envelopes: manifests, `memory get` page
 * slices). They restate or duplicate primary records, so they're excluded from
 * BOTH memory retrieval and brief timelines — never cited or embedded in place of
 * the underlying watch/listen/see record. The single source for that boundary.
 */
export const META_VERBS: ReadonlySet<string> = new Set(["ask", "brief", "case"]);
export const OPERATIONAL_VERBS: ReadonlySet<string> = new Set(["collection", "doctor", "index", "provider", "setup", "skills"]);

/** Whether a record is a read/meta output (not primary evidence). */
export function isMetaRecord(rec: Pick<OvercastRecord, "verb">): boolean {
  return META_VERBS.has(rec.verb);
}

/** Whether a record should be eligible for case memory/search evidence. */
export function isMemoryRecord(rec: Pick<OvercastRecord, "verb"> & Partial<Pick<OvercastRecord, "payload">>): boolean {
  if (META_VERBS.has(rec.verb) || OPERATIONAL_VERBS.has(rec.verb)) return false;
  if (rec.verb === "face") return false;
  return true;
}

const ID_PREFIX = "rec_";

/** Stable-ish unique id; this IS the record's memory address. */
export function newRecordId(): string {
  return ID_PREFIX + randomBytes(4).toString("hex");
}

export interface NewRecordInput {
  verb: string;
  format?: RecordFormat;
  payload: RecordPayload;
  media?: MediaRef;
  meta?: RecordMeta;
  error?: string | null;
  state?: RecordState;
  id?: string;
}

/** Build a record, filling id/format/state defaults. */
export function makeRecord(input: NewRecordInput): OvercastRecord {
  const format: RecordFormat =
    input.format ?? (typeof input.payload === "string" ? "txt" : "json");
  const rec: OvercastRecord = {
    id: input.id ?? newRecordId(),
    verb: input.verb,
    format,
    payload: input.payload,
  };
  if (input.media) rec.media = input.media;
  // Stamp a creation time so `--since` filters and the brief timeline have a
  // real anchor (callers may override via meta.time). Without this every record
  // has no time and time bounds/sorts silently no-op.
  rec.meta = { time: new Date().toISOString(), ...(input.meta ?? {}) };
  if (input.error !== undefined) rec.error = input.error;
  if (input.state !== undefined) rec.state = input.state;
  return rec;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate the loose contract. Only the 4 required fields are enforced. */
export function validateRecord(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return { ok: false, errors: ["record is not an object"] };
  }
  const r = value as JsonMap;
  if (typeof r.id !== "string" || r.id.length === 0) errors.push("id must be a non-empty string");
  if (typeof r.verb !== "string" || r.verb.length === 0) errors.push("verb must be a non-empty string");
  if (r.format !== "json" && r.format !== "md" && r.format !== "txt") {
    errors.push("format must be 'json' | 'md' | 'txt'");
  }
  if (!("payload" in r)) errors.push("payload is required");
  if ("media" in r && r.media != null) {
    const m = r.media as JsonMap;
    if (typeof m.ref !== "string") errors.push("media.ref must be a string");
    if ("at" in m && m.at != null) {
      const at = m.at;
      const okPoint = typeof at === "number";
      const okSpan = Array.isArray(at) && at.length === 2 && at.every((n) => typeof n === "number");
      if (!okPoint && !okSpan) errors.push("media.at must be a number or [start,end]");
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Treat unknown/missing state as ready (consumer rule). */
export function isReady(rec: Pick<OvercastRecord, "state">): boolean {
  return rec.state == null || rec.state === "ready";
}

// --- JSONL persistence -------------------------------------------------------

/** Append a record to a JSONL file (one record per line). Creates parent dir. */
export function appendRecordJSONL(file: string, rec: OvercastRecord): void {
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
}

/** Read all records from a JSONL file (skips blank lines; tolerates trailing newline). */
export function readRecordsJSONL(file: string): OvercastRecord[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const out: OvercastRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t) as OvercastRecord);
  }
  return out;
}

/** Read every *.jsonl in a directory (the case records store). */
export function readAllRecords(dir: string): OvercastRecord[] {
  if (!existsSync(dir)) return [];
  const out: OvercastRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    out.push(...readRecordsJSONL(join(dir, name)));
  }
  return out;
}
