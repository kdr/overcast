// Shared record → text rendering. ONE place that turns a loose record into a
// human/agent-facing string, so the five surfaces (agent tool, CLI summary, TUI
// slash, brief, memory) stop reimplementing payload→string with five different
// ad-hoc char limits (the bug that made the agent see only payload key names).
//
// Two ideas keep the agent from "skipping the middle":
//   1. preview mode reports MAGNITUDE (size + item/key counts) per field, so a
//      stub can never masquerade as the complete value.
//   2. full mode inlines the whole payload when it fits a byte budget; oversized
//      fields fall back to a preview + a deterministic "page it" pointer
//      (`case memory get <id> --field <name> --offset/--limit`).

import type { OvercastRecord, RecordPayload, JsonMap } from "./record.js";

const DEFAULT_BUDGET = 8000; // bytes; full-mode inline ceiling
const DEFAULT_PREVIEW = 200; // chars; per-field preview width

/** Byte size of a record's payload (string as-is, object as JSON). */
export function payloadBytes(rec: OvercastRecord): number {
  const p = rec.payload;
  return Buffer.byteLength(typeof p === "string" ? p : safeJson(p), "utf8");
}

/** Human-readable byte size: 412B, 1.3KB, 48KB, 1.3MB. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * The canonical pageable text of a field value — the EXACT string
 * `case memory get --field` slices. Manifest and pager both derive length/size
 * from this, so the manifest's reported `chars` === paging `total` (no
 * bytes-vs-chars or compact-vs-pretty drift). Guarded against non-serializable
 * values so paging returns a record instead of throwing.
 */
export function fieldText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

// --- field access (single source of truth) ----------------------------------
// One place that enumerates / addresses / targets a record's payload fields, so
// a string payload and an object payload travel the SAME path everywhere (case
// memory get, the manifest, the renderer) and can't drift field-by-field.

/** The implicit field name of a string payload's body. */
export const TEXT_FIELD = "(text)";

/** The pageable field names of a payload: object keys, or `["(text)"]` for a
 *  string payload. The ONE enumeration of a record's fields. */
export function fieldNames(payload: RecordPayload): string[] {
  return typeof payload === "string" ? [TEXT_FIELD] : Object.keys(payload);
}

/** Resolve a field's raw value (undefined if absent). `(text)` addresses a
 *  string payload's body. */
export function getField(payload: RecordPayload, name: string): unknown {
  if (typeof payload === "string") return name === TEXT_FIELD ? payload : undefined;
  return (payload as JsonMap)[name];
}

/** The record id paging should target: a `case memory get` envelope carries the
 *  real target in `meta.pageTarget`; everything else pages itself. */
export function pageTargetId(rec: OvercastRecord): string {
  return (typeof rec.meta?.pageTarget === "string" && rec.meta.pageTarget) || rec.id;
}

/** The exact `overcast case memory get …` command to read a record's content in
 *  full. SINGLE source of the paging-command syntax — preview hints and
 *  agent-tool locators both call it, so they can never disagree. */
export function pageCommand(rec: OvercastRecord): string {
  const id = pageTargetId(rec);
  return typeof rec.payload === "string"
    ? `overcast case memory get ${id} --offset 0 [--limit M]`
    : `overcast case memory get ${id} --field <name> [--offset N] [--limit M]`;
}

export type FieldType = "string" | "number" | "boolean" | "array" | "object" | "null";

export interface FieldInfo {
  name: string;
  type: FieldType;
  /** human size (UTF-8 bytes) of the field's pageable text */
  size: string;
  bytes: number;
  /** length in characters — the unit `--offset`/`--limit` page in (=== paging `total`) */
  chars: number;
  /** array length / object key count (undefined for scalars) */
  count?: number;
  /** short one-line preview of the value */
  preview: string;
}

function fieldType(v: unknown): FieldType {
  if (v == null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v as "string" | "number" | "boolean";
}

function oneField(name: string, v: unknown, previewChars: number): FieldInfo {
  const type = fieldType(v);
  // size/length come from the SAME text the pager slices (fieldText), so the
  // manifest never disagrees with paging metadata.
  const text = fieldText(v);
  const bytes = Buffer.byteLength(text, "utf8");
  const chars = text.length;
  const base = { name, type, size: humanSize(bytes), bytes, chars };
  if (type === "object") {
    const keys = Object.keys(v as JsonMap);
    return { ...base, count: keys.length, preview: `{${keys.join(",")}}` };
  }
  if (type === "array") {
    return { ...base, count: (v as unknown[]).length, preview: oneLine(text, previewChars) };
  }
  if (type === "null") return { ...base, preview: "null" };
  return { ...base, preview: oneLine(text, previewChars) };
}

/**
 * Describe each payload field (name/type/size/count/preview). A string payload
 * is reported as a single field named "(text)". This is the manifest backing
 * `case memory get` and the preview-mode renderer.
 */
export function payloadFields(payload: RecordPayload, previewChars = 160): FieldInfo[] {
  // enumerate + address through the shared helpers so string/object stay uniform
  return fieldNames(payload).map((name) => oneField(name, getField(payload, name), previewChars));
}

/** Render a full (within-budget) object payload, printing string fields in full. */
function renderFullPayload(payload: RecordPayload): string {
  if (typeof payload === "string") return payload;
  const out: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) out.push(`${k}: null`);
    else if (typeof v === "string") out.push(v.includes("\n") || v.length > 80 ? `${k}:\n${v}` : `${k}: ${v}`);
    else if (typeof v === "number" || typeof v === "boolean") out.push(`${k}: ${v}`);
    // object/array: render via fieldText (pretty JSON) so the inline full view
    // matches EXACTLY what `case memory get --field <k>` pages back.
    else out.push(`${k}:\n${fieldText(v)}`);
  }
  return out.join("\n");
}

