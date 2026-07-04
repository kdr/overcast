// target = the standing scope (what scan/monitor look for), persisted to
// .overcast/target.json. A target is a name, a free-text prompt, or a reference
// image/clip (image targets are matched via `face --match` / local visual indexes).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Case } from "../case.js";

export interface TargetEntry {
  id: string;
  kind: "name" | "prompt" | "image";
  value: string;
  created: string;
  /** what would resolve this line of investigation (analyst-authored) */
  question?: string;
  /** missing = active. "answered"/"dead-end" close the thread (scan/monitor
   *  stop seeding from it via primaryTarget). */
  status?: "active" | "answered" | "dead-end";
  status_note?: string;
  status_updated?: string;
}

/** Effective status of a target (missing = active). */
export function targetStatus(t: TargetEntry): "active" | "answered" | "dead-end" {
  return t.status ?? "active";
}

/** Whether a target line is closed (answered or dead-end). */
export function isTargetClosed(t: TargetEntry): boolean {
  return t.status === "answered" || t.status === "dead-end";
}

export interface TargetStore {
  targets: TargetEntry[];
}

function load(c: Case): TargetStore {
  if (!existsSync(c.targetFile)) return { targets: [] };
  try {
    return JSON.parse(readFileSync(c.targetFile, "utf8")) as TargetStore;
  } catch {
    return { targets: [] };
  }
}

function save(c: Case, store: TargetStore): void {
  mkdirSync(join(c.targetFile, ".."), { recursive: true });
  writeFileSync(c.targetFile, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function listTargets(c: Case): TargetEntry[] {
  return load(c).targets;
}

/** Add a target. `--image` paths are kind "image"; "@handle"/short → name; else prompt. */
export function addTarget(
  c: Case,
  value: string,
  opts: { image?: boolean; question?: string } = {},
): TargetEntry {
  const store = load(c);
  const kind: TargetEntry["kind"] = opts.image
    ? "image"
    : value.length <= 40 && !/\s/.test(value)
      ? "name"
      : "prompt";
  const entry: TargetEntry = {
    id: "tgt_" + randomBytes(3).toString("hex"),
    kind,
    value,
    created: new Date().toISOString(),
  };
  if (opts.question) entry.question = opts.question;
  store.targets.push(entry);
  save(c, store);
  return entry;
}

export function removeTarget(c: Case, id: string): boolean {
  const store = load(c);
  const before = store.targets.length;
  store.targets = store.targets.filter((t) => t.id !== id);
  save(c, store);
  return store.targets.length < before;
}

/** Set a target's investigation status ("active" reopens). Returns the updated
 *  entry, or undefined when the id is unknown. */
export function setTargetStatus(
  c: Case,
  id: string,
  status: "active" | "answered" | "dead-end",
  note?: string,
): TargetEntry | undefined {
  const store = load(c);
  const entry = store.targets.find((t) => t.id === id);
  if (!entry) return undefined;
  if (status === "active") {
    delete entry.status;
    delete entry.status_note;
  } else {
    entry.status = status;
    if (note) entry.status_note = note;
    else delete entry.status_note;
  }
  entry.status_updated = new Date().toISOString();
  save(c, store);
  return entry;
}

/** The primary (most recent OPEN) target, used as the default scan/monitor seed.
 *  Closed lines (answered/dead-end) are skipped so sweeps don't chase them; when
 *  EVERY line is closed there is no active target — returns undefined rather than
 *  a closed one, so a query-less source isn't seeded with a dead line's value
 *  (the same "closed lines stop seeding scans" invariant scanLocalCase /
 *  evaluateTriggers / autoSeeOpts enforce). */
export function primaryTarget(c: Case): TargetEntry | undefined {
  const t = load(c).targets;
  for (let i = t.length - 1; i >= 0; i--) {
    if (!isTargetClosed(t[i])) return t[i];
  }
  return undefined;
}
