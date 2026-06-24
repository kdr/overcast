// exec transport (CLAUDE.md invariant #6, default): a provider is a command.
// We run it, capture stdout (records/JSONL) + stderr (logs), and map the result
// to the loose record at THIS boundary — provider envelopes never leak inward.

import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** extra PATH dirs prepended (e.g. system ffmpeg) */
  extraPath?: string[];
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

    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectP(new Error(`command timed out after ${opts.timeoutMs}ms: ${command}`));
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      rejectP(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveP({ code, stdout, stderr });
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
