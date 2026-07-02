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
  opts: { image?: boolean } = {},
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

/** The primary (most recent) target, used as the default scan/monitor seed. */
export function primaryTarget(c: Case): TargetEntry | undefined {
  const t = load(c).targets;
  return t[t.length - 1];
}
