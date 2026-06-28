// `crop` verb: materialize face/object detections as local still images while
// preserving provenance to the source record, media, timestamp/frame, class/id,
// and bounding box. The crop record is the memory-friendly evidence artifact;
// the source detection record remains the full audit trail.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { makeRecord, type OvercastRecord } from "../record.js";
import { cropStill, modalityFromExt, probe, type CropBox } from "../media/ffmpeg.js";
import { badNumber } from "./validate.js";
import type { VerbSpec } from "../registry/types.js";

type CropKind = "face" | "object";
const THUMBNAIL_FETCH_TIMEOUT_MS = 15_000;

interface Candidate {
  sourceRecord: OvercastRecord;
  item: Record<string, unknown>;
  index: number;
  kind: CropKind;
  id: string;
  className: string;
  confidence?: number;
  at?: number;
  frame?: number;
  frameId?: string;
  thumbnailUrl?: string;
  sourceMedia?: string;
  rawBox: unknown;
}

function err(message: string): OvercastRecord {
  return makeRecord({ verb: "crop", format: "json", payload: { error: message }, error: message, state: "error" });
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function atStart(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === "number" && Number.isFinite(v[0])) return v[0];
  return undefined;
}

function itemId(item: Record<string, unknown>, kind: CropKind, index: number): string {
  return (
    str(item.crop_id) ??
    str(item.detection_id) ??
    str(item.face_id) ??
    str(item.faceId) ??
    str(item.track_id) ??
    str(item.trackId) ??
    str(item.id) ??
    `${kind}_${index + 1}`
  );
}

function itemClass(item: Record<string, unknown>, kind: CropKind): string {
  return str(item.class) ?? str(item.label) ?? str(item.category) ?? str(item.name) ?? kind;
}

function itemConfidence(item: Record<string, unknown>, kind: CropKind): number | undefined {
  const raw = kind === "face"
    ? (item.similarity ?? item.score ?? item.confidence)
    : (item.score ?? item.confidence ?? item.similarity);
  return num(raw);
}

function detectionsFrom(rec: OvercastRecord): Candidate[] {
  if (!rec.payload || typeof rec.payload !== "object") return [];
  const p = rec.payload as Record<string, unknown>;
  const out: Candidate[] = [];
  const faces = Array.isArray(p.faces) ? p.faces : [];
  faces.forEach((v, index) => {
    if (!v || typeof v !== "object") return;
    const item = v as Record<string, unknown>;
    out.push({
      sourceRecord: rec,
      item,
      index,
      kind: "face",
      id: itemId(item, "face", index),
      className: itemClass(item, "face"),
      confidence: itemConfidence(item, "face"),
      at: atStart(item.at),
      frame: num(item.frame),
      frameId: str(item.frame_id) ?? str(item.frameId),
      thumbnailUrl: str(item.thumbnail) ?? str(item.thumbnail_url) ?? str(item.thumbnailUrl),
      sourceMedia: str(item.file),
      rawBox: item.box ?? item.bbox ?? item.bounding_box ?? item.boundingBox,
    });
  });
  const detections = Array.isArray(p.detections) ? p.detections : [];
  detections.forEach((v, index) => {
    if (!v || typeof v !== "object") return;
    const item = v as Record<string, unknown>;
    out.push({
      sourceRecord: rec,
      item,
      index,
      kind: "object",
      id: itemId(item, "object", index),
      className: itemClass(item, "object"),
      confidence: itemConfidence(item, "object"),
      at: atStart(item.at),
      frame: num(item.frame),
      frameId: str(item.frame_id) ?? str(item.frameId),
      thumbnailUrl: str(item.thumbnail) ?? str(item.thumbnail_url) ?? str(item.thumbnailUrl),
      sourceMedia: str(item.file) ?? str(item.source) ?? str(item.video),
      rawBox: item.box ?? item.bbox ?? item.bounding_box ?? item.boundingBox,
    });
  });
  return out;
}

