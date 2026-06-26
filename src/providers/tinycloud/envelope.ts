// Shared tinycloud envelope → loose-record machinery (CLAUDE.md invariants #3/#9:
// call tinycloud only via its public CLI verbs; map its envelope to the loose
// record at THIS boundary). The newer face + collection verbs all emit the same
// JSON envelope contract, so the parse/state/error mapping lives here once
// instead of being re-derived per verb (the `watch`/`listen` mappers predate
// this helper and keep their own copies to stay a low-risk pi/upgrade surface).
//
// The tinycloud envelope (skills/tinycloud/reference/envelope.md):
//   { tinycloud, kind, status, result_id, source_id, ref, data, meta,
//     summary, next, error }
// `status` is authoritative; `data` holds the verb-specific payload. Statuses:
//   ready(0) pending(0) paused(0) needs_credentials(2) needs_upload(3)
//   needs_download(3) error(1)   — (exit codes in parens).

import { execCapture, parseFirstJson } from "../exec.js";
import { tokenizeCommand } from "../sources/index.js";
import type { RecordState } from "../../record.js";

/** The base tinycloud command (tokenized). Override the whole invocation with
 *  `OVERCAST_TINYCLOUD_CMD` (a path to a binary, or a wrapper like
 *  `"bash my-tinycloud.sh"`) — the same escape hatch as OVERCAST_SOURCE_<TYPE>_CMD,
 *  and what the offline tests/fixtures bind to. An explicit `override` (from a
 *  profile binding) wins over the env. */
export function tinycloudBase(override?: string): string[] {
  const raw =
    (override && override.trim()) ||
    (process.env.OVERCAST_TINYCLOUD_CMD || "").trim() ||
    "tinycloud";
  return tokenizeCommand(raw);
}

