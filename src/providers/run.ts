// Generic exec-provider runner. A custom (non-default) provider already emits a
// full record on stdout (the exec wire contract), so overcast maps it to the
// loose record by PASS-THROUGH at this boundary — filling only id/verb/media
// defaults. The tinycloud defaults have their own envelope→record mappers
// (providers/tinycloud/*) because they emit tinycloud envelopes, not records.

import { makeRecord, type OvercastRecord } from "../record.js";
import { execCapture, renderCommand, parseFirstJson } from "./exec.js";

/** Does a run template look like the default tinycloud binding? */
export function isTinycloudDefault(run?: string): boolean {
  return !!run && /^\s*tinycloud\b/.test(run);
}

export interface RunExecOpts {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Run a bound exec provider and return its emitted record (pass-through). The
 * provider's own `state`/`error`/`meta` are authoritative. A non-zero exit with
 * no parseable record yields an error record.
 */
export async function runExecProvider(
  verb: string,
  runTemplate: string,
  input: string,
  opts: RunExecOpts = {},
): Promise<OvercastRecord> {
  // ensure the input reaches the provider even if the template omits {{input}}
  const template = runTemplate.includes("{{input}}")
    ? runTemplate
    : `${runTemplate} {{input}}`;
  const argv = renderCommand(template, { input });
  const [cmd, ...args] = argv;

  const res = await execCapture(cmd, args, {
    env: opts.env,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
  });

  const parsed = parseFirstJson(res.stdout) as Record<string, unknown> | undefined;
  if (parsed === undefined) {
    return makeRecord({
      verb,
      format: "json",
      payload: { input },
      media: { ref: input },
      meta: { provider: `exec:${cmd}` },
      error:
        res.code === 0
          ? `provider produced no JSON record`
          : `provider exited ${res.code}: ${res.stderr.trim().slice(0, 400)}`,
      state: "error",
    });
  }

  // pass-through: honor the provider's record, fill required defaults.
  return makeRecord({
    verb: typeof parsed.verb === "string" ? parsed.verb : verb,
    format: (parsed.format as "json" | "md" | "txt") ?? "json",
    payload: (parsed.payload as Record<string, unknown> | string) ?? {},
    media:
      (parsed.media as { ref: string; at?: number | [number, number] }) ??
      { ref: input },
    meta: { provider: `exec:${cmd}`, ...((parsed.meta as Record<string, unknown>) ?? {}) },
    error: (parsed.error as string) ?? (res.code === 0 ? undefined : `exit ${res.code}`),
    state: (parsed.state as string) ?? (res.code === 0 ? "ready" : "error"),
  });
}
