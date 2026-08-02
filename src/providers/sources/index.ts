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
import { assertFetchHostAllowed } from "../../media/fetch.js";
import { noAudioStreamWarning, probeSafe } from "../../media/ffmpeg.js";
import { makeRecord, type OvercastRecord } from "../../record.js";
import { redactSecrets } from "../../env.js";
import { resolveShippedArgv } from "../shipped-ref.js";
import { ProviderRefError } from "../ref-error.js";
import { manifestSourceDescriptor } from "../manifests.js";

export interface SourceDescriptor {
  type: string;
  /** base argv (command + leading args); op (enumerate|fetch) is appended */
  base: string[];
  /** human note about credentials/deps */
  needs?: string;
  /** per-op exec budget for slow backends (e.g. Apify run-sync holds the
   *  request up to 300s); overrides the enumerate/fetch defaults */
  timeoutMs?: number;
  /** the source honors `--limit 0` as "enumerate everything" (yt-dlp local
   *  enumeration). Sources without it never see a 0 — the seam omits --limit so
   *  the provider's own default cap applies (an Apify actor handed 0 could read
   *  it as UNLIMITED billing, a SODA/SERP API as zero rows). */
  uncappedLimit?: boolean;
  /** alternate fetch kinds the provider serves instead of the default media
   *  download (youtube: transcript, thumb). Callers gate --transcript/--thumb
   *  on this so sources that would ignore the advisory flag keep their normal
   *  pull behavior (including remote direct-sense plans). */
  fetchKinds?: string[];
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

export function builtinDescriptor(type: string, home?: string): SourceDescriptor | undefined {
  const envOverride = process.env[`OVERCAST_SOURCE_${type.toUpperCase()}_CMD`];
  if (envOverride) {
    // an override rebinds the COMMAND, not the type's semantics — keep the
    // built-in exec budget (so a rebound lens/tiktok isn't killed at the generic
    // default) AND the built-in capability flags (a rebound youtube still honors
    // --limit 0 / --transcript).
    const shipped = shippedDescriptor(type, home);
    return {
      type,
      base: tokenizeCommand(envOverride.trim()),
      timeoutMs: shipped?.timeoutMs,
      uncappedLimit: shipped?.uncappedLimit,
      fetchKinds: shipped?.fetchKinds,
    };
  }
  return shippedDescriptor(type, home);
}

function shippedDescriptor(type: string, home?: string): SourceDescriptor | undefined {
  // Built-in source descriptors now come from the per-directory provider.json
  // manifests under providers/sources/<type>/ (scanned at runtime). The manifest
  // layer resolves the script's shipped:/installed: ref to an absolute base argv
  // (aliases like x→twitter honored), returning undefined when the type is
  // unknown or its script isn't in this build — same contract as the old switch.
  return manifestSourceDescriptor(type, home);
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
  /** ctx.home for resolving installed:<pkg>/… in an OVERCAST_SOURCE_*_CMD override base */
  home?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The provider `--since` contract is the shared shell grammar: a relative
 *  `N[smhdw]` duration or a bare `YYYY-MM-DD` date. The CLI gate (parseSince)
 *  is wider — anything Date.parse reads (ISO datetimes, RFC dates) — so the
 *  surplus forms are narrowed HERE, at the one seam every enumerate crosses,
 *  instead of teaching every shell provider to parse datetimes. The rewrite is
 *  a ceiled relative duration in the coarsest unit every provider maps
 *  correctly (minutes under an hour, hours under a day, else days —
 *  web/dork/telegram collapse any `Nh` to one day, so multi-day cutoffs must
 *  travel as `Nd`); ceiling means the window only ever WIDENS — a recency
 *  filter may return slightly more than asked, never silently less. */
export function normalizeSince(since: string): string {
  if (/^\d+[smhdw]$/.test(since) || /^\d{4}-\d{2}-\d{2}$/.test(since)) return since;
  const abs = Date.parse(since);
  if (Number.isNaN(abs)) return since; // not parseable — the provider's fail-closed error owns it
  const mins = Math.max(1, Math.ceil((Date.now() - abs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.ceil(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

/** Exec budget for an UNCAPPED (--limit 0) enumerate on a source that declares
 *  uncappedLimit: a whole-channel/playlist flat dump legitimately runs many
 *  minutes, and the generic 2-min budget would kill it mid-dump and report a
 *  healthy yt-dlp as an enumerate failure. Explicit opts/desc budgets win. */
export const UNCAPPED_ENUMERATE_TIMEOUT_MS = 15 * 60_000;

export function enumerateBudgetMs(desc: SourceDescriptor, opts: EnumerateOpts): number {
  if (opts.timeoutMs != null) return opts.timeoutMs;
  if (desc.timeoutMs != null) return desc.timeoutMs;
  if (opts.limit === 0 && desc.uncappedLimit) return UNCAPPED_ENUMERATE_TIMEOUT_MS;
  return 2 * 60_000;
}

/** Enumerate a source → scan.hit records. Throws on spawn failure. */
export async function enumerateSource(
  desc: SourceDescriptor,
  opts: EnumerateOpts,
): Promise<OvercastRecord[]> {
  // resolve any `shipped:` tokens in the base argv at spawn time — an
  // OVERCAST_SOURCE_*_CMD override (or a healed source path) can carry the same
  // portable ref the sense providers use (plan 07 Stage B). Builtins pre-resolve
  // via shippedProviderPath, so this is a no-op for them.
  let base: string[];
  try {
    base = resolveShippedArgv(desc.base, opts.home);
  } catch (e) {
    if (!(e instanceof ProviderRefError)) throw e;
    return [makeRecord({ verb: "scan", format: "json", payload: { source: desc.type }, error: e.message, state: "error" })];
  }
  const [cmd, ...lead] = base;
  const args = [...lead, "enumerate"];
  const q = opts.query ?? opts.ref ?? "";
  if (q) args.push("--query", q);
  // --limit 0 = uncapped, but ONLY sources that declare uncappedLimit ever see
  // the 0 (yt-dlp local enumeration). For everyone else the flag is omitted so
  // the provider's own default cap applies — an Apify actor handed 0 could read
  // it as UNLIMITED (billing), a SODA/SERP backend as zero rows.
  if (opts.limit != null && (opts.limit > 0 || desc.uncappedLimit)) {
    args.push("--limit", String(opts.limit));
  }
  if (opts.since) args.push("--since", normalizeSince(opts.since));

  const res = await execCapture(cmd, args, {
    env: opts.env,
    signal: opts.signal,
    timeoutMs: enumerateBudgetMs(desc, opts),
  });
  if (res.code !== 0) {
    // exit 13 = missing deps/credentials (exec contract), a setup gap not a hard fail
    return [
      makeRecord({
        verb: "scan",
        format: "json",
        payload: { source: desc.type },
        error: `source ${desc.type} enumerate failed (exit ${res.code}): ${redactSecrets(res.stderr.trim().slice(0, 300))}`,
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
  /** alternate fetch mode (e.g. youtube `transcript` / `thumb` — captions or
   *  thumbnail instead of the video, no media download). Advisory: forwarded as
   *  `--kind <k>` on the fetch argv; providers that don't implement modes skip
   *  the unknown flag (the exec-contract catchall) and fetch as usual. */
  kind?: string;
  /** caption language for kind=transcript (forwarded as `--lang <code>`) */
  lang?: string;
  home?: string;
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
  // SSRF guard at the SINK: the fetcher we are about to spawn (curl/yt-dlp)
  // performs the request itself, so this is the last place the private-address
  // refusal can apply. captureRef checks too — this one makes the seam safe for
  // every caller, including a future one that forgets. Same guard, same
  // OVERCAST_ALLOW_PRIVATE_FETCH opt-out as fetchMediaToCase.
  try {
    await assertFetchHostAllowed(opts.url);
  } catch (e) {
    return makeRecord({
      verb: "capture",
      format: "json",
      payload: { url: opts.url, source: desc.type },
      error: (e as Error).message,
      state: "error",
    });
  }
  // resolve any `shipped:` tokens in the base argv (see enumerateSource).
  let base: string[];
  try {
    base = resolveShippedArgv(desc.base, opts.home);
  } catch (e) {
    if (!(e instanceof ProviderRefError)) throw e;
    return makeRecord({ verb: "capture", format: "json", payload: { url: opts.url, source: desc.type }, error: e.message, state: "error" });
  }
  const [cmd, ...lead] = base;
  const args = [...lead, "fetch", "--url", opts.url, "--out", opts.out];
  if (opts.kind) args.push("--kind", opts.kind);
  if (opts.lang) args.push("--lang", opts.lang);
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
      error: `source ${desc.type} fetch failed (exit ${res.code}): ${redactSecrets(res.stderr.trim().slice(0, 300))}`,
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
  // like hitsToRecords: fields beyond the canonical capture shape ride along into
  // the payload (loose record) — e.g. a transcript fetch's title/description/
  // transcript text must not be dropped at this boundary. Canonical keys win.
  const { path: _rp, media: _rm, kind: reportedKind, source: _rs, url: _ru, ...extra } =
    (parsed ?? {}) as Record<string, unknown>;
  // post-download stream check: a yt-dlp format can ADVERTISE audio yet deliver
  // a video-only file, and nothing downstream flags the silent data loss until
  // audio matching refuses the clip. Best-effort (probeSafe = no ffprobe, no
  // check) and media-only — transcript/thumb fetches aren't AV containers.
  const audioWarning = (reportedKind ?? "media") === "media"
    ? noAudioStreamWarning(await probeSafe(path))
    : undefined;
  const providerWarning = typeof extra.warning === "string" && extra.warning.trim()
    ? extra.warning.trim()
    : undefined;
  const warning = audioWarning
    ? `${providerWarning ? `${providerWarning}; ` : ""}${audioWarning}`
    : providerWarning;
  return makeRecord({
    verb: "capture",
    format: "json",
    payload: {
      ...extra,
      capture_id: "cap_" + Math.abs(hashString(path)).toString(16),
      ...(warning ? { warning } : {}),
      ...(audioWarning ? { has_audio: false } : {}),
      path,
      kind: reportedKind ?? "media",
      source: desc.type,
      url: opts.url,
    },
    media: { ref: path },
    // meta.has_audio is the cross-verb machine-readable location (same as
    // watch); payload.has_audio stays for capture-record compatibility.
    meta: { provider: `source:${desc.type}`, ...(audioWarning ? { has_audio: false } : {}) },
    state: "ready",
  });
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