/** The top-level envelope object (defensive: a non-object parses to {}). */
export function envelopeOf(parsed: unknown): Record<string, unknown> {
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

/** The verb-specific payload: the envelope's `data`, tolerating a bare-data
 *  provider that returns the payload at the top level. */
export function envelopeData(parsed: unknown): Record<string, unknown> {
  const o = envelopeOf(parsed);
  if (o.data && typeof o.data === "object") return o.data as Record<string, unknown>;
  return o;
}

/** The first string-y status found across the envelope + data (envelope wins). */
function rawStatus(env: Record<string, unknown>, data: Record<string, unknown>): string {
  for (const v of [env.status, env.state, data.status, data.state]) {
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * Map tinycloud's authoritative envelope `status` (else the exit code) to an
 * overcast record state. Unknown async/transient statuses collapse to `pending`
 * (a recoverable, retry-on-next-pass gap, not a hard failure) so monitor/CLI
 * exit codes classify them correctly.
 */
export function mapTinycloudState(
  env: Record<string, unknown>,
  data: Record<string, unknown>,
  code: number | null,
): RecordState {
  const status = rawStatus(env, data);
  // The status is tinycloud's INTENT; the exit code is the actual OUTCOME. Map the
  // status, then reconcile with the exit code so a contradiction (ready/pending but
  // a failure exit) never reads as success — tinycloud maps ready AND pending to
  // exit 0, so a non-zero exit on either is the failure/cred-gap it signals.
  let mapped: RecordState | undefined;
  switch (status) {
    case "ready":
    case "completed":
    case "ok":
    case "success":
      mapped = "ready";
      break;
    case "pending":
    case "processing":
    case "running":
    case "queued":
    case "paused":
    case "needs_upload":
    case "needs_download":
      mapped = "pending";
      break;
    case "needs_credentials":
    case "needs_auth":
      return "needs_credentials";
    case "error":
    case "failed":
      return "error";
  }
  if (mapped === "ready" || mapped === "pending") {
    if (code === 2 || code === 13) return "needs_credentials";
    if (code === 3) return "pending"; // needs_upload / needs_download legitimately exit 3
    if (code != null && code !== 0) return "error";
    return mapped;
  }
  // An explicit but UNRECOGNIZED status is never trusted as success — a new/future
  // async state must not read as "ready" off a 0 exit. Treat a non-zero exit as
  // the failure (or cred gap) it signals, and exit 0 / no code as in-progress.
  if (status) {
    if (code === 2 || code === 13) return "needs_credentials";
    if (code != null && code !== 0) return "error";
    return "pending";
  }
  // No status at all: derive purely from the exit code. tinycloud uses 2 for a
  // cred gap; overcast's own exec contract uses 13 — accept both.
  if (code === 0) return "ready";
  if (code === 2 || code === 13) return "needs_credentials";
  if (code === 3) return "pending"; // needs_upload / needs_download
  return "error";
}

/** Extract a human error message from an envelope's `error` (string or
 *  `{code,message}` object) — across both the envelope and its data. */
export function tinycloudError(
  env: Record<string, unknown>,
  data: Record<string, unknown>,
): string | undefined {
  for (const e of [env.error, data.error]) {
    if (typeof e === "string" && e) return e;
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      const msg = (typeof o.message === "string" && o.message) || (typeof o.code === "string" && o.code);
      if (msg) return msg;
      try {
        return JSON.stringify(e);
      } catch {
        return "tinycloud error";
      }
    }
  }
  return undefined;
}

export interface RunTinycloudOpts {
  /** override the base command (tokenized) — else OVERCAST_TINYCLOUD_CMD / `tinycloud` */
  base?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface TinycloudOutcome {
  /** whole envelope object (top level) */
  env: Record<string, unknown>;
  /** the verb-specific data payload (envelope.data, else the envelope) */
  data: Record<string, unknown>;
  /** mapped overcast state */
  state: RecordState;
  /** extracted error message (set whenever state is "error"/cred-gap or an
   *  error envelope was present) */
  error?: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `tinycloud <subArgs…>` and return the parsed envelope + mapped state. The
 * single exec boundary for the face + collection verbs: a non-zero exit, an
 * unparseable stdout, or an error envelope all surface as a non-ready outcome
 * with a message (never a silent empty "ready").
 */
export async function runTinycloud(
  subArgs: string[],
  opts: RunTinycloudOpts = {},
): Promise<TinycloudOutcome> {
  const base = tinycloudBase(opts.base);
  const [cmd, ...lead] = base;
  if (!cmd) {
    return {
      env: {}, data: {}, state: "error", code: null, stdout: "", stderr: "",
      error: `empty tinycloud command (check OVERCAST_TINYCLOUD_CMD)`,
    };
  }
  const args = [...lead, ...subArgs];
  const res = await execCapture(cmd, args, {
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    env: opts.env,
    signal: opts.signal,
  });

  const parsed = parseFirstJson(res.stdout);
  if (parsed === undefined) {
    // No parseable JSON at all: surface the exit code. Exit 2/13 = cred gap.
    const credGap = res.code === 2 || res.code === 13;
    return {
      env: {}, data: {}, code: res.code, stdout: res.stdout, stderr: res.stderr,
      state: credGap ? "needs_credentials" : "error",
      error:
        res.code === 0
          ? "tinycloud produced no JSON output"
          : credGap
            ? "tinycloud needs credentials (set CLOUDGLUE_API_KEY or run `tinycloud setup cloudglue`)"
            : `tinycloud exited ${res.code}: ${res.stderr.trim().slice(0, 400)}`,
    };
  }

  const env = envelopeOf(parsed);
  const data = envelopeData(parsed);
  const envError = tinycloudError(env, data);
  // mapTinycloudState already reconciles the status with the exit code (a non-zero
  // exit on a ready/pending status → error/needs_credentials). Only the error
  // ENVELOPE (an `error` field on an exit-0 ready record) needs a final override.
  let state = mapTinycloudState(env, data, res.code);
  if (envError && state === "ready") state = "error";

  // Attach a message only for non-success states; ready/pending carry none.
  let error: string | undefined;
  if (state === "error") {
    error =
      envError ||
      (res.code !== 0
        ? `tinycloud exited ${res.code}: ${res.stderr.trim().slice(0, 400)}`
        : "tinycloud reported a failure");
  } else if (state === "needs_credentials") {
    error =
      envError ||
      "tinycloud needs credentials (set CLOUDGLUE_API_KEY or run `tinycloud setup cloudglue`)";
  }

  return { env, data, state, error, code: res.code, stdout: res.stdout, stderr: res.stderr };
}
