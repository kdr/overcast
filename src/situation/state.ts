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

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

export interface SituationControl extends SituationConfig {
  stop?: boolean;
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
 *  atomically. Two quick `situation set`s compose instead of clobbering. */
export function writeControl(c: Case, patch: SituationControl): SituationControl {
  const pending = readControl(c)?.control ?? {};
  const merged: SituationControl = { ...pending, ...patch };
  mkdirSync(situationDir(c), { recursive: true });
  writeFileAtomic(controlFile(c), JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function readControl(c: Case): { control: SituationControl; mtimeMs: number } | undefined {
  const file = controlFile(c);
  try {
    if (!existsSync(file)) return undefined;
    const mtimeMs = statSync(file).mtimeMs;
    return { control: JSON.parse(readFileSync(file, "utf8")) as SituationControl, mtimeMs };
  } catch {
    return undefined;
  }
}

/** Consume (delete) the control file the server just applied — but only when
 *  its mtime still matches what was read, so a `situation set` racing the
 *  consume isn't silently dropped (it survives to the next tick). */
export function consumeControl(c: Case, mtimeMs: number): void {
  const file = controlFile(c);
  try {
    if (existsSync(file) && statSync(file).mtimeMs === mtimeMs) rmSync(file, { force: true });
  } catch {
    /* another writer landed mid-consume — leave it for the next tick */
  }
}
