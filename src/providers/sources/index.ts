// Source providers (scrapers) — the OSINT twin of sense providers. A source
// provider implements `enumerate(query) -> scan.hit records` and
// `fetch(item) -> capture media`. Same exec wire contract as sense providers;
// output is mapped to the loose record at THIS boundary.
//
// Built-in descriptors: youtube (yt-dlp), tiktok (Apify). Any type can be
// overridden/added via env `OVERCAST_SOURCE_<TYPE>_CMD=<base command>` — the
// base command is invoked as `<base> enumerate ...` / `<base> fetch ...`. This
// is how the e2e binds a committed fixture source provider offline.

import { execCapture, parseFirstJson } from "../exec.js";
import { makeRecord, type OvercastRecord } from "../../record.js";

export interface SourceDescriptor {
  type: string;
  /** base argv (command + leading args); op (enumerate|fetch) is appended */
  base: string[];
  /** human note about credentials/deps */
  needs?: string;
}

/** Built-in source descriptors. yt-dlp / apify are gated by deps/creds. */
export function builtinDescriptor(type: string): SourceDescriptor | undefined {
  const envOverride = process.env[`OVERCAST_SOURCE_${type.toUpperCase()}_CMD`];
  if (envOverride) {
    return { type, base: envOverride.trim().split(/\s+/) };
  }
  switch (type) {
    case "youtube":
      // yt-dlp drives both enumerate (flat) and fetch (download). No API key.
      return { type, base: ["overcast-source-youtube"], needs: "yt-dlp on PATH" };
    case "tiktok":
      return { type, base: ["overcast-source-tiktok"], needs: "APIFY_TOKEN" };
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
  return hitsToRecords(parseFirstJson(res.stdout), desc.type);
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
  const path = (parsed?.path as string) ?? (parsed?.media as { ref?: string })?.ref ?? opts.out;
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
