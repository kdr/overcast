// Source providers (scrapers) — the OSINT twin of sense providers. A source
// provider implements `enumerate(query) -> scan.hit records` and
// `fetch(item) -> capture media`. Same exec wire contract as sense providers;
// output is mapped to the loose record at THIS boundary.
//
// Built-in descriptors: youtube (yt-dlp), tiktok (Apify). Any type can be
// overridden/added via env `OVERCAST_SOURCE_<TYPE>_CMD=<base command>` — the
// base command is invoked as `<base> enumerate ...` / `<base> fetch ...`. This
// is how the e2e binds a committed fixture source provider offline.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { execCapture, parseFirstJson } from "../exec.js";
import { makeRecord, type OvercastRecord } from "../../record.js";

/** Path to a shipped source-provider script. tsup bundles the source tree, so we
 *  walk up from this module to find the package root that holds examples/. */
function shippedSource(file: string): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    if (dir.includes("$bunfs") || dir === "/") return undefined; // bun binary
    for (let i = 0; i < 8; i++) {
      const p = join(dir, "examples", "providers", "sources", file);
      if (existsSync(p)) return p;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface SourceDescriptor {
  type: string;
  /** base argv (command + leading args); op (enumerate|fetch) is appended */
  base: string[];
  /** human note about credentials/deps */
  needs?: string;
}

/** Built-in source descriptors. yt-dlp / apify are gated by deps/creds. */
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
    return { type, base: tokenizeCommand(envOverride.trim()) };
  }
  switch (type) {
    case "youtube": {
      // yt-dlp drives both enumerate (flat) and fetch (download). No API key.
      const script = shippedSource("youtube.sh");
      return script ? { type, base: ["bash", script], needs: "yt-dlp on PATH" } : undefined;
    }
    case "tiktok": {
      const script = shippedSource("tiktok.sh");
      return script ? { type, base: ["bash", script], needs: "APIFY_TOKEN" } : undefined;
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
  media?: { ref: string };
  [k: string]: unknown;
}

/** Map an enumerate result (array or JSONL) into scan.hit records. */
function hitsToRecords(parsed: unknown, sourceType: string): OvercastRecord[] {
  const arr: unknown[] = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  return arr.map((h) => {
    const hit = (h ?? {}) as ScanHit;
    const media = hit.media?.ref
      ? { ref: hit.media.ref }
      : hit.url
        ? { ref: hit.url }
        : undefined;
    return makeRecord({
      verb: "scan",
      format: "json",
      payload: {
        title: hit.title ?? "",
        url: hit.url ?? "",
        source: hit.source ?? sourceType,
        published: hit.published ?? null,
        snippet: hit.snippet ?? "",
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
    timeoutMs: opts.timeoutMs ?? 2 * 60_000,
  });
  if (res.code !== 0) {
    return [
      makeRecord({
        verb: "scan",
        format: "json",
        payload: { source: desc.type },
        error: `source ${desc.type} enumerate failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`,
        state: "error",
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
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });
  if (res.code !== 0) {
    return makeRecord({
      verb: "capture",
      format: "json",
      payload: { url: opts.url, source: desc.type },
      error: `source ${desc.type} fetch failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`,
      state: "error",
    });
  }
  // provider may emit its own capture record; else synthesize from the out path.
  const parsed = parseFirstJson(res.stdout) as Record<string, unknown> | undefined;
  const reported = (parsed?.path as string) ?? (parsed?.media as { ref?: string })?.ref;
  // Prefer whichever of the reported path / --out actually exists: a provider
  // that writes to --out but returns a different/relative `path` shouldn't read
  // as a failed capture. Only error when NEITHER file is present.
  const path = reported && existsSync(reported) ? reported : opts.out;
  // A provider can exit 0 yet leave no file on disk — don't report a ready
  // capture for media that isn't there.
  if (!existsSync(path)) {
    return makeRecord({
      verb: "capture",
      format: "json",
      payload: { url: opts.url, source: desc.type, path },
      error: `source ${desc.type} fetch reported success but no file at ${path}${reported && reported !== path ? ` (or ${reported})` : ""}`,
      state: "error",
    });
  }
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