export type RenderMode = "preview" | "full";

export interface RenderOpts {
  /** preview (default): magnitude + per-field previews. full: inline whole
   *  payload when it fits `budget` (or always, with `force`); else preview. */
  mode?: RenderMode;
  /** full-mode inline ceiling in bytes (default 8000) */
  budget?: number;
  /** full-mode: inline regardless of size (for explicitly-requested slices) */
  force?: boolean;
  /** per-field preview width in chars (default 200) */
  previewChars?: number;
}

function head(rec: OvercastRecord): string {
  const at =
    rec.media?.at != null
      ? `@${Array.isArray(rec.media.at) ? rec.media.at.join("-") : rec.media.at}s`
      : "";
  const media = rec.media?.ref ? ` media=${rec.media.ref}${at ? " " + at : ""}` : "";
  return `${rec.id} [${rec.verb}] state=${rec.state ?? "ready"}${media}`;
}

/**
 * Render a record to text. The single renderer behind every surface.
 * - preview: one line per field with size/count, plus a "page it" pointer for
 *   oversized payloads — a stub can never look like the whole value.
 * - full: inline the entire payload when it fits the budget; otherwise behave
 *   like preview (so big fields degrade gracefully rather than dump 183KB).
 */
export function renderRecord(rec: OvercastRecord, opts: RenderOpts = {}): string {
  const mode = opts.mode ?? "preview";
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const previewChars = opts.previewChars ?? DEFAULT_PREVIEW;
  const h = head(rec);
  if (rec.error) return `${h} error=${rec.error}`;

  // full mode: inline only when the RENDERED output fits the budget (the pretty
  // form can be larger than the compact payload — gate on what's actually emitted).
  if (mode === "full") {
    const rendered = `${h}\n${renderFullPayload(rec.payload)}`;
    if (opts.force || Buffer.byteLength(rendered, "utf8") <= budget) return rendered;
    // else fall through to preview
  }

  const fields = payloadFields(rec.payload, previewChars);
  const lines = fields.map((f) => {
    const meta: string[] = [];
    if (f.bytes > 200) meta.push(f.size);
    if (f.count != null) meta.push(`${f.count} ${f.type === "array" ? "items" : "keys"}`);
    const tag = meta.length ? ` (${meta.join(", ")})` : "";
    return `  ${f.name}${tag}: ${f.preview}`;
  });
  // A field is fully shown in preview only if its value === its preview: a scalar,
  // or a string no longer than the preview width. Strings that got truncated and
  // objects/arrays (preview shows only {keys}/a one-liner) are LOSSY — so whenever
  // any field is lossy, point the reader at how to page the full value. (Gating on
  // payloadBytes>budget missed this: a preview can be lossy while the compact
  // payload is under budget.)
  const lossy = fields.some(
    (f) => !(f.type === "string" ? f.chars <= previewChars : f.type === "number" || f.type === "boolean" || f.type === "null"),
  );
  const hint = lossy ? `\n  ⟶ payload ${humanSize(payloadBytes(rec))} not fully shown; read it with: ${pageCommand(rec)}` : "";
  return `${h} payload:\n${lines.join("\n")}${hint}`;
}

// Text fields a record may carry its full human-readable body under: ask/brief
// place markdown in text/report; `case memory get --field` puts the slice in
// chunk; senses use content.
const TEXT_PAYLOAD_FIELDS = ["content", "text", "report", "chunk"];

/**
 * Format-aware single-record render, shared by the CLI and the TUI slash handler
 * so both honor `--format`/`--json` identically (a paged `chunk` shows in full
 * under txt/md, not a truncated preview):
 *   json → the whole record · md/txt → the body text field (else the payload
 *   JSON) · default → the magnitude preview.
 */
export function renderForFormat(rec: OvercastRecord, format?: string): string {
  if (format === "json") return JSON.stringify(rec, null, 2);
  if (format === "md" || format === "txt") {
    if (typeof rec.payload === "string") return rec.payload;
    const p = rec.payload as JsonMap;
    for (const k of TEXT_PAYLOAD_FIELDS) {
      if (typeof p[k] === "string" && p[k]) return p[k] as string;
    }
    return JSON.stringify(rec.payload, null, 2);
  }
  return renderRecord(rec, { mode: "preview" });
}
