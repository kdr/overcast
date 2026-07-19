// Situation control plane = two small files under .overcast/situation/, in the
// same file-based style as seen.json / sources.json — because the serving
// process (a terminal pane or the TUI extension) and the controllers (the
// `situation set|stop|status` verb run by the CLI, the agent tool, or the chair
// via the agent) are DIFFERENT processes:
//
//   runtime.json — written by the server on start, removed on exit. Discovery:
//     "is a situation live, where". Never contains the pairing token (the token
//     lives only in the terminal QR / pairing URL).
//   control.json — written by `situation set` / `situation stop` (atomic
//     replace, merging any not-yet-consumed control), consumed by the server on
//     its next poll tick (~2s). `stop: true` shuts the server down gracefully.

import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "../fs-atomic.js";
import type { Case } from "../case.js";
import type { HtmlTheme } from "../report/html.js";
import { SITUATION_PANELS, type SituationPanel } from "./wire.js";

/** The runtime view config — CLI flags at start, mutated by `situation set`. */
export interface SituationConfig {
  panels?: SituationPanel[];
  /** restrict to source ids/types (comma list, like scan --source) */
  source?: string;
  since?: string;
  limit?: number;
  theme?: HtmlTheme;
  /** ad-hoc monitor query (only used when the server owns the --every cadence) */
  query?: string;
}

/** Config keys `situation set --clear` may drop from a running server's view
 *  config (back to default/auto). Kept as a value so the verb can validate. */
export const CLEARABLE_CONFIG_KEYS = ["panels", "source", "since", "limit", "theme", "query"] as const;
export type ClearableConfigKey = (typeof CLEARABLE_CONFIG_KEYS)[number];

export interface SituationControl extends SituationConfig {
  stop?: boolean;
  /** keys to DROP from the live view config (applied before any assignments in
   *  the same control) — the only way to remove a filter without a restart. */
  clear?: ClearableConfigKey[];
}

export interface SituationRuntime {
  pid: number;
  port: number;
  bind: string;
  url: string;
  displayUrl: string;
  startedAt: string;
  caseDir: string;
  every: string | null;
  mode: "cli" | "tui";
}

export function situationDir(c: Case): string {
  return join(c.storeDir, "situation");
}

export function runtimeFile(c: Case): string {
  return join(situationDir(c), "runtime.json");
}

export function controlFile(c: Case): string {
  return join(situationDir(c), "control.json");
}

export function readRuntime(c: Case): SituationRuntime | undefined {
  try {
    return JSON.parse(readFileSync(runtimeFile(c), "utf8")) as SituationRuntime;
  } catch {
    return undefined;
  }
}

export function writeRuntime(c: Case, rt: SituationRuntime): void {
  mkdirSync(situationDir(c), { recursive: true });
  writeFileAtomic(runtimeFile(c), JSON.stringify(rt, null, 2) + "\n");
}

export function clearRuntime(c: Case): void {
  rmSync(runtimeFile(c), { force: true });
}

/** Whether the runtime's pid is alive (signal 0 probe). A stale runtime.json
 *  (crash / kill -9) reads as not running so a new serve can start. Cheap +
 *  sync — used by the read-only display paths (status/glance). NOTE: a reused
 *  pid after a crash can false-positive; the DANGEROUS paths (refusing a new
 *  serve, stop --force) additionally require `runtimeServing` below. */
