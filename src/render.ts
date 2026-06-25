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
  if (typeof payload === "string") return [oneField("(text)", payload, previewChars)];
  return Object.entries(payload).map(([k, v]) => oneField(k, v, previewChars));
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

  const bytes = payloadBytes(rec);

  if (mode === "full" && (opts.force || bytes <= budget)) {
    return `${h}\n${renderFullPayload(rec.payload)}`;
  }

  const isString = typeof rec.payload === "string";
  const fields = payloadFields(rec.payload, previewChars);
  const lines = fields.map((f) => {
    const meta: string[] = [];
    if (f.bytes > 200) meta.push(f.size);
    if (f.count != null) meta.push(`${f.count} ${f.type === "array" ? "items" : "keys"}`);
    const tag = meta.length ? ` (${meta.join(", ")})` : "";
    return `  ${f.name}${tag}: ${f.preview}`;
  });
  const pageCmd = isString
    ? `case memory get ${rec.id} --offset 0 [--limit M]`
    : `case memory get ${rec.id} --field <name> [--offset N] [--limit M]`;
  const hint = bytes > budget ? `\n  ⟶ full payload ${humanSize(bytes)}; read it in full with: ${pageCmd}` : "";
  return `${h} payload:\n${lines.join("\n")}${hint}`;
}
