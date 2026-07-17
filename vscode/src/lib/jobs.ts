// PURE job-tracking helpers for the CliBridge run tracker + the Runs tree. NO
// vscode imports — exercised by node --test (see ../../test/jobs.test.ts). Job
// is the serializable snapshot the tracker exposes; the tracker keeps each
// running job's CancellationTokenSource out of band (see cliBridge.ts).
export type JobState = "running" | "ok" | "failed" | "cancelled";

export interface Job {
  /** monotonic tracker id (job-N). */
  id: string;
  /** args[0] — the overcast verb. */
  verb: string;
  /** short target: basename of a path 2nd positional, else the raw token. */
  target?: string;
  /** "verb target" — the Runs row label. */
  label: string;
  startedAt: number;
  endedAt?: number;
  state: JobState;
  /** failure message when state === "failed". */
  failure?: string;
  /** first result record id, for the Runs row deep-link. */
  recordId?: string;
}

const TARGET_MAX = 28;

/** Track every run EXCEPT the noisy store-poll reads (`case status`/`records`,
 *  `finding list`, `index list` — the model re-runs these on every store change)
 *  and the internal bootstrap reads (`--version` smoke-test, `commands` registry
 *  fetch); they'd flood the Runs view — and an internal read must not be
 *  user-killable. Mutating index actions (create/add/…) stay tracked. */
export function shouldTrackJob(args: string[]): boolean {
  const head = args[0];
  if (!head) return false;
  if (head === "index" && (args[1] === "list" || args[1] === undefined)) return false;
  return head !== "case" && head !== "finding" && head !== "--version" && head !== "commands";
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** verb = args[0]; target = a short label from the first token after it
 *  (basename when it's a path), skipped when that token is a flag. */
export function jobVerbTarget(args: string[]): { verb: string; target?: string } {
  const verb = args[0] ?? "";
  const second = args[1];
  if (!second || second.startsWith("-")) return { verb };
  let target = /[\\/]/.test(second) ? baseName(second) : second;
  if (target.length > TARGET_MAX) target = `${target.slice(0, TARGET_MAX - 1)}…`;
  return { verb, target };
}

/** "12s" / "1m 3s" — job duration/elapsed, rounded to whole seconds. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export function jobLabel(verb: string, target?: string): string {
  return target ? `${verb} ${target}` : verb;
}

/** Record id for the Runs row deep-link. Fan-out verbs (scan) can stream a
 *  failed source's error/credential row FIRST and the real hits after it —
 *  prefer the first usable result row over a blind records[0]: skip error /
 *  needs_credentials rows and scan pull-progress chatter, fall back to the
 *  first id at all so a fully-failed run still deep-links to its error record. */
export function jobRecordId(
  records: Array<{ id?: string; state?: string; payload?: unknown }>,
): string | undefined {
  for (const r of records) {
    if (!r.id) continue;
    if (r.state === "error" || r.state === "needs_credentials") continue;
    const op = (r.payload as { op?: unknown } | undefined)?.op;
    if (op === "pull_progress") continue;
    return r.id;
  }
  return records.find((r) => r.id)?.id;
}
