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
export const OPERATIONAL_VERBS: ReadonlySet<string> = new Set([
  "archive",
  "collection",
  "devices",
  "doctor",
  // geofence restates the gps-bearing evidence it intersects (like map) —
  // the query result is a viewer/rollup, never re-cited as evidence itself.
  "geofence",
  // graph restates evidence records as a rollup viewer (like map/devices) —
  // its node/edge dump must never be re-cited as evidence itself.
  "graph",
  "grid",
  "index",
  "map",
  "prebrief",
  "provider",
  // reconstruct is a SENSE verb by group, quarantined here on purpose: its
  // records are synthesized pixels (novel views / 3D lifts / estimated depth),
  // stamped payload.caveat — viewable, chainable, exportable, but never
  // ask/brief evidence and never findings-trigger input. crop materializes
  // real pixels and stays evidence; reconstruct materializes hypotheses.
  "reconstruct",
  "setup",
  "situation",
  "skills",
  "source",
  "target",
  "wall",
]);

/** Whether a record is a read/meta output (not primary evidence). */
export function isMetaRecord(rec: Pick<OvercastRecord, "verb">): boolean {
  return META_VERBS.has(rec.verb);
}

/** Whether a record should be eligible for case memory/search evidence. */
export function isMemoryRecord(rec: Pick<OvercastRecord, "verb"> & Partial<Pick<OvercastRecord, "payload" | "state">>): boolean {
  if (META_VERBS.has(rec.verb) || OPERATIONAL_VERBS.has(rec.verb)) return false;
  if (rec.verb === "scan" && rec.payload && typeof rec.payload === "object") {
    if ((rec.payload as Record<string, unknown>).op === "pull_progress") return false;
  }
  // cluster: only the ops that PRODUCE investigative signal (ingesting faces out
  // of media, identifying a probe) are evidence; DB reads and maintenance
  // (list/show/view/label/recluster) are operational, like scan's pull_progress.
  if (rec.verb === "cluster") {
    const op = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>).op : undefined;
    if (op !== "ingest" && op !== "identify") return false;
  }
  if (rec.verb === "finding" && rec.payload && typeof rec.payload === "object") {
    const payload = rec.payload as Record<string, unknown>;
    if (typeof payload.finding_id === "string") return false;
    if (typeof payload.source_record !== "string") return false;
    const status = payload.status;
    if (status === "dismissed") return false;
  }
  return isReady(rec);
}

/** Latest review status per root finding id (root records seed their own
 *  "open"; review records override by finding_id). Shared by memory filtering
 *  and any consumer that needs open/accepted/dismissed without O(n²) rescans. */
export function findingStatusMap(records: OvercastRecord[]): Map<string, string> {
  const findingStatus = new Map<string, string>();
  for (const rec of records) {
    if (rec.verb !== "finding" || !rec.payload || typeof rec.payload !== "object") continue;
    const payload = rec.payload as Record<string, unknown>;
    const id = typeof payload.finding_id === "string" ? payload.finding_id : rec.id;
    if (typeof payload.status === "string") findingStatus.set(id, payload.status);
  }
  return findingStatus;
}

export function memoryRecords(records: OvercastRecord[]): OvercastRecord[] {
  const findingStatus = findingStatusMap(records);
  return records.filter((rec) => {
    if (!isMemoryRecord(rec)) return false;
    if (rec.verb !== "finding") return true;
    // quarantine: dismissed findings are rejected evidence; suggested findings
    // are unreviewed leads — neither may pollute ask/brief until accepted
    // (accepting flips the effective status via a review record).
    const status = findingStatus.get(rec.id);
    return status !== "dismissed" && status !== "suggested";
  });
}

const VISUAL_EXT_RE = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;

/** Drop a URL's `?query`/`#fragment` tail. Deliberately NOT a `/[?#].*$/` regex:
 *  `.` stops at newlines, so `$` forces a retry from every later separator and a
 *  crafted ref degrades to quadratic (CodeQL js/polynomial-redos). `search` +
 *  `slice` is linear and does the same job. */