interface MediaInfo {
  width: number;
  height: number;
  durationSeconds?: number;
}

function mediaInfo(p: Awaited<ReturnType<typeof probe>>): MediaInfo | undefined {
  if (p.width && p.height) return { width: p.width, height: p.height, durationSeconds: p.durationSeconds };
  const stream = p.streams.find((s) => s.width && s.height);
  return stream?.width && stream?.height ? { width: stream.width, height: stream.height, durationSeconds: p.durationSeconds } : undefined;
}

function boxObject(raw: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(raw)) {
    const vals = raw.map(num);
    if (vals.length >= 4 && vals.every((v) => v !== undefined)) {
      return { x: vals[0], y: vals[1], width: vals[2], height: vals[3] };
    }
    return undefined;
  }
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
}

function boolish(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "1"].includes(s)) return true;
    if (["false", "no", "0"].includes(s)) return false;
  }
  return undefined;
}

function explicitNormalized(box: Record<string, unknown>, item: Record<string, unknown> | undefined): boolean | undefined {
  const raw =
    boolish(box.normalized) ??
    boolish(box.is_normalized) ??
    boolish(box.relative) ??
    boolish(item?.box_normalized) ??
    boolish(item?.normalized);
  if (raw !== undefined) return raw;
  const space = str(box.coordinate_space) ?? str(box.coord_space) ?? str(box.space) ?? str(box.units) ??
    str(item?.box_space) ?? str(item?.coordinate_space) ?? str(item?.coord_space);
  if (!space) return undefined;
  if (/^(normalized|relative|ratio|fraction)$/i.test(space)) return true;
  if (/^(pixel|pixels|absolute|image)$/i.test(space)) return false;
  return undefined;
}

export function normalizeBox(raw: unknown, media: { width: number; height: number }, pad: number, square: boolean, item?: Record<string, unknown>): CropBox | undefined {
  const b = boxObject(raw);
  if (!b) return undefined;
  let x: number | undefined;
  let y: number | undefined;
  let w: number | undefined;
  let h: number | undefined;

  const xmin = num(b.xmin ?? b.x_min);
  const ymin = num(b.ymin ?? b.y_min);
  const xmax = num(b.xmax ?? b.x_max);
  const ymax = num(b.ymax ?? b.y_max);
  if (xmin !== undefined && ymin !== undefined && xmax !== undefined && ymax !== undefined) {
    x = xmin; y = ymin; w = xmax - xmin; h = ymax - ymin;
  } else {
    x = num(b.x ?? b.left);
    y = num(b.y ?? b.top);
    w = num(b.width ?? b.w);
    h = num(b.height ?? b.h);
  }
  if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;

  const vals = [x, y, w, h];
  const looksUnitScaled = Math.max(...vals.map(Math.abs)) <= 1 && vals.some((v) => v > 0 && v < 1 && !Number.isInteger(v));
  const normalized = explicitNormalized(b, item) ?? looksUnitScaled;
  if (normalized) {
    x *= media.width;
    w *= media.width;
    y *= media.height;
    h *= media.height;
  }

  if (square) {
    const side = Math.max(w, h);
    x -= (side - w) / 2;
    y -= (side - h) / 2;
    w = side;
    h = side;
  }
  if (pad > 0) {
    const px = w * pad;
    const py = h * pad;
    x -= px;
    y -= py;
    w += px * 2;
    h += py * 2;
  }

  const x2 = Math.min(media.width, x + w);
  const y2 = Math.min(media.height, y + h);
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = x2 - x;
  h = y2 - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : undefined;
}

function safePart(s: string): string {
  return s.replace(/[^a-z0-9_.-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "crop";
}

function sourceFor(c: Candidate): string | undefined {
  return c.sourceMedia ?? c.sourceRecord.media?.ref;
}

function extFromUrl(url: string): string {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    return ext || ".jpg";
  } catch {
    return ".jpg";
  }
}

function extFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".jpg";
  }
}

