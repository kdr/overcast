// Internal ffmpeg toolkit (CLAUDE.md invariant #7: ffmpeg is used internally — for
// `enhance`, frame extraction, and `view` — but is NOT a pluggable provider).
// ffmpeg/ffprobe are a SYSTEM PREREQUISITE: resolve an explicit override
// (OVERCAST_FFMPEG / OVERCAST_FFPROBE) or the binary on PATH. `overcast doctor`
// verifies it's installed and recent enough.

import { dirname, join, extname, basename } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Recommended minimum ffmpeg/ffprobe version (major.minor). */
export const MIN_FFMPEG = "4.4";

function resolveTool(envVar: string, bin: string): string {
  // an explicit absolute-path override wins; otherwise the bare name is resolved
  // from PATH at exec time (doctor verifies presence + version).
  const override = process.env[envVar];
  if (override && existsSync(override)) return override;
  return bin;
}

export const FFMPEG_PATH = resolveTool("OVERCAST_FFMPEG", "ffmpeg");
export const FFPROBE_PATH = resolveTool("OVERCAST_FFPROBE", "ffprobe");

export interface ToolInfo {
  ok: boolean;
  path: string;
  version?: string;
  recent?: boolean; // version >= MIN_FFMPEG
  error?: string;
}

/** Probe an ffmpeg-family tool: does it run, and what version (vs MIN_FFMPEG). */
export async function probeTool(path: string): Promise<ToolInfo> {
  try {
    const { stdout } = await execFileP(path, ["-version"], { timeout: 10_000 });
    const m = stdout.match(/version\s+n?(\d+)\.(\d+)/i);
    const version = stdout.split("\n", 1)[0]?.replace(/^[a-z]+ version\s+/i, "").trim();
    let recent: boolean | undefined;
    if (m) {
      const [, maj, min] = m.map(Number);
      const [rMaj, rMin] = MIN_FFMPEG.split(".").map(Number);
      recent = maj > rMaj || (maj === rMaj && min >= rMin);
    }
    return { ok: true, path, version, recent };
  } catch (e) {
    return { ok: false, path, error: (e as Error).message };
  }
}

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
  nb_frames?: string;
  avg_frame_rate?: string;
}

// codecs that decode as still images (a "video" stream that is really a picture)
const IMAGE_CODECS = new Set([
  "png", "mjpeg", "bmp", "gif", "webp", "tiff", "ppm", "pgm", "apng", "heic", "heif",
]);

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

  // Detect a still image: a single video stream, no audio, decoded by an image
  // codec or with a single frame / no real duration. This works even when the
  // file has a wrong/absent extension (the extension is only a last-resort hint).
  const isImageStream =
    hasVideo &&
    !hasAudio &&
    (IMAGE_CODECS.has((video?.codec_name ?? "").toLowerCase()) ||
      video?.nb_frames === "1" ||
      ((duration === undefined || duration === 0) && video?.avg_frame_rate === "0/0"));

  let modality: Modality;
  if (isImageStream) modality = "image";
  else if (hasVideo) modality = "video";
  else if (hasAudio) modality = "audio";
  else modality = modalityFromExt(path);

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

/** Render an audio spectrogram to a PNG via ffmpeg's native showspectrumpic. */
export async function spectrogram(input: string, outDir: string): Promise<string> {
  ensureDir(outDir);
  const out = join(outDir, `${basename(input, extname(input))}_spectrogram.png`);
  await execFileP(
    FFMPEG_PATH,
    ["-y", "-i", input, "-lavfi", "showspectrumpic=s=1024x512:legend=1", out],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return out;
}

export type EnhanceOp =
  | "denoise"
  | "normalize"
  | "voice-isolate"
  | "upscale"
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
  /** ops that actually contributed a filter */
  ops: EnhanceOp[];
  /** requested ops that did not apply to this modality */
  skipped: EnhanceOp[];
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
  const applied: EnhanceOp[] = [];
  const skipped: EnhanceOp[] = [];
  for (const op of ops) {
    const f = opFilter(op, modality);
    // an audio filter on an image can't apply — count it as skipped, not silent.
    const usableA = Boolean(f.a) && modality !== "image";
    if (f.v) vFilters.push(f.v);
    if (usableA) aFilters.push(f.a as string);
    if (f.v || usableA) applied.push(op);
    else skipped.push(op);
  }

  // Don't run a no-op pass that re-encodes without applying anything — that
  // would report success while changing nothing. Require at least one filter.
  if (applied.length === 0) {
    throw new Error(
      `none of the ops [${ops.join(", ")}] apply to ${modality} media`,
    );
  }

  const ext = modality === "image" ? ".png" : extname(input) || ".mp4";
  const out =
    outPath ?? join(ensureDir(outDir), `${basename(input, extname(input))}_enhanced${ext}`);

  const args = ["-y", "-i", input];
  if (vFilters.length) args.push("-vf", vFilters.join(","));
  if (aFilters.length && modality !== "image") args.push("-af", aFilters.join(","));
  args.push(out);

  await execFileP(FFMPEG_PATH, args, { maxBuffer: 32 * 1024 * 1024 });
  return { output: out, ops: applied, modality, skipped };
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