export function stripUrlTail(s: string): string {
  const cut = s.search(/[?#]/);
  return cut < 0 ? s : s.slice(0, cut);
}
// deliberately NOT a bare `path`/`img` — the image-match payload carries
// `db_img_path` (the reference frame) and `query_path` (a temp frame that's
// deleted after the run); only the rendered `match_draw_path` overlay and real
// crop/thumbnail evidence should surface.
const VISUAL_KEY_RE = /(?:draw|overlay|visual|thumbnail|thumb|crop|image)/i;

/** Collect visualization image refs from a record payload — match-draw overlays,
 *  crops, thumbnails: data URIs, or image-extension paths under a visual-ish key
 *  (`match_draw_path`, `crop`, `thumbnail`, …). Shared by briefs, `case status`,
 *  and the mission renderer so overlays surface identically everywhere. Lives
 *  here (pure payload introspection) so report/mission.ts can use it without an
 *  html.ts import cycle; html.ts re-exports it. */
export function collectVisualRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const visit = (v: unknown, key = ""): void => {
    if (typeof v === "string") {
      if (/^data:image\//i.test(v) || (VISUAL_EXT_RE.test(stripUrlTail(v)) && VISUAL_KEY_RE.test(key))) refs.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, key);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) visit(child, k);
    }
  };
  visit(value);
  return [...refs];
}

const ID_PREFIX = "rec_";

/** Stable-ish unique id; this IS the record's memory address. 8 random bytes
 *  (2^64) so a large case (`scan --pull` can write 10k+ records) doesn't hit a
 *  birthday collision — `recordById` returns the FIRST match, so a duplicate id
 *  would silently misroute `view`/`crop`/`case memory get`/`finding` review. */
export function newRecordId(): string {
  return ID_PREFIX + randomBytes(8).toString("hex");
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

/** Standard error record for a verb: state:"error" with the message doubled
 *  into payload.error (display) and error (control). The one constructor —
 *  verb files must not re-implement it. */
export function errRecord(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
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

/** Payload fields carrying a record's primary human-readable text, in precedence
 *  order. `summary` first: match records (face/image/similar/audio/voice) put
 *  their one-line result there — surfaces that skipped it rendered a useless
 *  "payload: op, count, summary" key dump. The ONE list shared by the brief
 *  trail, case-status summaries, and record stubs so they can't drift. */
export const PRIMARY_TEXT_FIELDS: readonly string[] = ["summary", "content", "transcript", "text", "caption", "ocr", "title", "snippet"];

/** The primary human-readable text of a record's payload ("" when none). */
export function primaryText(rec: Pick<OvercastRecord, "payload">): string {
  if (typeof rec.payload === "string") return rec.payload;
  const p = rec.payload as JsonMap;
  for (const k of PRIMARY_TEXT_FIELDS) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** One-line human stub of a record — primary text, else a verb-aware summary
 *  (capture → the pulled file, scan → the hit URL), else the payload keys.
 *  Param is structural (verb/payload/media/error) so report view models
 *  (TimelineRecord) can use it too. */
export function recordStub(rec: Pick<OvercastRecord, "verb" | "payload"> & Partial<Pick<OvercastRecord, "media" | "error">>, max = 160): string {
  const clip = (s: string) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > max ? one.slice(0, max - 3) + "…" : one;
  };
  if (rec.error) return clip(`error: ${rec.error}`);
  const text = primaryText(rec);
  if (text.trim()) return clip(text);
  const p = typeof rec.payload === "object" && rec.payload != null ? (rec.payload as JsonMap) : {};
  // a non-string primary value (number/boolean) must not be lost to a key dump
  for (const k of PRIMARY_TEXT_FIELDS) {
    const v = p[k];
    if (typeof v === "number" || typeof v === "boolean") return clip(`${k}: ${v}`);
  }
  if (rec.verb === "capture") {
    const path = typeof p.path === "string" ? p.path : rec.media?.ref;
    if (path) return clip(`captured ${stripUrlTail(path).split(/[\\/]/).pop() || path}`);
  }
  if (rec.verb === "scan" && typeof p.url === "string" && p.url) return clip(p.url);
  const op = typeof p.op === "string" ? p.op : undefined;
  const count = typeof p.count === "number" ? p.count : undefined;
  if (op || count != null) return clip(`${op ?? rec.verb}${count != null ? ` found ${count}` : ""}${rec.media?.ref ? ` in ${rec.media.ref}` : ""}`);
  const keys = typeof rec.payload === "object" && rec.payload != null ? Object.keys(rec.payload as JsonMap) : [];
  return clip(keys.length ? `payload: ${keys.join(", ")}` : "(empty)");
}

/** Epoch ms of a record's meta.time, or NaN when absent/unparseable —
 *  the single reading of the timestamp convention for sorts and --since. */
export function recordTimeMs(rec: Pick<OvercastRecord, "meta">): number {
  return rec.meta?.time ? Date.parse(String(rec.meta.time)) : NaN;
}

/** Parse an ExifTool capture datetime ("YYYY:MM:DD HH:MM:SS[.sss][±HH:MM]") to
 *  epoch ms, or undefined when absent/unparseable (the date part uses colons, so
 *  Date.parse can't read it raw). A zone-less value is normalized to UTC (append
 *  "Z") — ES parses a zone-less date-time as HOST-LOCAL, which would skew --since /
 *  ranking against the UTC `meta.time` + absolute-date cutoffs; an explicit offset
 *  (Z or ±HH:MM) is left intact. */
export function exifCaptureMs(created: unknown): number | undefined {
  if (typeof created !== "string" || !created.trim()) return undefined;
  let iso = created.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(" ", "T");
  // a DATE-only value ("YYYY-MM-DD", e.g. an EDGAR filing date) has no time part,
  // so a bare "Z" would make Date.parse reject it ("2025-03-01Z") — pin it to
  // midnight UTC instead. Otherwise a zone-less date-time just gets the "Z".
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += "T00:00:00Z";
  else if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) iso += "Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Capture-aware record time for --since / recency on rollup viewers (map,
 *  graph): the CAPTURE time (exif payload.created) when present — an old
 *  geotagged photo ingested today must not read as new — else ingest time
 *  (meta.time), NaN when neither parses. Activity surfaces (threads/pulse/wall
 *  freshness) deliberately stay on recordTimeMs: they track investigation
 *  activity, not media age. */
export function recordCaptureTimeMs(rec: Pick<OvercastRecord, "meta" | "payload">): number {
  const p = rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload) ? (rec.payload as JsonMap) : undefined;
  return exifCaptureMs(p?.created) ?? recordTimeMs(rec);
}

// --- JSONL persistence -------------------------------------------------------

/** Append a record to a JSONL file (one record per line). Creates parent dir. */
export function appendRecordJSONL(file: string, rec: OvercastRecord): void {
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
}

/** Read all records from a JSONL file (skips blank lines; tolerates trailing newline).
 *  A malformed line is SKIPPED, not thrown — the record store is the case memory
 *  and appends are non-atomic (a line > PIPE_BUF can interleave under concurrent
 *  `monitor --every` / `scan --pull` writers, or be truncated by a crash / full
 *  disk). Without this, one torn line would brick EVERY reader — ask/brief/wall/
 *  finding and even `case clear` (which reads before it deletes). This mirrors how
 *  every sibling JSON store (setup/seen/source/target/index) already self-heals. */
export function readRecordsJSONL(file: string): OvercastRecord[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const out: OvercastRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as OvercastRecord);
    } catch {
      // torn/partial line — skip it rather than fail the whole store read.
    }
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
