// Internal ffmpeg toolkit (CLAUDE.md invariant #7: ffmpeg is internal, NOT a
// user-configurable provider). Powers `enhance`, frame extraction, and `view`.
// Resolves the vendored ffmpeg-static / ffprobe-static binaries (or falls back
// to PATH), mirroring tinycloud's resolver.

import { createRequire } from "node:module";
import { dirname, join, extname, basename } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

function resolveFfmpeg(): string {
  try {
    const p = require("ffmpeg-static") as string | null;
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed / unsupported platform */
  }
  return "ffmpeg"; // fall back to PATH
}

function resolveFfprobe(): string {
  // Prefer @ffprobe-installer/ffprobe — it ships correct per-platform binaries
  // (ffprobe-static@3.1.0 mislabels an x86_64 binary in its darwin/arm64 dir,
  // which fails with EBADARCH on Apple Silicon).
  for (const pkg of ["@ffprobe-installer/ffprobe", "ffprobe-static"]) {
    try {
      const m = require(pkg) as { path?: string } | string;
      const p = typeof m === "string" ? m : m?.path;
      if (p && existsSync(p)) return p;
    } catch {
      /* not installed — try next */
    }
  }
  return "ffprobe"; // fall back to PATH
}

export const FFMPEG_PATH = resolveFfmpeg();
export const FFPROBE_PATH = resolveFfprobe();

export type Modality = "video" | "audio" | "image" | "other";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".heic"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv"]);

/** Classify a file by extension (cheap; no probe). */
export function modalityFromExt(path: string): Modality {
  const e = extname(path).toLowerCase();
  if (IMAGE_EXT.has(e)) return "image";
  if (AUDIO_EXT.has(e)) return "audio";
  if (VIDEO_EXT.has(e)) return "video";
  return "other";
}

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

export interface ProbeResult {
  durationSeconds?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  streams: ProbeStream[];
  /** modality inferred from streams (preferred over extension) */
  modality: Modality;
}

/** ffprobe a media file into a small structured summary. */
export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await execFileP(
    FFPROBE_PATH,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: ProbeStream[];
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const hasVideo = Boolean(video);
  const duration = parsed.format?.duration ? Number(parsed.format.duration) : undefined;

  // images decode as a single video stream with no duration / 1 frame
  let modality: Modality = modalityFromExt(path);
  if (hasVideo && hasAudio) modality = "video";
  else if (hasVideo && (duration === undefined || duration === 0)) modality = modalityFromExt(path) === "image" ? "image" : "video";
  else if (hasVideo) modality = "video";
  else if (hasAudio) modality = "audio";

  return {
    durationSeconds: duration,
    hasVideo,
    hasAudio,
    width: video?.width,
    height: video?.height,
    streams,
    modality,
  };
}

/** Ensure a directory exists and return it. */
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Extract a single frame at `second` from a video to a jpg. Returns out path. */
export async function extractFrame(
  input: string,
  second: number,
  outDir: string,
): Promise<string> {
  ensureDir(outDir);
  const out = join(outDir, `${basename(input, extname(input))}_t${Math.round(second)}.jpg`);
  await execFileP(
    FFMPEG_PATH,
    ["-y", "-ss", String(second), "-i", input, "-frames:v", "1", "-q:v", "2", out],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return out;
}

export type EnhanceOp =
  | "denoise"
  | "normalize"
  | "voice-isolate"
  | "upscale"
  | "deskew"
  | "stabilize"
  | "grayscale";

/** Map an enhance op to an ffmpeg filter for the given modality. */
function opFilter(op: EnhanceOp, modality: Modality): { v?: string; a?: string } {
  switch (op) {
    case "denoise":
      return modality === "audio" ? { a: "afftdn" } : { v: "hqdn3d" };
    case "normalize":
      return { a: "loudnorm" };
    case "voice-isolate":
      // lightweight band-pass approximating speech isolation (deterministic)
      return { a: "highpass=f=200,lowpass=f=3000" };
    case "upscale":
      return { v: "scale=iw*2:ih*2:flags=lanczos" };
    case "deskew":
      return { v: "deshake" };
    case "stabilize":
      return { v: "deshake" };
    case "grayscale":
      return { v: "format=gray" };
    default:
      return {};
  }
}

export interface EnhanceResult {
  output: string;
  ops: EnhanceOp[];
  modality: Modality;
}

/** Default ops per modality when none specified. */
export function defaultOps(modality: Modality): EnhanceOp[] {
  if (modality === "audio") return ["denoise", "normalize"];
  if (modality === "image") return ["denoise"];
  if (modality === "video") return ["denoise"];
  return [];
}

/**
 * Run deterministic enhance ops via ffmpeg. Combines per-modality video/audio
 * filters into a single pass. Returns the output path.
 */
export async function enhance(
  input: string,
  ops: EnhanceOp[],
  outDir: string,
  outPath?: string,
): Promise<EnhanceResult> {
  const p = await probe(input).catch(() => ({ modality: modalityFromExt(input) }) as ProbeResult);
  const modality = p.modality;
  const vFilters: string[] = [];
  const aFilters: string[] = [];
  for (const op of ops) {
    const f = opFilter(op, modality);
    if (f.v) vFilters.push(f.v);
    if (f.a) aFilters.push(f.a);
  }

  const ext = modality === "image" ? ".png" : extname(input) || ".mp4";
  const out =
    outPath ?? join(ensureDir(outDir), `${basename(input, extname(input))}_enhanced${ext}`);

  const args = ["-y", "-i", input];
  if (vFilters.length) args.push("-vf", vFilters.join(","));
  if (aFilters.length && modality !== "image") args.push("-af", aFilters.join(","));
  args.push(out);

  await execFileP(FFMPEG_PATH, args, { maxBuffer: 32 * 1024 * 1024 });
  return { output: out, ops, modality };
}

export interface FrameRef {
  recordId: string;
  second: number;
}

/** Parse a `frame://rec_xxx@134` reference. Returns null if not a frame ref. */
export function parseFrameRef(ref: string): FrameRef | null {
  const m = ref.match(/^frame:\/\/([^@]+)@(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { recordId: m[1], second: Number(m[2]) };
}

export { dirname };
