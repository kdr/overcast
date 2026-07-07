// Path helpers shared across the arg-construction boundaries.

import { homedir } from "node:os";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";

/** True if `target` (which must already exist) resolves — THROUGH symlinks — to a
 *  path inside `root` (or root itself). Callers do the lexical + existence checks;
 *  this closes the symlink-escape hole a lexical `startsWith(root + sep)` misses
 *  (a symlink inside root pointing outside). Shared by the finding/note `--ref`
 *  guard and the chair static-file server so the two can't drift. */
export function realpathContained(root: string, target: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(target);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

/**
 * Expand a leading `~` / `~/` to the user's home directory. A shell normally does
 * this, but overcast's TUI + agent surface (and `parseVerbArgs`) receive arguments
 * literally — so `~/Downloads/clip.mov` would otherwise be treated as a relative
 * `~` directory and fail `existsSync` ("video not found"). Only the common `~` and
 * `~/…` forms are handled; URLs, absolute/relative paths, and `~user` (another
 * user's home — shell-specific) pass through unchanged.
 */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/** expandHome for a possibly-non-string arg/opt value (numbers/booleans/undefined
 *  pass through untouched). */
export function expandHomeArg<T>(value: T): T {
  return typeof value === "string" ? (expandHome(value) as unknown as T) : value;
}
