// Internal ffmpeg toolkit (CLAUDE.md invariant #7: ffmpeg is used internally — for
// `enhance`, frame extraction, and `view` — but is NOT a pluggable provider).
// ffmpeg/ffprobe are a SYSTEM PREREQUISITE: resolve an explicit override
// (OVERCAST_FFMPEG / OVERCAST_FFPROBE) or the binary on PATH. `overcast doctor`
// verifies it's installed and recent enough.

import { dirname, join, extname, basename } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { OvercastRecord } from "../record.js";

const execFileP = promisify(execFile);

// Bound internal ffmpeg/ffprobe ops so a crafted/stalled media file can't hang a
// verb forever (captured/scraped media is untrusted — invariant #10). The
// exec-provider path always sets a timeout; these internal calls previously only
// capped maxBuffer. Generous vs. legitimately slow media.
const FFMPEG_MEDIA_TIMEOUT_MS = 5 * 60_000; // probe / frame / still / sheet / spectrogram
const FFMPEG_ENHANCE_TIMEOUT_MS = 20 * 60_000; // enhance filtergraph (can be long)

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

/**
 * Refuse a NON-LOCAL media input at the ffmpeg sink.
 *
 * ffmpeg/ffprobe speak http(s)/rtmp/rtsp/tcp/… themselves, so handing one an
 * attacker-influenced ref makes the SUBPROCESS issue the request — the
 * `assertFetchHostAllowed` guard in media/fetch.ts never runs, and ffmpeg's own
 * stderr (surfaced in the verb's error record) turns it into an
 * internal-host/port oracle. `wall` and `read` already skipped remote refs by
 * hand before calling in; `grid` did not, which is the bypass this closes for
 * every present and future caller.
 *
 * Everything internal reads media overcast has ALREADY materialized locally
 * (the senses download a remote ref through `fetchMediaToCase` first), so the
 * rule is: an existing local file always passes; anything that does not exist
 * and looks like a protocol ref (`http://`, `rtsp://`, `concat:`, `async:`, …)
 * is refused. A non-existent plain path still falls through to ffmpeg's own
 * "No such file" error, and generated patterns like `seq_%03d.jpg` are
 * unaffected.
 */
