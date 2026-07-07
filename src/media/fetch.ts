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
import { lookup } from "node:dns/promises";
import { OVERCAST_VERSION } from "../version.js";
import { envEnabled } from "../env.js";

export const isHttpUrl = (ref: string): boolean => /^https?:\/\//i.test(ref);

/** Parse an IPv4 host in ANY inet_aton form — dotted/decimal/hex/octal and 1–4
 *  parts — into a 32-bit int, or null if it isn't a valid IPv4 literal. The OS
 *  resolver accepts these shorthands (`127.1`, `2130706433`, `0x7f.1`, octal),
 *  so a string-shaped dotted-quad check alone lets them slip past the guard. */
function parseLooseIPv4(host: string): number | null {
  let h = host;
  if (h.endsWith(".")) h = h.slice(0, -1); // tolerate a trailing dot
  if (h === "") return null;
  const parts = h.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null; // any non-numeric part → not an IPv4 literal (a real hostname)
    if (!Number.isInteger(n)) return null;
    nums.push(n);
  }
  // inet_aton: the last part fills the remaining low bytes; each leading part is
  // one byte. Enforce the per-part width so 256.0.0.1 etc. aren't valid.
  const maxLast = [0, 0xffffffff, 0xffffff, 0xffff, 0xff][nums.length];
  if (nums[nums.length - 1] > maxLast) return null;
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 0xff) return null;
  let ip = 0;
  for (let i = 0; i < nums.length - 1; i++) ip = (ip | (nums[i] << (8 * (3 - i)))) >>> 0;
  return (ip | nums[nums.length - 1]) >>> 0;
}

/** Is a 32-bit IPv4 int in a loopback/private/link-local/CGNAT range? */
function isBlockedIPv4(ip: number): boolean {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** Expand an IPv6 literal — compressed `::`, full 8-group, or with an embedded
 *  dotted-IPv4 tail (::ffff:1.2.3.4 / ::1.2.3.4) — to its 16 bytes, or null if it
 *  isn't a valid IPv6 literal. Hand-parsed so EVERY spelling normalizes (the old
 *  code only special-cased `::1` / `::` / `::ffff:`). */
