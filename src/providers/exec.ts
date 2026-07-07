// exec transport (CLAUDE.md invariant #6, default): a provider is a command.
// We run it, capture stdout (records/JSONL) + stderr (logs), and map the result
// to the loose record at THIS boundary — provider envelopes never leak inward.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Default ceiling on captured stdout+stderr. Bounds memory for a verbose or
// hostile provider (yt-dlp, a scraped source, a runaway tinycloud) — invariant
// #10 treats provider output as untrusted, so an unbounded `stdout += …` is an
// attacker-reachable OOM. 64 MB matches the largest ffmpeg maxBuffer in the tree.
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** extra PATH dirs prepended (e.g. system ffmpeg) */
  extraPath?: string[];
  /** cap on captured stdout+stderr bytes (default 64 MB); over → kill + reject */
  maxBuffer?: number;
}

/**
 * Run a command, returning its captured streams. Never throws on a non-zero
 * exit — the record's state/error is authoritative (invariant #3/#6); the
 * caller decides. Throws only on spawn failure / timeout / abort.
 */
export function execCapture(
  command: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolveP, rejectP) => {
    const env = { ...(opts.env ?? process.env) };
    if (opts.extraPath && opts.extraPath.length) {
      const sep = process.platform === "win32" ? ";" : ":";
      const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
      env[key] = opts.extraPath.join(sep) + sep + (env[key] ?? "");
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env,
      signal: opts.signal,
      // ignore stdin so a child that reads stdin (e.g. some CLIs probing for
      // piped input) gets EOF immediately instead of blocking until timeout.
      // overcast providers receive input via argv ({{input}}), not stdin.
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Decode through StringDecoder so a multi-byte UTF-8 sequence split across a
    // chunk boundary isn't mangled into U+FFFD — chunk-independent `d.toString()`
    // silently corrupts non-ASCII transcripts / names inside JSON string values
    // (JSON.parse still succeeds, so it goes unnoticed).
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(() => rejectP(new Error(`command timed out after ${opts.timeoutMs}ms: ${command}`)));
      }, opts.timeoutMs);
    }

    const guard = (chunk: Buffer): boolean => {
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        child.kill("SIGKILL");
        done(() => rejectP(new Error(`command output exceeded ${maxBuffer} bytes: ${command}`)));
        return false;
      }
      return true;
    };
    child.stdout.on("data", (d) => guard(d) && (stdout += outDec.write(d)));
    child.stderr.on("data", (d) => guard(d) && (stderr += errDec.write(d)));
    child.on("error", (err) => done(() => rejectP(err)));
    child.on("close", (code) => {
      stdout += outDec.end();
      stderr += errDec.end();
      done(() => resolveP({ code, stdout, stderr }));
    });
  });
}

/**
 * Render a command template like `tinycloud watch {{input}} --json` into argv.
 * Only `{{input}}` is substituted (split-safe: the input becomes one argv token).
 * Returns [command, ...args].
 */
export function renderCommand(
  template: string,
  vars: Record<string, string>,
): string[] {
  const tokens = template.trim().split(/\s+/);
  const out: string[] = [];
  for (const tok of tokens) {
    const m = tok.match(/^\{\{(\w+)\}\}$/);
    if (m) {
      const key = m[1];
      // unknown placeholders render empty (and are dropped)
      if (key in vars && vars[key] !== "") out.push(vars[key]);
    } else {
      out.push(tok);
    }
  }
  return out;
}

/** Parse the first JSON value found in stdout (object or array). */
export function parseFirstJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  // Fast path: whole stdout is one JSON value.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fallback: scan line-by-line for the first parseable JSON line (JSONL).
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
      try {
        return JSON.parse(t);
      } catch {
        /* keep scanning */
      }
    }
  }
  return undefined;
}
