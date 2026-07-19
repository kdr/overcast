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

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

/** Serialize every MUTATION of the control file through an O_EXCL lock.
 *
 *  writeControl is a read-modify-write: it folds the operator's patch onto
 *  whatever is still pending. Two `situation set`s racing (the agent and a CLI
 *  in another terminal, say) could both read the same pending state and the
 *  slower publish would clobber the faster one — an operator command lost with
 *  no error, the exact failure this control plane is supposed to have stopped
 *  having. A take landing mid-RMW could likewise resurrect an applied control.
 *
 *  So the lock covers ALL of the mutators (write / take / clearStaleStop), not
 *  just the pair that happened to be reported. Held for microseconds around a
 *  small JSON file.
 *
 *  Never fails the caller: if the lock can't be acquired within the budget we
 *  proceed anyway. Dropping the operator's command to protect against a rare
 *  interleaving would be the worse trade. A lock left by a killed process is
 *  stolen once it goes stale. */
/** The control plane is an APPEND-ONLY PATCH DIRECTORY, not a shared mutable
 *  file, because every failure this thing has had came from the latter.
 *
 *  History, so the shape isn't re-litigated: control.json was one file that
 *  `situation set` read-modify-wrote and the server consumed. That needed a lock
 *  (concurrent sets clobbered each other), the lock needed a stale-steal (a
 *  crashed holder wedged it), the steal needed a deadline (it could spin), the
 *  server needed a NON-blocking acquire (waiting parked the event loop and
 *  stalled the live page), and the consume needed a restore path (a transient
 *  read error would destroy the operator's command) which itself could clobber a
 *  newer write. Each fix was correct and each exposed the next edge.
 *
 *  Writing one file per patch removes the shared mutable state instead:
 *    - no read-modify-write, so no lost update and no lock to hold, wait on,
 *      steal, or leave abandoned;
 *    - no waiting anywhere, so neither a CLI writer nor the in-process TUI
 *      writer can park the event loop that serves /media and SSE;
 *    - a patch that can't be read is simply left for the next tick — it is its
 *      own file, so there is no claim to restore and nothing to clobber.
 *  Merge order is filename order, which is write order. */
let patchSeq = 0;

function controlDir(c: Case): string {
  return join(situationDir(c), "control.d");
}

/** Fold one patch onto the pending state. Clears compose by ORDER: a clear in
 *  the patch drops the key from pending (the clear wins), and an assignment in
 *  the patch drops the key from pending.clear (the re-set wins) — so the server
 *  can apply clears before assignments without reordering operator intent. */
function foldControl(pending: SituationControl, patch: SituationControl): SituationControl {
  const next: SituationControl = { ...pending };
  if (patch.clear?.length) for (const key of patch.clear) delete next[key];
  if (next.clear?.length) {
    const kept = next.clear.filter((key) => patch[key] === undefined);
    if (kept.length) next.clear = kept;
    else delete next.clear;
  }
  const merged: SituationControl = { ...next, ...patch };
  if (next.clear?.length && patch.clear?.length) merged.clear = [...new Set([...next.clear, ...patch.clear])];
  return merged;
}

/** Pending patch files, oldest first. Includes a legacy single control.json
 *  written by an older process, folded as the OLDEST entry so an in-flight
 *  upgrade doesn't strand it. */
function pendingPatchFiles(c: Case): string[] {
  const out: string[] = [];
  const legacy = controlFile(c);
  try {
    statSync(legacy);
    out.push(legacy);
  } catch {
    /* none — the normal case */
  }
  try {
    out.push(...readdirSync(controlDir(c)).filter((f) => f.endsWith(".json")).sort().map((f) => join(controlDir(c), f)));
  } catch {
    /* directory absent = nothing pending */
  }
  return out;
}

/** Append ONE patch. No read-modify-write, so concurrent writers cannot lose
 *  each other's updates and nothing needs to be locked. Returns the resulting
 *  pending state for the caller's display. */
export function writeControl(c: Case, patch: SituationControl): SituationControl {
  mkdirSync(controlDir(c), { recursive: true });
  // Name sorts by write order. The millisecond alone is NOT enough — two sets
  // in the same tick would then be ordered by the random suffix, silently
  // inverting "a later clear beats an earlier assignment" — so a monotonic
  // per-process sequence breaks the tie. Across processes a same-millisecond
  // tie is arbitrary, which is honest: those writes are concurrent.
  const name = [
    String(Date.now()).padStart(15, "0"),
    String(++patchSeq).padStart(6, "0"),
    process.pid,
    randomBytes(4).toString("hex"),
  ].join("-") + ".json";
  writeFileAtomic(join(controlDir(c), name), JSON.stringify(patch, null, 2) + "\n");
  return readControl(c) ?? patch;
}

/** Non-destructive PEEK at the pending state (the verb's display, the
 *  extension's stop check). The server's apply path uses takeControl. */
export function readControl(c: Case): SituationControl | undefined {
  let pending: SituationControl | undefined;
  for (const file of pendingPatchFiles(c)) {
    try {
      pending = foldControl(pending ?? {}, JSON.parse(readFileSync(file, "utf8")) as SituationControl);
    } catch {
      /* unreadable or corrupt — takeControl decides its fate, a peek doesn't */
    }
  }
  return pending;
}

/** TAKE the pending control: fold every pending patch and remove the files that
 *  were consumed. Never blocks and never waits.
 *
 *  A patch is deleted only after it has been READ, so a transient IO error
 *  leaves it pending for the next tick rather than destroying the operator's
 *  command. A corrupt patch IS deleted — otherwise it would wedge the tick loop
 *  forever. A crash between read and delete replays that patch, which is
 *  harmless: applying a config patch twice is idempotent, and replaying beats
 *  dropping. */
export function takeControl(c: Case): SituationControl | undefined {
  let pending: SituationControl | undefined;
  for (const file of pendingPatchFiles(c)) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue; // transient — leave it for the next tick
    }
    try {
      pending = foldControl(pending ?? {}, JSON.parse(raw) as SituationControl);
    } catch {
      /* corrupt — fall through and delete so it can't block every future tick */
    }
    try {
      rmSync(file, { force: true });
    } catch {
      /* left behind; a re-read replays an idempotent patch */
    }
  }
  return pending;
}

/** Before a FRESH serve binds, drop a stale `stop: true` still pending: it's
 *  left over from an earlier `situation stop` whose server died before its poll
 *  tick consumed it, and would instantly kill the new server on its first
 *  control tick. The stop is removed; any set-before-start config is preserved.
 *
 *  Operates on exactly the files it READ, so a `situation set` landing
 *  concurrently is left untouched rather than swept up — the same rule the take
 *  follows. Runs once, before the server binds. */
export function clearStaleStop(c: Case): void {
  const files = pendingPatchFiles(c);
  let pending: SituationControl | undefined;
  for (const file of files) {
    try {
      pending = foldControl(pending ?? {}, JSON.parse(readFileSync(file, "utf8")) as SituationControl);
    } catch {
      /* unreadable/corrupt — leave it; the first take deals with it */
    }
  }
  if (!pending || pending.stop !== true) return;
  const { stop: _stop, ...rest } = pending;
  try {
    for (const file of files) rmSync(file, { force: true });
    if (Object.keys(rest).length > 0) writeControl(c, rest);
  } catch {
    /* best-effort; the server also ignores a stop it can't attribute */
  }
}