function materializeDataUrl(url: string, outDir: string, id: string): string {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/is.exec(url);
  if (!match) throw new Error("invalid data URL");
  const mime = match[1] || "image/jpeg";
  const params = match[2] || "";
  const data = match[3] || "";
  const frameDir = join(outDir, ".frames");
  mkdirSync(frameDir, { recursive: true });
  const out = join(frameDir, `${safePart(id)}${extFromMime(mime)}`);
  if (existsSync(out)) return out;
  const buf = params.toLowerCase().includes(";base64")
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data));
  writeFileSync(out, buf);
  return out;
}

async function materializeThumbnail(url: string, outDir: string, id: string): Promise<string> {
  if (/^data:/i.test(url)) return materializeDataUrl(url, outDir, id);
  const frameDir = join(outDir, ".frames");
  mkdirSync(frameDir, { recursive: true });
  const out = join(frameDir, `${safePart(id)}${extFromUrl(url)}`);
  if (existsSync(out)) return out;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THUMBNAIL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`download timed out after ${THUMBNAIL_FETCH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

export const cropVerb: VerbSpec = {
  name: "crop",
  group: "inspect",
  summary: "Materialize face/object detections as cropped image records with provenance.",
  description:
    "Takes a face or see detection record and writes cropped still images under .overcast/media/crops/. " +
    "For detections with frame thumbnails, crop uses the supplied frame image as the crop source. " +
    "Each crop record preserves the source record, source media, crop source media, timestamp/frame, class/id, confidence, and box. " +
    "Use --all, --id, --class, or --kind to select detections; crops are memory-friendly evidence artifacts.",
  args: [{ name: "input", summary: "Detection record id (face/see)", required: true }],
  flags: [
    { name: "all", summary: "Crop every matching detection", type: "boolean" },
    { name: "id", summary: "Crop one detection/face/track id", type: "string" },
    { name: "class", summary: "Filter by class/label, e.g. face, person, car", type: "string" },
    { name: "kind", summary: "Filter detection kind: face | object", type: "string", choices: ["face", "object"] },
    { name: "pad", summary: "Expand the crop box by a fraction, e.g. 0.15", type: "number" },
    { name: "square", summary: "Make the crop square around the detection box", type: "boolean" },
    { name: "limit", summary: "Maximum crops to write", type: "number" },
    { name: "out", summary: "Output directory (default .overcast/media/crops)", type: "string" },
    { name: "format", summary: "Output surface: json | md | txt", type: "string", choices: ["json", "md", "txt"] },
    { name: "json", summary: "Shorthand for --format json", type: "boolean" },
  ],
  outputKind: "media.crop",
  providerKey: "crop",
  run: async (ctx) => {
    if (!ctx.input) return [err("crop requires a detection record id")];
    const numErr =
      badNumber(ctx.opts, "pad", (n) => n >= 0 && n <= 2, "0–2") ??
      badNumber(ctx.opts, "limit", (n) => n > 0, "a positive number");
    if (numErr) return [err(numErr)];

    const source = ctx.case.recordById(ctx.input);
    if (!source) return [err(`record not found: ${ctx.input}`)];
    let candidates = detectionsFrom(source);
    if (!candidates.length) return [err(`record ${ctx.input} has no face/object detections to crop`)];

    if (ctx.opts.kind) candidates = candidates.filter((c) => c.kind === ctx.opts.kind);
    if (ctx.opts.class) {
      const wanted = String(ctx.opts.class).toLowerCase();
      candidates = candidates.filter((c) => c.className.toLowerCase() === wanted);
    }
    if (ctx.opts.id) {
      const wanted = String(ctx.opts.id);
      candidates = candidates.filter((c) => c.id === wanted);
    }
    if (!ctx.opts.all && !ctx.opts.id && candidates.length > 1) {
      return [err(`crop matched ${candidates.length} detections; pass --all, --id <id>, or narrow with --class/--kind`)];
    }
    const limit = ctx.opts.limit != null ? Number(ctx.opts.limit) : undefined;
    if (limit !== undefined) candidates = candidates.slice(0, limit);
    if (!candidates.length) return [err("no detections matched the crop filters")];

    const outDir = ctx.opts.out ? String(ctx.opts.out) : join(ctx.case.mediaDir, "crops");
    mkdirSync(outDir, { recursive: true });
    const pad = ctx.opts.pad != null ? Number(ctx.opts.pad) : 0;
    const square = ctx.opts.square === true;
    const recs: OvercastRecord[] = [];
    const infos = new Map<string, MediaInfo>();

    for (const cand of candidates) {
      const sourceMedia = sourceFor(cand);
      const cropSource = cand.thumbnailUrl ?? sourceMedia;
      if (!cropSource) {
        recs.push(err(`detection ${cand.id} has no source media`));
        continue;
      }
      let media = cropSource;
      const usingThumbnail = cand.thumbnailUrl != null && cropSource === cand.thumbnailUrl;
      if (/^(?:https?|data):/i.test(media)) {
        try {
          media = await materializeThumbnail(media, outDir, `${cand.id}${cand.at != null ? `_t${cand.at}` : ""}`);
        } catch (e) {
          recs.push(err(`detection ${cand.id} source frame materialization failed: ${(e as Error).message}`));
          continue;
        }
      }
      if (!existsSync(media)) {
        recs.push(err(`detection ${cand.id} source media is not a local file: ${media}`));
        continue;
      }
      let info = infos.get(media);
      if (!info) {
        const p = await probe(media).catch(() => ({ modality: modalityFromExt(media), hasVideo: false, hasAudio: false, streams: [] }) as Awaited<ReturnType<typeof probe>>);
        info = mediaInfo(p);
        if (!info) {
          recs.push(err(`could not determine media dimensions for ${media}`));
          continue;
        }
        infos.set(media, info);
      }
      const box = normalizeBox(cand.rawBox, info, pad, square, cand.item);
      if (!box) {
        recs.push(err(`detection ${cand.id} has an unsupported or empty box`));
        continue;
      }
      const base = basename(sourceMedia ?? media, extname(sourceMedia ?? media));
      const atPart = cand.at != null ? `_t${String(cand.at).replace(".", "p")}` : "";
      const out = join(outDir, `${safePart(base)}_${safePart(cand.className)}_${safePart(cand.id)}${atPart}.jpg`);
      try {
        const seek = usingThumbnail
          ? undefined
          : cand.at != null && info.durationSeconds != null
          ? Math.max(0, Math.min(cand.at, Math.max(0, info.durationSeconds - 0.1)))
          : cand.at;
        await cropStill(media, box, out, seek);
      } catch (e) {
        recs.push(err(`crop failed for ${cand.id}: ${(e as Error).message}`));
        continue;
      }
      recs.push(makeRecord({
        verb: "crop",
        format: "json",
        payload: {
          summary: `cropped ${cand.className} ${cand.kind} from ${basename(sourceMedia ?? media)}${cand.at != null ? ` at ${cand.at}s` : ""}`,
          source_record: source.id,
          source_verb: source.verb,
          source_media: sourceMedia,
          crop_source_media: media,
          thumbnail: cand.thumbnailUrl,
          kind: cand.kind,
          class: cand.className,
          detection_id: cand.id,
          confidence: cand.confidence,
          at: cand.at,
          frame: cand.frame,
          frame_id: cand.frameId,
          box,
          original_box: cand.rawBox,
          crop: out,
          pad,
          square,
        },
        media: { ref: out, at: cand.at },
        meta: { provider: "ffmpeg", case: ctx.case.dir },
        state: "ready",
      }));
    }
    return recs;
  },
};
