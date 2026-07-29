// exec transport (CLAUDE.md invariant #6, default): a provider is a command.
// We run it, capture stdout (records/JSONL) + stderr (logs), and map the result
// to the loose record at THIS boundary — provider envelopes never leak inward.

import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** capture stdout via a temp FILE instead of a pipe. Some child runtimes
   *  (tinycloud's embedded bun) issue a final non-blocking stdout write and
   *  exit without draining it — a pipe then cuts the output at the 64 KiB pipe
   *  buffer (invalid JSON); a regular file always takes the whole write. */
  stdoutToFile?: boolean;
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

    // stdoutToFile: hand the child a real file for stdout. The fd is dup'd into
    // the child at spawn; the PARENT keeps its copy open for the whole run —
    // every later size check and the final read go through this ONE descriptor
    // (fstat/read on the fd, never a path re-resolve — the same TOCTOU
    // discipline as watch.ts's readCappedUtf8; CodeQL js/file-system-race).
    let outDir: string | undefined;
    if (opts.stdoutToFile) outDir = mkdtempSync(join(tmpdir(), "oc-exec-"));
    // w+ so the same descriptor the child writes is readable back
    const outFd = outDir !== undefined ? openSync(join(outDir, "stdout"), "w+") : undefined;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env,
      signal: opts.signal,
      // ignore stdin so a child that reads stdin (e.g. some CLIs probing for
      // piped input) gets EOF immediately instead of blocking until timeout.
      // overcast providers receive input via argv ({{input}}), not stdin.
      stdio: ["ignore", outFd ?? "pipe", "pipe"],
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
    let sizeTimer: NodeJS.Timeout | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (sizeTimer) clearInterval(sizeTimer);
      // Cleanup must never block the settle — a throwing rm here would leave the
      // promise hanging forever (Bugbot). fd first, then the dir (Windows can't
      // unlink an open file; on unix a killed child's dup keeps the data alive
      // until its descriptor closes and the unlink is still fine).
      if (outFd !== undefined) {
        try { closeSync(outFd); } catch { /* already closed */ }
      }
      if (outDir) {
        try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
      }
      fn();
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(() => rejectP(new Error(`command timed out after ${opts.timeoutMs}ms: ${command}`)));
      }, opts.timeoutMs);
    }

    const overflow = () => {
      child.kill("SIGKILL");
      done(() => rejectP(new Error(`command output exceeded ${maxBuffer} bytes: ${command}`)));
    };
    const guard = (chunk: Buffer): boolean => {
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        overflow();
        return false;
      }
      return true;
    };
    // file-mode stdout grows on DISK, not in parent memory, so the data-event
    // guard never sees it — poll the descriptor and kill an over-cap child
    // MID-RUN, like pipe mode does (Bugbot: deferred maxBuffer). 500ms bounds
    // the excursion; disk (unlike memory) survives half a second of overshoot.
    if (outFd !== undefined) {
      sizeTimer = setInterval(() => {
        try {
          if (bytes + fstatSync(outFd).size > maxBuffer) overflow();
        } catch { /* fd closed by a concurrent settle */ }
      }, 500);
      sizeTimer.unref?.();
    }
    child.stdout?.on("data", (d) => guard(d) && (stdout += outDec.write(d)));
    child.stderr?.on("data", (d) => guard(d) && (stderr += errDec.write(d)));
    child.on("error", (err) => done(() => rejectP(err)));
    child.on("close", (code) => {
      if (outFd !== undefined) {
        // file-mode stdout: enforce the ceiling, then read back — both through
        // the SAME descriptor the child wrote (no path re-resolution, no
        // check-then-use window). Whole-file decode, so no chunk-boundary
        // multi-byte concerns.
        try {
          const size = fstatSync(outFd).size;
          if (bytes + size > maxBuffer) {
            done(() => rejectP(new Error(`command output exceeded ${maxBuffer} bytes: ${command}`)));
            return;
          }
          const buf = Buffer.alloc(size);
          let read = 0;
          while (read < size) {
            const n = readSync(outFd, buf, read, size - read, read);
            if (n <= 0) break;
            read += n;
          }
          stdout = buf.subarray(0, read).toString("utf8");
        } catch {
          stdout = ""; // an already-settled path (timeout/abort) closed the fd
        }
      } else {
        stdout += outDec.end();
      }
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
