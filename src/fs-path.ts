// Path helpers shared across the arg-construction boundaries.

import { homedir } from "node:os";
import { join } from "node:path";

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