export function runtimeAlive(rt: SituationRuntime | undefined): boolean {
  if (!rt || !Number.isInteger(rt.pid) || rt.pid <= 0) return false;
  try {
    process.kill(rt.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Confirm SOMETHING is actually listening on the runtime's bound port (Bugbot
 *  #98/med: a crash + pid reuse makes runtimeAlive false-positive on an unrelated
 *  process). pid-alive AND port-listening is a strong "our server is up" signal —
 *  used before refusing a new serve or SIGTERM-ing on stop --force, so neither
 *  acts on a reused pid. Best-effort TCP connect with a short timeout. */
export function runtimeServing(rt: SituationRuntime | undefined, timeoutMs = 400): Promise<boolean> {
  if (!runtimeAlive(rt) || !rt || !Number.isInteger(rt.port) || rt.port <= 0) return Promise.resolve(false);
  const host = rt.bind === "0.0.0.0" || rt.bind === "::" ? "127.0.0.1" : rt.bind || "127.0.0.1";
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already closed */
      }
      resolvePromise(v);
    };
    const sock = connect({ host, port: rt.port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** In-process situation seam: when the TUI extension runs the server INSIDE
 *  the session process (`/situation on`), it registers the bound case dir here
 *  so the verb's status/set/stop — the agent tool and slash run in this same
 *  process — steer the case the live page actually polls, even while a session
 *  case switch hasn't rebound it yet (Bugbot #98/med). Cross-process callers
 *  (a CLI `situation stop` in another terminal) never see this seam; their
 *  discovery stays runtime.json. */
let inprocBoundCaseDir: (() => string | undefined) | undefined;

export function registerInProcessSituation(getter: (() => string | undefined) | undefined): void {
  inprocBoundCaseDir = getter;
}

export function inProcessSituationCaseDir(): string | undefined {
  return inprocBoundCaseDir?.();
}

/** Parse + validate a comma list of panel names. Returns undefined for empty
 *  input; throws on an unknown panel so callers surface a usable error. */
export function parsePanels(raw: string | undefined): SituationPanel[] | undefined {
  const items = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!items.length) return undefined;
  for (const p of items) {
    if (!(SITUATION_PANELS as readonly string[]).includes(p)) {
      throw new Error(`unknown panel '${p}' (expected ${SITUATION_PANELS.join(" | ")})`);
    }
  }
  return [...new Set(items)] as SituationPanel[];
}

/** Merge a control patch onto any pending (unconsumed) control and write it
 *  atomically. Two quick `situation set`s compose instead of clobbering. Clears
 *  compose by ORDER: a clear in the patch drops the key from pending (so the
 *  clear wins), and an assignment in the patch drops the key from pending.clear
 *  (so the re-set wins) — the server can then apply clears before assignments
 *  without reordering the operator's intent. */
export function writeControl(c: Case, patch: SituationControl): SituationControl {
  const pending: SituationControl = { ...(readControl(c) ?? {}) };
  if (patch.clear?.length) for (const key of patch.clear) delete pending[key];
  if (pending.clear?.length) {
    const kept = pending.clear.filter((key) => patch[key] === undefined);
    if (kept.length) pending.clear = kept;
    else delete pending.clear;
  }
  const merged: SituationControl = { ...pending, ...patch };
  if (pending.clear?.length && patch.clear?.length) merged.clear = [...new Set([...pending.clear, ...patch.clear])];
  mkdirSync(situationDir(c), { recursive: true });
  writeFileAtomic(controlFile(c), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function readControl(c: Case): SituationControl | undefined {
  try {
    // A plain read is safe: writeControl publishes through an atomic rename, so
    // a reader sees a whole control or none — never a half-written one. This is
    // a non-destructive PEEK (the verb's pending display, the extension's stop
    // check); the server's apply path uses takeControl below, which claims the
    // file instead of reading it.
    return JSON.parse(readFileSync(controlFile(c), "utf8")) as SituationControl;
  } catch {
    return undefined;
  }
}

/** TAKE the pending control: claim it and return it in ONE atomic step.
 *
 *  The old read → apply → `statSync` → `rmSync` shape could not be made safe. A
 *  `situation set`/`stop` landing between the mtime check and the unlink was
 *  deleted having never been applied — the operator's command vanished with no
 *  error, which is the worst failure mode this control plane has. Narrowing the
 *  window (dropping the existsSync, pairing mtime+body off one descriptor) makes
 *  it rarer, not correct.
 *
 *  `rename(2)` is atomic: this either moves the current control.json aside or
 *  fails because there is nothing pending. A writer that lands a microsecond
 *  later publishes a NEW control.json (writeControl is itself an atomic rename),
 *  which the next tick takes. No update can be consumed unseen.
 *
 *  Trade-off, deliberately: a crash between the take and applyConfig loses that
 *  one control instead of replaying it. Apply is an in-memory call on the very
 *  next line, so that window is negligible — and losing a control to a crash is
 *  strictly better than deleting a live one the server never looked at. */
export function takeControl(c: Case): SituationControl | undefined {
  const file = controlFile(c);
  const taken = `${file}.taken`;
  try {
    renameSync(file, taken); // atomic claim; ENOENT = nothing pending
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(taken, "utf8")) as SituationControl;
  } catch {
    return undefined; // corrupt/truncated — dropped along with the file
  } finally {
    // a crash before this leaves one stale .taken; the next rename replaces it
    rmSync(taken, { force: true });
  }
}

/** Before a FRESH serve binds, drop a stale `stop: true` still sitting in
 *  control.json (Bugbot #98/high): it's left over from an earlier `situation
 *  stop` whose server died before its poll tick consumed it, and would instantly
 *  kill the new server on its first control tick. The stop key is removed; any
 *  set-before-start config is preserved (deleting the file only if nothing else
 *  remains). */
export function clearStaleStop(c: Case): void {
  const cur = readControl(c);
  if (!cur || cur.stop !== true) return;
  const { stop: _stop, ...rest } = cur;
  try {
    if (Object.keys(rest).length === 0) rmSync(controlFile(c), { force: true });
    else writeFileAtomic(controlFile(c), JSON.stringify(rest, null, 2) + "\n");
  } catch {
    /* best-effort; the server also ignores a stop it can't attribute */
  }
}
