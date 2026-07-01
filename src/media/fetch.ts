// Fetch remote media into the case store. ONE download path for verbs that need
// a LOCAL file from an http(s) ref — `see` uses it so a pasted image URL "just
// works" for every backend (the brain LLM, the HF captioner, exec detectors all
// read local files). The artifact lands in the case media dir (evidence, like
// `capture`), named by a hash of the URL so repeat calls reuse the same file.
//
// Extension resolution (so ffmpeg/senses can classify the artifact):
//   URL path ext (if a known media ext) → Content-Type → magic-byte sniff.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OVERCAST_VERSION } from "../version.js";

export const isHttpUrl = (ref: string): boolean => /^https?:\/\//i.test(ref);

const CT_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/mpeg": ".mpg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
};

// Known media extensions a URL path can assert directly (query/fragment ignored).
const URL_EXT_RE =
  /\.(jpe?g|png|webp|gif|bmp|tiff?|avif|heic|mp4|m4v|mov|webm|mkv|avi|mpe?g|mp3|m4a|wav|flac|ogg|opus|aac)$/i;

/** Best-effort media extension from leading magic bytes (so downloaded/piped
 *  bytes land with a sensible extension the senses/ffmpeg can classify). */
export function sniffExt(b: Buffer): string {
  const at = (off: number, s: string) => b.length >= off + s.length && b.slice(off, off + s.length).toString("latin1") === s;
  if (at(4, "ftyp")) return ".mp4"; // ISO-BMFF: mp4/mov/m4a
  if (at(0, "RIFF") && at(8, "WEBP")) return ".webp";
  if (at(0, "RIFF") && at(8, "WAVE")) return ".wav";
  if (at(0, "RIFF") && at(8, "AVI ")) return ".avi";
  if (b[0] === 0x89 && at(1, "PNG")) return ".png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (at(0, "GIF8")) return ".gif";
  if (at(0, "OggS")) return ".ogg";
  if (at(0, "fLaC")) return ".flac";
  if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return ".mp3";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ".webm";
  return ".bin";
}

export type MediaKind = "image" | "av" | "other";

/** Classify a resolved extension for caller routing (see wants images; a video
 *  URL should be redirected to watch/listen instead of sent to a VLM). */
export function kindForExt(ext: string): MediaKind {
  if (/^\.(jpe?g|png|webp|gif|bmp|tiff?|avif|heic)$/i.test(ext)) return "image";
  if (/^\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|mpg|mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(ext)) return "av";
  return "other";
}

export interface FetchedMedia {
  /** local path of the downloaded artifact (inside the case media dir) */
  path: string;
  /** response Content-Type (main value only), when the server sent one */
  contentType?: string;
  /** resolved extension, e.g. ".jpg" (".bin" when nothing could classify it) */
  ext: string;
  bytes: number;
}

export interface FetchMediaOpts {
  timeoutMs?: number;
  /** hard cap on the downloaded size (default 64 MB) */
  maxBytes?: number;
  signal?: AbortSignal;
}

/**
 * Download an http(s) media URL into `mediaDir` and return the local artifact.
 * Throws with a clear message on HTTP errors, timeout, abort, or size overrun.
 * When the URL path carries a known media extension the artifact name is
 * deterministic up front and an existing file is reused without re-downloading.
 */
export async function fetchMediaToCase(
  url: string,
  mediaDir: string,
  opts: FetchMediaOpts = {},
): Promise<FetchedMedia> {
  const { timeoutMs = 60_000, maxBytes = 64 * 1024 * 1024 } = opts;
  mkdirSync(mediaDir, { recursive: true });
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);

  // A URL-path extension makes the name deterministic pre-fetch → cache hit.
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  const urlExt = pathname.match(URL_EXT_RE)?.[0]?.toLowerCase();
  if (urlExt) {
    const out = join(mediaDir, `url-${hash}${urlExt}`);
    if (existsSync(out)) return { path: out, ext: urlExt, bytes: 0 };
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    // Node's fetch sends no User-Agent; several CDNs (e.g. Wikimedia) reject
    // UA-less clients outright, so identify ourselves.
    res = await fetch(url, { signal, headers: { "user-agent": `overcast/${OVERCAST_VERSION}` } });
  } catch (e) {
    if (timeout.aborted) throw new Error(`download timed out after ${timeoutMs}ms: ${url}`);
    throw new Error(`download failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error(`remote media is ${len} bytes (cap ${maxBytes}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`remote media is ${buf.byteLength} bytes (cap ${maxBytes}): ${url}`);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() || undefined;
  const ext = urlExt ?? (contentType && CT_EXT[contentType]) ?? sniffExt(buf);
  const out = join(mediaDir, `url-${hash}${ext}`);
  writeFileSync(out, buf);
  return { path: out, contentType, ext, bytes: buf.byteLength };
}
