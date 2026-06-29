import { createHash } from "node:crypto";
import type { OvercastRecord } from "../../record.js";

export interface IndexableField {
  path: string;
  text: string;
}

export interface IndexableDocument {
  id: string;
  recordId: string;
  verb: string;
  title: string;
  text: string;
  fields: IndexableField[];
  media?: OvercastRecord["media"];
  time?: string;
}

const FIELD_POLICY: Record<string, string[]> = {
  watch: [
    "content",
    "transcript",
    "summary",
    "title",
    "data.title",
    "data.summary",
    "data.segments[].description",
    "data.segments[].summary",
    "detailed.title",
    "detailed.summary",
    "detailed.segments[].description",
    "detailed.segments[].summary",
  ],
  listen: [
    "transcript",
    "summary",
    "language",
    "segments[].text",
    "segments[].transcript",
    "segments[].summary",
    "detailed.transcript",
    "detailed.summary",
  ],
  see: ["caption", "ocr", "text", "summary", "counts", "categories", "objects", "labels"],
  face: ["summary", "op", "moments", "reference", "index"],
  crop: ["summary", "kind", "class", "detection_id", "source_record", "source_verb", "source_media", "at", "confidence", "crop"],
  note: ["title", "text", "tags", "confidence", "ref"],
  scan: ["title", "snippet", "url", "source", "published"],
  capture: ["title", "snippet", "text", "path", "source", "kind"],
  enhance: ["summary", "path", "ops", "output"],
  finding: ["text", "target", "source_record", "source_verb", "trigger", "confidence", "status"],
};

function stringify(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(stringify).filter((x): x is string => !!x);
    return parts.length ? parts.join("\n") : undefined;
  }
  if (v && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function valuesAt(obj: unknown, path: string): unknown[] {
  const parts = path.split(".");
  let cur: unknown[] = [obj];
  for (const part of parts) {
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const item of cur) {
      if (!item || typeof item !== "object") continue;
      const value = (item as Record<string, unknown>)[key];
      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    cur = next;
  }
  return cur.filter((v) => v != null);
}

function fallbackFields(rec: OvercastRecord): IndexableField[] {
  const p = rec.payload;
  if (typeof p === "string") return [{ path: "(text)", text: p }];
  if (!p || typeof p !== "object") return [];
  const fields: IndexableField[] = [];
  for (const [k, v] of Object.entries(p)) {
    const text = stringify(v);
    if (text) fields.push({ path: k, text: text.slice(0, 8000) });
  }
  return fields;
}

export function indexableFields(rec: OvercastRecord): IndexableField[] {
  const p = rec.payload;
  if (typeof p === "string") return [{ path: "(text)", text: p }];
  const policy = FIELD_POLICY[rec.verb] ?? [];
  const fields: IndexableField[] = [];
  for (const path of policy) {
    for (const value of valuesAt(p, path)) {
      const text = stringify(value);
      if (text) fields.push({ path, text });
    }
  }
  const seen = new Set<string>();
  const deduped = fields.filter((f) => {
    const key = `${f.path}\0${f.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.length ? deduped : fallbackFields(rec);
}

export function indexableDocument(rec: OvercastRecord): IndexableDocument | undefined {
  const fields = indexableFields(rec).filter((f) => f.text.trim());
  if (!fields.length) return undefined;
  const title =
    fields.find((f) => f.path === "title" || f.path.endsWith(".title"))?.text.split(/\n/)[0]?.slice(0, 120) ||
    `${rec.verb} ${rec.id}`;
  return {
    id: stableDocId(rec),
    recordId: rec.id,
    verb: rec.verb,
    title,
    text: fields.map((f) => `## ${f.path}\n${f.text}`).join("\n\n"),
    fields,
    media: rec.media,
    time: rec.meta?.time ? String(rec.meta.time) : undefined,
  };
}

export function stableDocId(rec: OvercastRecord): string {
  return `${rec.id}_${createHash("sha1").update(`${rec.verb}\0${rec.media?.ref ?? ""}`).digest("hex").slice(0, 10)}`;
}
