// Source providers (scrapers) — the OSINT twin of sense providers. A source
// provider implements `enumerate(query) -> scan.hit records` and
// `fetch(item) -> capture media`. Same exec wire contract as sense providers;
// output is mapped to the loose record at THIS boundary.
//
// Built-in descriptors: youtube (yt-dlp), tiktok (Apify), x/twitter (Apify),
// web (Tavily/Brave).
// Any type can be overridden/added via env `OVERCAST_SOURCE_<TYPE>_CMD=<base command>` — the
// base command is invoked as `<base> enumerate ...` / `<base> fetch ...`. This
// is how the e2e binds a committed fixture source provider offline.

import { dirname, extname, join } from "node:path";
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync } from "node:fs";
import { execCapture, parseFirstJson } from "../exec.js";
import { makeRecord, type OvercastRecord } from "../../record.js";
import { shippedPath } from "../../pkg.js";

/** Path to a shipped source-provider script — resolves the package root (dev) or
 *  beside the executable (bun binary) via the shared shippedPath(). */
function shippedSource(file: string): string | undefined {
  return shippedPath("examples", "providers", "sources", file);
}

export interface SourceDescriptor {
  type: string;
  /** base argv (command + leading args); op (enumerate|fetch) is appended */
  base: string[];
  /** human note about credentials/deps */
  needs?: string;
  /** per-op exec budget for slow backends (e.g. Apify run-sync holds the
   *  request up to 300s); overrides the enumerate/fetch defaults */
  timeoutMs?: number;
}

/** Exec budget for sources backed by Apify's run-sync endpoint (tiktok, lens):
 *  the request itself can hold up to 300s, so the harness must not kill the
 *  provider at the generic 2-min enumerate default. Scripts cap their curls
 *  below this so a slow backend fails client-side with a clear message. */
export const APIFY_RUN_SYNC_TIMEOUT_MS = 6 * 60_000;

/** Built-in source descriptors. yt-dlp / Apify / web search are gated by deps/creds. */
/**
 * Tokenize a command string respecting single/double quotes, so a base command
 * whose path contains spaces can be bound (e.g. `"/My Tools/bridge" enumerate`).
 */
