// Generic exec-provider runner. A custom (non-default) provider already emits a
// full record on stdout (the exec wire contract), so overcast maps it to the
// loose record by PASS-THROUGH at this boundary — filling only id/verb/media
// defaults. The tinycloud defaults have their own envelope→record mappers
// (providers/tinycloud/*) because they emit tinycloud envelopes, not records.

import { makeRecord, type OvercastRecord } from "../record.js";
import { execCapture, renderCommand, parseFirstJson } from "./exec.js";
import type { ProviderDescriptor } from "../profile.js";

/** Does a run template look like the default tinycloud binding? */
export function isTinycloudDefault(run?: string): boolean {
  return !!run && /^\s*tinycloud\b/.test(run);
}

/** A custom (non-default) provider binding we should dispatch to, rather than
 *  the built-in tinycloud mapper. */
export function isCustomBinding(b?: ProviderDescriptor): boolean {
  if (!b) return false;
  if (b.run && isTinycloudDefault(b.run)) return false;
  return Boolean(b.run || b.endpoint || b.module);
}

/**
 * Dispatch a bound provider by transport. v1 wires the `exec` transport; an
 * `http`/`inproc` binding returns an explicit error rather than silently
 * falling back to the tinycloud default (which would ignore the binding).
 */
export async function runBoundProvider(
  verb: string,
  binding: ProviderDescriptor,
  input: string,
  opts: RunExecOpts = {},
): Promise<OvercastRecord> {
  const isExec = binding.type === "exec" || (!!binding.run && !binding.endpoint && !binding.module);
  if (isExec) {
    if (!binding.run) {
      return makeRecord({
        verb, format: "json", payload: { input }, media: { ref: input },
        error: `exec provider for '${verb}' has no run command`, state: "error",
      });
    }
    return runExecProvider(verb, binding.run, input, opts);
  }
  const transport = binding.type ?? (binding.endpoint ? "http" : binding.module ? "inproc" : "unknown");
  return makeRecord({
    verb, format: "json", payload: { input }, media: { ref: input },
    meta: { provider: transport },
    error: `${transport} provider transport is not implemented in v1 (only exec is wired); bind an exec provider for '${verb}'`,
    state: "error",
  });
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

  // pass-through: honor the provider's record, fill required defaults. The
  // provider's `state` is authoritative (exec wire contract).
  const state = (parsed.state as string) ?? (res.code === 0 ? "ready" : "error");
  // only attach an exit-code error when the record isn't already a non-error
  // state — a non-zero exit on an explicit ready/pending/needs_credentials
  // record (e.g. a cred check that exits 13) is not a hard failure.
  const isErrorState = !["ready", "pending", "needs_credentials"].includes(state);
  const error =
    (typeof parsed.error === "string" ? parsed.error : undefined) ??
    (res.code !== 0 && isErrorState ? `exit ${res.code}` : undefined);
  // honor parsed.media only when it carries a string ref (MediaRef contract).
  const pm = parsed.media as { ref?: unknown; at?: number | [number, number] } | undefined;
  const media =
    pm && typeof pm.ref === "string"
      ? { ref: pm.ref, at: pm.at }
      : { ref: input };

  return makeRecord({
    verb: typeof parsed.verb === "string" ? parsed.verb : verb,
    format: (parsed.format as "json" | "md" | "txt") ?? "json",
    // a well-formed record carries `payload`; if a provider emitted a bare
    // object (e.g. an envelope) instead, keep its data rather than dropping it
    // to an empty payload.
    payload: (parsed.payload as Record<string, unknown> | string) ?? (parsed as Record<string, unknown>),
    media,
    meta: { provider: `exec:${cmd}`, ...((parsed.meta as Record<string, unknown>) ?? {}) },
    error,
    state,
  });
}