function ipv6ToBytes(host: string): Uint8Array | null {
  let s = host.toLowerCase().replace(/%.*$/, ""); // normalize case + drop a %zone id (fe80::1%eth0)
  const v4m = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/); // embedded IPv4 tail
  if (v4m) {
    const v4 = parseLooseIPv4(v4m[2]);
    if (v4 === null) return null;
    s = `${v4m[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const tail = toGroups(halves[1]);
    if (tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...(Array(fill).fill(0) as number[]), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >>> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/** Is an IPv6 address (16 bytes) loopback / unspecified / unique-local / link-local,
 *  or an embedded IPv4 (mapped ::ffff:v4 or compatible ::v4) in a blocked v4 range? */
function isBlockedIPv6(b: Uint8Array): boolean {
  let allZero = true;
  for (let i = 0; i < 15; i++) if (b[i] !== 0) { allZero = false; break; }
  if (allZero && (b[15] === 1 || b[15] === 0)) return true; // ::1 loopback / :: unspecified
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  let first10Zero = true;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) { first10Zero = false; break; }
  if (first10Zero && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    const v4 = ((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0;
    if (v4 !== 0 && isBlockedIPv4(v4)) return true; // embedded IPv4 in a blocked range
  }
  return false;
}

function isBlockedFetchHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv4 in any encoding: catches 127.1 / 2130706433 / 0x.. / octal / trailing dot.
  const ip = parseLooseIPv4(h);
  if (ip !== null) return isBlockedIPv4(ip);
  // IPv6 in any spelling (compressed/expanded, embedded IPv4).
  const v6 = ipv6ToBytes(h);
  if (v6) return isBlockedIPv6(v6);
  return false;
}

/** Is this host an IP literal we FULLY decided in isBlockedFetchHost (so no DNS is
 *  needed)? Only a host that actually PARSES as IPv4 or IPv6 — NOT merely "contains
 *  a colon". A colon-bearing string that ipv6ToBytes can't parse (e.g. a malformed
 *  or zone-suffixed literal) is treated as unvetted and falls through to DNS /
 *  fail-closed, instead of being waved past the guard. */
function isIpLiteralHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "");
  return parseLooseIPv4(h) !== null || ipv6ToBytes(h) !== null;
}

export type HostLookup = (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

/** SSRF guard: overcast fetches media from URLs that can originate in SCRAPED
 *  OSINT hits (invariant #10, untrusted), and the fetched body is described by the
 *  brain LLM and written into evidence — so a request to a private/loopback/
 *  link-local address is an internal-data / cloud-metadata (169.254.169.254) exfil
 *  vector. Blocks, by default (opt out with an affirmative OVERCAST_ALLOW_PRIVATE_FETCH):
 *   1. localhost + private IP literals in every inet_aton encoding (dotted/decimal/
 *      hex/octal/short), synchronously; and
 *   2. a public HOSTNAME that RESOLVES to a private address (DNS rebinding) — via a
 *      DNS lookup of all A/AAAA records.
 *  `fetchMediaToCase` additionally re-runs this per redirect hop, and gates the
 *  URL before the cache-hit return. ACCEPTED RESIDUAL: a narrow TOCTOU window
 *  between this resolve and the socket's own resolve (a same-millisecond DNS
 *  rebind). Closing it needs connect-time IP pinning via a custom undici
 *  dispatcher — but overcast ships primarily as a `bun build --compile` binary,
 *  and bun's fetch ignores an undici dispatcher, so that would protect only the
 *  Node path and leave the binary unchanged. This JS guard runs identically in
 *  both runtimes; the residual is equal in both and deliberately left. */
export async function assertFetchHostAllowed(url: string, opts: { lookup?: HostLookup } = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // malformed URL is caught (and reported) by the caller's own parse
  }
  // Only http(s) is ever fetched. A redirect to file:/gopher:/data:/… has an empty
  // (or otherwise untrusted) host that would slip past the host checks below and let
  // `fetch` read local resources — refuse it outright. Runs even under the
  // private-fetch opt-out (that's for LAN HOSTS, not for enabling other schemes).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`refusing to fetch a non-http(s) URL (${parsed.protocol}): ${url}`);
  }
  // Affirmative-only opt-out: `=0`/`=false` must NOT disable the guard (they're
  // truthy strings) — an operator setting `=0` expects the guard to stay ON.
  if (envEnabled("OVERCAST_ALLOW_PRIVATE_FETCH")) return;
  const host = parsed.hostname;
  const blocked = (what: string) =>
    new Error(`refusing to fetch a private/loopback address (${what}); set OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow: ${url}`);
  if (isBlockedFetchHost(host)) throw blocked(host);
  if (isIpLiteralHost(host)) return; // a public IP literal — already vetted above
  // Real hostname: resolve and reject if ANY resolved address is private.
  const resolve = opts.lookup ?? (lookup as unknown as HostLookup);
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolve(host, { all: true });
  } catch {
    // Fail CLOSED: if we can't resolve the host to verify it, don't fetch it —
    // `fetch` resolves independently and could still reach a private address.
    throw new Error(`could not resolve host to verify it is not private (${host}): ${url}`);
  }
  for (const { address } of addrs) {
    if (isBlockedFetchHost(address)) throw blocked(`${host} → ${address}`);
  }
}

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
 *  bytes land with a sensible extension the senses/ffmpeg can classify).
 *  Also detects definitely-TEXT bodies (".html"/".txt") — an HTML login wall or
 *  error page behind a lying/missing Content-Type must never classify as media
 *  (every real media format below carries binary magic). */
export function sniffExt(b: Buffer): string {
  const at = (off: number, s: string) => b.length >= off + s.length && b.slice(off, off + s.length).toString("latin1") === s;
  if (at(4, "ftyp")) {
    // ISO-BMFF brand: avif/heic are IMAGES riding the mp4 container magic.
    if (at(8, "avif") || at(8, "avis")) return ".avif";
    if (at(8, "heic") || at(8, "heix") || at(8, "mif1") || at(8, "msf1")) return ".heic";
    return ".mp4"; // mp4/mov/m4a
  }
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
  // text detection: strip a UTF-8 BOM + leading whitespace, then look for markup;
  // else call an all-printable-ASCII head plain text (JSON/plain error bodies).
  const start = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  const head = b.subarray(start, start + 256).toString("latin1").trimStart();
  if (/^<(!doctype|html|head|body|\?xml|svg)/i.test(head)) return ".html";
  const probe = b.subarray(start, start + Math.min(64, b.length - start));
  if (probe.length > 0 && probe.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126))) return ".txt";
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

/** Read a fetch Response body into a Buffer, aborting once `maxBytes` is exceeded
 *  (so a missing/lying content-length can't OOM us). Holds at most maxBytes + one
 *  chunk in memory before rejecting. Exported for testing. */
export async function readBodyCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  // A null body = a bodyless response (204/304/HEAD per the Fetch spec) — there's
  // nothing to stream. Return empty rather than res.arrayBuffer(), which would
  // allocate a hostile payload in FULL before any size check (defeating the cap).
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`remote media exceeds cap ${maxBytes} bytes: ${url}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
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
  // Gate the URL BEFORE the cache-hit return below — otherwise a repeat fetch (or
  // a planted url-<hash> artifact) would serve bytes with the guard never run.
  // The redirect loop re-checks each hop; this covers the initial URL + cache path.
  await assertFetchHostAllowed(url);
  mkdirSync(mediaDir, { recursive: true });
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);

  // A URL-path extension makes the name deterministic pre-fetch → cache hit.
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  // Normalized so the cache name matches what a Content-Type/sniff resolution
  // of the same media would produce. NOTE: this pre-fetch cache hit is safe
  // because artifacts are always NAMED by the resolved (response-truth) ext —
  // an HTML body never lands as url-<hash>.jpg, so a .jpg hit is a real image.
  const urlExt = pathname.match(URL_EXT_RE)?.[0]?.toLowerCase().replace(/^\.jpeg$/, ".jpg").replace(/^\.tif$/, ".tiff");
  if (urlExt) {
    const out = join(mediaDir, `url-${hash}${urlExt}`);
    if (existsSync(out)) return { path: out, ext: urlExt, bytes: 0 };
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  // Follow redirects MANUALLY so the SSRF guard re-validates every hop's host —
  // otherwise a public URL could 302 to a private/metadata address after the
  // initial check. Node's `redirect:"manual"` exposes the real 3xx + Location.
  const MAX_REDIRECTS = 5;
  let currentUrl = url; // already guarded above; each redirect target is guarded below
  let res: Response;
  for (let hop = 0; ; hop++) {
    try {
      // Node's fetch sends no User-Agent; several CDNs (e.g. Wikimedia) reject
      // UA-less clients outright, so identify ourselves.
      res = await fetch(currentUrl, {
        signal,
        redirect: "manual",
        headers: { "user-agent": `overcast/${OVERCAST_VERSION}` },
      });
    } catch (e) {
      if (timeout.aborted) throw new Error(`download timed out after ${timeoutMs}ms: ${url}`);
      throw new Error(`download failed: ${(e as Error).message}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS}): ${url}`);
      await res.body?.cancel().catch(() => {}); // release the 3xx body before the next hop (no leak/hang)
      currentUrl = new URL(location, currentUrl).href; // resolve relative Location
      await assertFetchHostAllowed(currentUrl); // re-validate EACH redirect target
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error(`remote media is ${len} bytes (cap ${maxBytes}): ${url}`);
  // Stream the body and STOP at maxBytes — a missing/lying content-length would
  // otherwise let `res.arrayBuffer()` buffer the entire (untrusted) body into
  // memory before any size check, so the "cap" wasn't actually a cap.
  const buf = await readBodyCapped(res, maxBytes, url);

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() || undefined;
  // Response truth wins over the URL's claimed extension: an expired signed URL
  // or login wall answers 200 text/html — that must NOT ride a ".jpg" path into
  // the image pipeline. A definitely-text BODY (per sniff) vetoes everything,
  // including a lying `image/jpeg` Content-Type — no real media is printable
  // text. Otherwise: Content-Type map (it disambiguates ISO-BMFF images) →
  // magic bytes → the URL ext only when the response is uninformative
  // (no/generic content-type, unsniffable bytes).
  const ctExt = contentType ? CT_EXT[contentType] : undefined;
  const sniffed = sniffExt(buf);
  const textish = sniffed === ".html" || sniffed === ".txt";
  const uninformative =
    !contentType || contentType === "application/octet-stream" || contentType === "binary/octet-stream";
  const ext = textish
    ? sniffed
    : ctExt ?? (sniffed !== ".bin" ? sniffed : uninformative ? urlExt ?? ".bin" : ".bin");
  const out = join(mediaDir, `url-${hash}${ext}`);
  writeFileSync(out, buf);
  return { path: out, contentType, ext, bytes: buf.byteLength };
}