export function assertLocalMediaInput(input: string, what = "input"): void {
  if (existsSync(input)) return;
  // A scheme needs at least TWO characters before the colon. A one-character
  // prefix is a Windows drive letter (`C:\clip.mp4`), not a protocol — matching
  // it would turn "file not found" into a bogus "non-local" refusal there. No
  // real ffmpeg protocol is single-letter.
  if (/^[a-z][a-z0-9+.-]+:/i.test(input)) {
    throw new Error(
      `refusing to hand a non-local ${what} to ffmpeg (${input}) — download it into the case first`,
    );
  }
}

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
  assertLocalMediaInput(path, "probe input");
  const { stdout } = await execFileP(
    FFPROBE_PATH,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
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

/** probe() that never throws — undefined when ffprobe is missing, the input
 *  is non-local, or the file doesn't parse. For OPTIONAL post-download /
 *  pre-sense stream checks that must not turn a working pipeline into an error
 *  on boxes without ffprobe. */
export async function probeSafe(path: string): Promise<ProbeResult | undefined> {
  try {
    return await probe(path);
  } catch {
    return undefined;
  }
}

/** The warning stamped on records whose VIDEO source carries no audio stream.
 *  Two field failures hide behind a silent audio track: a yt-dlp format that
 *  advertises audio but delivers video-only (data loss nobody flags), and a
 *  sense provider that fabricates `audio_description` spans for a file with no
 *  audio signal at all (trust loss). One shared sentence so capture + watch
 *  can't drift. */
export function noAudioStreamWarning(p: ProbeResult | undefined): string | undefined {
  if (!p || !p.hasVideo || p.hasAudio || p.modality !== "video") return undefined;
  return "no audio stream in this video (ffprobe) — audio was likely dropped at download (yt-dlp formats can advertise aac but deliver video-only; retry with `-S vcodec:h264` or check `yt-dlp -F`), and any audio/speech description a provider returns for it is fabricated";
}

/** Stamp a watch record with the local input's audio-stream truth. Every path
 * that invokes a watch provider (direct watch, index auto-watch, scan --pipe,
 * similar shot sampling) calls this shared post-processor so a side path cannot
 * persist fabricated audio_description/transcript text without the warning.
 * Best-effort: remote refs, missing ffprobe, and unparseable media make no claim. */
export async function stampWatchAudioAvailability(
  rec: OvercastRecord,
  input: string,
): Promise<OvercastRecord> {
  if (rec.state === "error" || rec.state === "needs_credentials" || !rec.payload || typeof rec.payload !== "object") {
    return rec;
  }
  const warning = noAudioStreamWarning(await probeSafe(input));
  if (!warning) return rec;
  rec.meta = { ...rec.meta, has_audio: false };
  const payload = rec.payload as Record<string, unknown>;
  const prior = typeof payload.warning === "string" && payload.warning.trim()
    ? `${payload.warning.trim()}; `
    : "";
  payload.warning = `${prior}${warning} — treat any audio_description/transcript text in this record as unavailable, not evidence`;
  return rec;
}

/** Ensure a directory exists and return it. */
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ffmpeg 8.x's mjpeg encoder refuses non-full-range YUV ("Non full-range YUV is
// non-standard" → ff_frame_thread_encoder_init failed → Conversion failed),
// which limited/unknown-range source video (the common case) produces. Forcing
// the full-range jpeg pixel format on the output makes every .jpg still we write
// encode on ffmpeg 8.x as it did on 7.x. Applied as an OUTPUT option so it is
// independent of each site's filter chain.
const JPEG_FULL_RANGE = "-pix_fmt yuvj420p".split(" ");

/** Extract a single frame at `second` from a video to a jpg. Returns out path. */
export async function extractFrame(
  input: string,
  second: number,
  outDir: string,
): Promise<string> {
  assertLocalMediaInput(input, "frame input");
  ensureDir(outDir);
  const out = join(outDir, `${basename(input, extname(input))}_t${Math.round(second)}.jpg`);
  await execFileP(
    FFMPEG_PATH,
    ["-y", "-ss", String(second), "-i", input, "-frames:v", "1", "-q:v", "2", ...JPEG_FULL_RANGE, out],
    { maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
  );
  return out;
}

/** Extract a small poster frame (≤640px wide) for a local video, so a report can
 *  show a preview WITHOUT the browser opening the video — the fast way to avoid
 *  `preload="metadata"` stalling a page full of large clips. Input-seek (`-ss`
 *  before `-i`) is instant even on a 500MB file; cached by deterministic name;
 *  returns undefined on any failure (caller falls back to no poster). */
export async function posterFrame(input: string, outDir: string, second = 0.5): Promise<string | undefined> {
  try {
    assertLocalMediaInput(input, "poster input");
    ensureDir(outDir);
    const out = join(outDir, `${basename(input, extname(input))}_poster.jpg`);
    if (existsSync(out)) return out;
    await execFileP(
      FFMPEG_PATH,
      ["-y", "-ss", String(second), "-i", input, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "6", ...JPEG_FULL_RANGE, out],
      { maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
    );
    return existsSync(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extract a cropped still from an image/video. For videos, `second` selects the
 * source frame; for still images it is ignored by ffmpeg. */
export async function cropStill(
  input: string,
  box: CropBox,
  out: string,
  second?: number,
): Promise<string> {
  assertLocalMediaInput(input, "crop input");
  ensureDir(dirname(out));
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const width = Math.max(1, Math.floor(box.width));
  const height = Math.max(1, Math.floor(box.height));
  const args = ["-y"];
  if (second != null && Number.isFinite(second)) args.push("-ss", String(second));
  args.push(
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `crop=${width}:${height}:${x}:${y}`,
    "-q:v",
    "2",
    ...JPEG_FULL_RANGE,
    out,
  );
  await execFileP(FFMPEG_PATH, args, { maxBuffer: 32 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS });
  return out;
}

// ---- contact sheet (frame grid) --------------------------------------------
// Tile N timestamped frames into ONE labeled image for a single-call VLM triage
// pass (the "grid trick": T*/temporal-search + Set-of-Mark over time). Labels are
// burned per cell ONLY when this ffmpeg build has `drawtext` (needs libfreetype)
// AND a usable font is found; otherwise the sheet is unlabeled and the caller
// falls back to positional numbering. Either way the cell→timestamp map is exact
// and returned in `cells` — the burned label is a convenience, not the record.

let drawtextCache: boolean | undefined;

/** Does this ffmpeg build have the `drawtext` filter? (cached; libfreetype-gated) */
export async function hasDrawtext(): Promise<boolean> {
  if (drawtextCache !== undefined) return drawtextCache;
  try {
    const { stdout } = await execFileP(FFMPEG_PATH, ["-hide_banner", "-filters"], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    drawtextCache = /\bdrawtext\b/.test(stdout);
  } catch {
    drawtextCache = false;
  }
  return drawtextCache;
}

// Common TTF locations across macOS + Linux; OVERCAST_GRID_FONT overrides. `.ttc`
// collections are skipped (drawtext needs a face index for those).
const FONT_CANDIDATES = [
  process.env.OVERCAST_GRID_FONT,
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
];

/** First usable TTF for drawtext labels, or undefined. */
export function findGridFont(): string | undefined {
  return FONT_CANDIDATES.find((f): f is string => !!f && existsSync(f));
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

export interface GridCell {
  /** 1-based cell number, left-to-right then top-to-bottom */
  n: number;
  /** source timestamp (seconds) this cell was sampled from, or null for a blank
   *  padding tile that fills out the last row (so every tile position maps). */
  at: number | null;
}

export interface ContactSheetResult {
  output: string;
  cells: GridCell[];
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  /** whether cell numbers/timestamps were burned into the image */
  labeled: boolean;
}

export interface ContactSheetOpts {
  cols?: number;
  cellWidth?: number;
  outPath?: string;
  /** force labels off even when drawtext is available */
  label?: boolean;
}

/**
 * Build a labeled contact sheet from a video at the given `seconds`. Extracts one
 * uniformly-sized cell per timestamp (letterboxed to preserve aspect), burns a
 * `<n>  <t>s` label when drawtext is available, pads the final row with blank
 * cells so `tile` gets an exact grid, then tiles them into one image.
 */
export async function contactSheet(
  input: string,
  seconds: number[],
  outDir: string,
  opts: ContactSheetOpts = {},
): Promise<ContactSheetResult> {
  if (seconds.length === 0) throw new Error("contact sheet needs at least one timestamp");
  assertLocalMediaInput(input, "contact sheet input");
  ensureDir(outDir);

  const cellWidth = clampInt(opts.cellWidth ?? 320, 120, 960);
  const p = await probe(input).catch(() => undefined);
  const aspect = p?.width && p?.height ? p.height / p.width : 9 / 16;
  let cellHeight = Math.round(cellWidth * aspect);
  if (cellHeight % 2) cellHeight += 1; // keep even for codec friendliness

  const n = seconds.length;
  const cols = clampInt(opts.cols ?? Math.ceil(Math.sqrt(n)), 1, 12);
  const rows = Math.ceil(n / cols);
  const slots = cols * rows;

  const labeled = opts.label !== false && (await hasDrawtext()) && !!findGridFont();
  const font = findGridFont();
  const fontSize = clampInt(cellWidth / 14, 14, 40);

  const base = basename(input, extname(input));
  // include a hash of the actual samples + layout so two grids of the same clip
  // with the same frame count but different windows/--at lists don't reuse (and
  // overwrite) one path — which would strand earlier records on a stale montage.
  const sig = shortHash({ seconds, cols, cellWidth, cellHeight, labeled });
  const out = opts.outPath ?? join(outDir, `${safeName(base)}_grid_${n}_${sig}.png`);
  ensureDir(dirname(out)); // a caller-supplied nested --out needs its parent created first
  const work = mkdtempSync(join(tmpdir(), "oc-grid-"));
  const missing = new Set<number>(); // sample indices whose frame never materialized
  try {
    const scalePad =
      `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;
    for (let i = 0; i < n; i++) {
      const cell = join(work, `cell_${String(i + 1).padStart(3, "0")}.jpg`);
      let vf = scalePad;
      if (labeled && font) {
        // label text is number + rounded seconds only (no ':'/',' — those are
        // filtergraph separators, so the text itself needs no escaping). The font
        // path CAN contain them (a Windows `C:\...` or OVERCAST_GRID_FONT), so it
        // must be escaped for the filtergraph.
        const label = `${i + 1}  ${Math.round(seconds[i])}s`;
        vf +=
          `,drawtext=fontfile=${escFilterValue(font)}:text=${label}:x=10:y=10:` +
          `fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
      }
      await execFileP(
        FFMPEG_PATH,
        ["-y", "-ss", String(seconds[i]), "-i", input, "-frames:v", "1", "-q:v", "3", "-vf", vf, ...JPEG_FULL_RANGE, cell],
        { maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
      );
      // ffmpeg can exit 0 with NO frame written when a seek lands at/past the last
      // decodable frame (near-EOF on some containers). A gap would truncate the
      // image2 sequence in the tile pass below and SHIFT every later cell off its
      // mapped timestamp — substitute the filler and null the mapping (invariant:
      // reject/blank rather than lie) instead of silently mislabeling cells.
      if (!existsSync(cell)) missing.add(i);
    }
    // pad the last row so `tile` receives an exact cols×rows sequence — the
    // partial-tile-at-EOF behavior varies across ffmpeg versions; a full grid is
    // deterministic. Fillers reuse the tile background color. Also backfill any
    // sampled cell whose frame never materialized (`missing`) so the image2
    // sequence stays gapless and no later cell shifts into a dropped slot.
    if (n < slots || missing.size) {
      const filler = join(work, "filler.jpg");
      await execFileP(
        FFMPEG_PATH,
        ["-y", "-f", "lavfi", "-i", `color=c=0x101418:s=${cellWidth}x${cellHeight}`, "-frames:v", "1", ...JPEG_FULL_RANGE, filler],
        { maxBuffer: 8 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
      );
      for (const i of missing) {
        copyFileSync(filler, join(work, `cell_${String(i + 1).padStart(3, "0")}.jpg`));
      }
      for (let i = n; i < slots; i++) {
        copyFileSync(filler, join(work, `cell_${String(i + 1).padStart(3, "0")}.jpg`));
      }
    }
    await execFileP(
      FFMPEG_PATH,
      [
        "-y", "-framerate", "1", "-i", join(work, "cell_%03d.jpg"),
        "-frames:v", "1", "-vf", `tile=${cols}x${rows}:padding=6:margin=6:color=0x101418`, out,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // map EVERY tile position (cols×rows), not just the sampled ones — the trailing
  // blank fillers AND any dropped (missing) sample get at:null, so a cell number
  // read off the montage always resolves (to a timestamp, or to null = blank)
  // instead of pointing at a shifted/wrong source moment.
  const cells: GridCell[] = Array.from({ length: slots }, (_, i) => ({
    n: i + 1,
    at: i < n && !missing.has(i) ? seconds[i] : null,
  }));
  return { output: out, cells, cols, rows, cellWidth, cellHeight, labeled };
}

/** Filesystem-safe filename part. */
function safeName(s: string): string {
  return s.replace(/[^a-z0-9_.-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "grid";
}

/** Short deterministic content hash for a collision-free default output name:
 *  same inputs → same name (idempotent), different inputs → different name (so a
 *  second run with a different window/op set can't overwrite the first's file and
 *  leave an earlier record pointing at a montage/output that no longer matches). */
function shortHash(parts: unknown): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 10);
}

/** Escape a value (e.g. a font path) for an ffmpeg filtergraph option: backslash
 *  first, then the ':' option / ',' filter separators and the "'" quote — so a
 *  Windows `C:\Fonts\Arial.ttf` becomes `C\:\\Fonts\\Arial.ttf` instead of
 *  splitting the drawtext options. */
function escFilterValue(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/'/g, "\\'");
}

export interface ImageSheetOpts {
  cols?: number;
  cellWidth?: number;
  outPath?: string;
  /** force labels off even when drawtext is available */
  label?: boolean;
}

export interface ImageSheetResult {
  output: string;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  labeled: boolean;
}

/** drawtext label text: keep it to characters that never need filtergraph
 *  escaping (':'/','/quote are separators — contactSheet avoids them by
 *  construction; sheet labels come from callers, so sanitize instead). */
function safeLabel(s: string): string {
  return s.replace(/[^A-Za-z0-9 °.+_=-]+/g, " ").trim().slice(0, 24);
}

/**
 * Tile separate IMAGE FILES into one labeled contact sheet — the still-image
 * sibling of `contactSheet` (which samples ONE video at timestamps). Used by
 * `reconstruct --ops sweep` to put every synthesized camera stop on a single
 * VLM-triageable montage (the `grid` trick, but the cells are distinct files).
 * Cells keep the first image's aspect (letterboxed); labels are burned only when
 * drawtext is available, matching contactSheet's degrade behavior.
 */
export async function tileImageSheet(
  images: Array<{ path: string; label?: string }>,
  outDir: string,
  opts: ImageSheetOpts = {},
): Promise<ImageSheetResult> {
  if (images.length === 0) throw new Error("image sheet needs at least one image");
  ensureDir(outDir);

  const cellWidth = clampInt(opts.cellWidth ?? 320, 120, 960);
  const p = await probe(images[0].path).catch(() => undefined);
  const aspect = p?.width && p?.height ? p.height / p.width : 9 / 16;
  let cellHeight = Math.round(cellWidth * aspect);
  if (cellHeight % 2) cellHeight += 1;

  const n = images.length;
  const cols = clampInt(opts.cols ?? Math.ceil(Math.sqrt(n)), 1, 12);
  const rows = Math.ceil(n / cols);
  const slots = cols * rows;

  const labeled = opts.label !== false && (await hasDrawtext()) && !!findGridFont();
  const font = findGridFont();
  const fontSize = clampInt(cellWidth / 14, 14, 40);

  const base = basename(images[0].path, extname(images[0].path));
  const sig = shortHash({ images: images.map((i) => [i.path, i.label]), cols, cellWidth, cellHeight, labeled });
  const out = opts.outPath ?? join(outDir, `${safeName(base)}_sheet_${n}_${sig}.png`);
  ensureDir(dirname(out));
  const work = mkdtempSync(join(tmpdir(), "oc-sheet-"));
  const missing = new Set<number>();
  try {
    const scalePad =
      `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
      `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;
    for (let i = 0; i < n; i++) {
      const cell = join(work, `cell_${String(i + 1).padStart(3, "0")}.jpg`);
      let vf = scalePad;
      const label = safeLabel(images[i].label ?? String(i + 1));
      if (labeled && font && label) {
        vf +=
          `,drawtext=fontfile=${escFilterValue(font)}:text=${escFilterValue(label)}:x=10:y=10:` +
          `fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
      }
      if (existsSync(images[i].path)) {
        await execFileP(
          FFMPEG_PATH,
          ["-y", "-i", images[i].path, "-frames:v", "1", "-q:v", "3", "-vf", vf, ...JPEG_FULL_RANGE, cell],
          { maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
        ).catch(() => undefined);
      }
      // a cell that never materialized becomes a filler + stays labeled missing,
      // so later cells can't shift into its slot (contactSheet invariant).
      if (!existsSync(cell)) missing.add(i);
    }
    if (n < slots || missing.size) {
      const filler = join(work, "filler.jpg");
      await execFileP(
        FFMPEG_PATH,
        ["-y", "-f", "lavfi", "-i", `color=c=0x101418:s=${cellWidth}x${cellHeight}`, "-frames:v", "1", ...JPEG_FULL_RANGE, filler],
        { maxBuffer: 8 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
      );
      for (const i of missing) {
        copyFileSync(filler, join(work, `cell_${String(i + 1).padStart(3, "0")}.jpg`));
      }
      for (let i = n; i < slots; i++) {
        copyFileSync(filler, join(work, `cell_${String(i + 1).padStart(3, "0")}.jpg`));
      }
    }
    await execFileP(
      FFMPEG_PATH,
      [
        "-y", "-framerate", "1", "-i", join(work, "cell_%03d.jpg"),
        "-frames:v", "1", "-vf", `tile=${cols}x${rows}:padding=6:margin=6:color=0x101418`, out,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { output: out, cols, rows, cellWidth, cellHeight, labeled };
}

/**
 * Encode an ordered list of still images into a short looping video (the
 * `reconstruct --ops sweep` turntable). Every frame is letterboxed to the first
 * image's (even-rounded, capped) dimensions so mixed sizes can't break the
 * encode; yuv420p keeps it playable in <video> everywhere.
 */
export async function imagesToVideo(
  images: string[],
  outPath: string,
  opts: { fps?: number; maxWidth?: number } = {},
): Promise<string> {
  const frames = images.filter((f) => existsSync(f));
  if (frames.length < 2) throw new Error("turntable video needs at least two frames");
  ensureDir(dirname(outPath));
  const fps = Math.max(1, Math.min(12, Math.round(opts.fps ?? 2)));

  const p = await probe(frames[0]).catch(() => undefined);
  let w = Math.min(p?.width ?? 960, clampInt(opts.maxWidth ?? 1280, 240, 1920));
  let h = Math.round(w * ((p?.width && p?.height ? p.height / p.width : 9 / 16)));
  if (w % 2) w += 1;
  if (h % 2) h += 1;

  const work = mkdtempSync(join(tmpdir(), "oc-turntable-"));
  try {
    const scalePad =
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
    let k = 0;
    for (const f of frames) {
      k += 1;
      await execFileP(
        FFMPEG_PATH,
        ["-y", "-i", f, "-frames:v", "1", "-q:v", "3", "-vf", scalePad, ...JPEG_FULL_RANGE, join(work, `seq_${String(k).padStart(3, "0")}.jpg`)],
        { maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
      );
    }
    await execFileP(
      FFMPEG_PATH,
      ["-y", "-framerate", String(fps), "-i", join(work, "seq_%03d.jpg"), "-pix_fmt", "yuv420p", outPath],
      { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return outPath;
}

/** Render an audio spectrogram to a PNG via ffmpeg's native showspectrumpic. */
export async function spectrogram(input: string, outDir: string): Promise<string> {
  assertLocalMediaInput(input, "spectrogram input");
  ensureDir(outDir);
  const out = join(outDir, `${basename(input, extname(input))}_spectrogram.png`);
  await execFileP(
    FFMPEG_PATH,
    ["-y", "-i", input, "-lavfi", "showspectrumpic=s=1024x512:legend=1", out],
    { maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_MEDIA_TIMEOUT_MS },
  );
  return out;
}

/** The deterministic ffmpeg enhance ops (runtime source of truth for the type +
 *  the enhance verb's known-ops validation). Split ops (separate/segment) are NOT
 *  here — they require a bound provider (see PROVIDER_ONLY_OPS in verbs/senses). */
export const ENHANCE_OPS = ["denoise", "normalize", "voice-isolate", "upscale", "stabilize", "grayscale"] as const;
export type EnhanceOp = (typeof ENHANCE_OPS)[number];

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
  assertLocalMediaInput(input, "enhance input");
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
  // key the default name on the applied ops so enhancing one file two different
  // ways (e.g. grayscale then denoise) doesn't overwrite the first output and
  // leave its record pointing at the wrong media — same ops still map to one file.
  const out =
    outPath ??
    join(ensureDir(outDir), `${basename(input, extname(input))}_enhanced_${shortHash(applied)}${ext}`);
  ensureDir(dirname(out)); // a caller-supplied nested --out needs its parent created too

  const args = ["-y", "-i", input];
  if (vFilters.length) args.push("-vf", vFilters.join(","));
  if (aFilters.length && modality !== "image") args.push("-af", aFilters.join(","));
  args.push(out);

  await execFileP(FFMPEG_PATH, args, { maxBuffer: 32 * 1024 * 1024, timeout: FFMPEG_ENHANCE_TIMEOUT_MS });
  return { output: out, ops: applied, modality, skipped };
}

export interface FrameRef {
  recordId: string;
  second: number;
}

/** Parse a seek/timestamp: plain seconds ("42", "42.5") or a timecode with 2–3
 *  segments ("1:02", "1:02:14"; decimals allowed in any segment). Returns
 *  undefined for negatives, >3 segments, or non-numeric segments. THE single
 *  implementation for every --at/--start/--end across verbs. */
export function parseTimecode(s: string): number | undefined {
  const str = s.trim();
  if (!str) return undefined;
  if (str.includes(":")) {
    const parts = str.split(":");
    if (parts.length < 2 || parts.length > 3) return undefined;
    if (!parts.every((p) => /^\d+(?:\.\d+)?$/.test(p))) return undefined;
    const nums = parts.map(Number);
    return nums.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  const n = Number(str);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Parse a point ("90", "1:30") or span ("80-95", "1:20-1:35") --at value.
 *  A span with end < start is invalid. */
export function parseAtSpan(s: string): number | [number, number] | undefined {
  const raw = s.trim();
  if (!raw) return undefined;
  const span = raw.match(/^(.+)-(.+)$/);
  if (span) {
    const start = parseTimecode(span[1]);
    const end = parseTimecode(span[2]);
    if (start == null || end == null || end < start) return undefined;
    return [start, end];
  }
  return parseTimecode(raw);
}

/** Parse a `frame://rec_xxx@134` reference. Returns null if not a frame ref. */
export function parseFrameRef(ref: string): FrameRef | null {
  const m = ref.match(/^frame:\/\/([^@]+)@(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { recordId: m[1], second: Number(m[2]) };
}

export { dirname };