export function tokenizeCommand(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

export function builtinDescriptor(type: string): SourceDescriptor | undefined {
  const envOverride = process.env[`OVERCAST_SOURCE_${type.toUpperCase()}_CMD`];
  if (envOverride) {
    // an override rebinds the COMMAND, not the type's semantics — keep the
    // built-in exec budget so a rebound lens/tiktok (e.g. the live e2e binding
    // the shipped script by absolute path) isn't killed at the generic default.
    return { type, base: tokenizeCommand(envOverride.trim()), timeoutMs: shippedDescriptor(type)?.timeoutMs };
  }
  return shippedDescriptor(type);
}

function shippedDescriptor(type: string): SourceDescriptor | undefined {
  switch (type) {
    case "youtube": {
      // yt-dlp drives both enumerate (flat) and fetch (download). No API key.
      const script = shippedSource("youtube.sh");
      return script ? { type, base: ["bash", script], needs: "yt-dlp on PATH" } : undefined;
    }
    case "tiktok": {
      const script = shippedSource("tiktok.sh");
      return script ? { type, base: ["bash", script], needs: "APIFY_TOKEN", timeoutMs: APIFY_RUN_SYNC_TIMEOUT_MS } : undefined;
    }
    case "x":
    case "twitter": {
      // one script serves both spellings; hits normalize to source "x".
      // Apify run-sync (like tiktok/lens) → needs the longer exec budget.
      const script = shippedSource("x.sh");
      return script ? { type, base: ["bash", script], needs: "APIFY_TOKEN", timeoutMs: APIFY_RUN_SYNC_TIMEOUT_MS } : undefined;
    }
    case "web": {
      const script = shippedSource("web.sh");
      return script ? { type, base: ["bash", script], needs: "TAVILY_API_KEY|BRAVE_API_KEY" } : undefined;
    }
    case "lens": {
      // Google Lens reverse image search (Apify actor); ref/query = image URL
      // or local image path.
      const script = shippedSource("lens.sh");
      return script ? { type, base: ["bash", script], needs: "APIFY_TOKEN", timeoutMs: APIFY_RUN_SYNC_TIMEOUT_MS } : undefined;
    }
    default:
      return undefined;
  }
}

export interface ScanHit {
  title?: string;
  url?: string;
  source?: string;
  published?: string;
  snippet?: string;
  /** optional triage metadata a provider may emit (kept in the loose payload) */
  author?: string;
  views?: number;
  thumb?: string;
  duration?: number;
  media?: { ref: string };
  // triage metadata (author/views/thumb/duration) and any other provider fields
  // ride into the payload via the `...extra` spread in hitsToRecords.
  [k: string]: unknown;
}

/** Map an enumerate result (array or JSONL) into scan.hit records. */
function hitsToRecords(parsed: unknown, sourceType: string): OvercastRecord[] {
  // the enumerate contract is a JSON ARRAY of hits; a non-array (e.g. a lone `{}`)
  // is malformed → zero hits, not one empty ready hit.
  const arr: unknown[] = Array.isArray(parsed) ? parsed : [];
  return arr.map((h) => {
    const hit = (h ?? {}) as ScanHit;
    // any fields beyond the canonical five ride along into the payload (loose
    // record) — provider-specific surrounding data (e.g. lens match kind /
    // matched-image size) must not be dropped at this boundary.
    const { media: hitMedia, title, url, source, published, snippet, ...extra } = hit;
    const media = hitMedia?.ref
      ? { ref: hitMedia.ref }
      : url
        ? { ref: url }
        : undefined;
    return makeRecord({
      verb: "scan",
      format: "json",
      payload: {
        title: title ?? "",
        url: url ?? "",
        source: source ?? sourceType,
        published: published ?? null,
        snippet: snippet ?? "",
        ...extra,
      },
      media,
      meta: { provider: `source:${sourceType}` },
      state: "ready",
    });
  });
}

export interface EnumerateOpts {
  query?: string;
  ref?: string;
  limit?: number;
  since?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Enumerate a source → scan.hit records. Throws on spawn failure. */
export async function enumerateSource(
  desc: SourceDescriptor,
  opts: EnumerateOpts,
): Promise<OvercastRecord[]> {
  const [cmd, ...lead] = desc.base;
  const args = [...lead, "enumerate"];
  const q = opts.query ?? opts.ref ?? "";
  if (q) args.push("--query", q);
  if (opts.limit != null) args.push("--limit", String(opts.limit));
  if (opts.since) args.push("--since", opts.since);

  const res = await execCapture(cmd, args, {
    env: opts.env,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? desc.timeoutMs ?? 2 * 60_000,
  });
  if (res.code !== 0) {
    // exit 13 = missing deps/credentials (exec contract), a setup gap not a hard fail
    return [
      makeRecord({
        verb: "scan",
        format: "json",
        payload: { source: desc.type },
        error: `source ${desc.type} enumerate failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`,
        state: res.code === 13 ? "needs_credentials" : "error",
      }),
    ];
  }
  // Exit 0 but no parseable JSON is a provider problem, not a clean zero-result
  // scan — surface it as an error instead of a silent empty list. (A legitimate
  // empty result parses to `[]`, which yields zero hits without erroring.)
  const parsed = parseFirstJson(res.stdout);
  if (parsed === undefined) {
    return [
      makeRecord({
        verb: "scan",
        format: "json",
        payload: { source: desc.type },
        error: `source ${desc.type} enumerate produced no parseable JSON output`,
        state: "error",
      }),
    ];
  }
  return hitsToRecords(parsed, desc.type);
}

export interface FetchOpts {
  url: string;
  out: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function sniffExt(b: Buffer): string | undefined {
  const at = (off: number, s: string) => b.length >= off + s.length && b.slice(off, off + s.length).toString("latin1") === s;
  if (at(4, "ftyp")) return ".mp4";
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
  return undefined;
}

function ensureMediaExtension(path: string): string {
  if (extname(path)) return path;
  try {
    const fd = openSync(path, "r");
    let head: Buffer;
    try {
      head = Buffer.alloc(32);
      const n = readSync(fd, head, 0, head.length, 0);
      head = head.subarray(0, n);
    } finally {
      closeSync(fd);
    }
    const ext = sniffExt(head);
    if (!ext) return path;
    const next = uniqueExtensionPath(path, ext);
    renameSync(path, next);
    return next;
  } catch {
    return path;
  }
}

function uniqueExtensionPath(path: string, ext: string): string {
  const first = `${path}${ext}`;
  if (!existsSync(first)) return first;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${path}_${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${path}_${Date.now()}${ext}`;
}

/** Fetch a source item into the case → a capture record. */
export async function fetchSource(
  desc: SourceDescriptor,
  opts: FetchOpts,
): Promise<OvercastRecord> {
  const [cmd, ...lead] = desc.base;
  const args = [...lead, "fetch", "--url", opts.url, "--out", opts.out];
  const res = await execCapture(cmd, args, {
    env: opts.env,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? desc.timeoutMs ?? 5 * 60_000,
  });
  if (res.code !== 0) {
    // exit 13 = missing deps/credentials (exec contract), a setup gap not a hard fail
    return makeRecord({
      verb: "capture",
      format: "json",
      payload: { url: opts.url, source: desc.type },
      error: `source ${desc.type} fetch failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`,
      state: res.code === 13 ? "needs_credentials" : "error",
    });
  }
  // provider may emit its own capture record; else synthesize from the out path.
  const parsed = parseFirstJson(res.stdout) as Record<string, unknown> | undefined;
  const reported = (parsed?.path as string) ?? (parsed?.media as { ref?: string })?.ref;
  // Prefer whichever of the reported path / --out actually exists: a provider
  // that writes to --out but returns a different/relative `path` shouldn't read
  // as a failed capture. Only error when NEITHER file is present.
  let path = reported && existsSync(reported) ? reported : opts.out;
  // A provider can exit 0 yet leave no file (or a 0-byte file) on disk — don't
  // report a ready capture for media that isn't actually there.
  const size = existsSync(path) ? (() => { try { return statSync(path).size; } catch { return 0; } })() : -1;
  if (size <= 0) {
    return makeRecord({
      verb: "capture",
      format: "json",
      payload: { url: opts.url, source: desc.type, path },
      error:
        size < 0
          ? `source ${desc.type} fetch reported success but no file at ${path}${reported && reported !== path ? ` (or ${reported})` : ""}`
          : `source ${desc.type} fetch produced an empty (0-byte) file at ${path}`,
      state: "error",
    });
  }
  path = ensureMediaExtension(path);
  return makeRecord({
    verb: "capture",
    format: "json",
    payload: {
      capture_id: "cap_" + Math.abs(hashString(path)).toString(16),
      path,
      kind: parsed?.kind ?? "media",
      source: desc.type,
      url: opts.url,
    },
    media: { ref: path },
    meta: { provider: `source:${desc.type}` },
    state: "ready",
  });
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
