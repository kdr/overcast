// Path helpers shared across the arg-construction boundaries.

import { homedir } from "node:os";
import { join, sep } from "node:path";
import { closeSync, fstatSync, openSync, realpathSync, statSync } from "node:fs";

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

/** Whether this platform's `dev`/`ino` pair is a trustworthy file identity.
 *  POSIX: yes. Windows: Node fills these from a different source per call and
 *  may report 0 or a disagreeing pair for the same unchanged file, so comparing
 *  them there produces false "swapped" verdicts rather than catching real ones. */
function inodeIdentityReliable(): boolean {
  return process.platform !== "win32";
}

/** Open `target` for reading and return a descriptor proven to be a file inside
 *  `root`. `realpathContained` validates a path STRING; anything the caller then
 *  does with that string re-resolves it, so a symlink swapped in between lands
 *  on a different inode (TOCTOU) — containment says yes about one file while the
 *  server streams another.
 *
 *  Two layers, because neither is sufficient alone:
 *
 *  1. Resolve FIRST, then open the RESOLVED path. `realpathSync` output contains
 *     no symlinks, so the open cannot be redirected by swapping the caller's
 *     path or any link along it. This is the layer that carries platforms where
 *     inode identity is unusable.
 *  2. On POSIX, confirm the descriptor is the file that path still names, via
 *     dev+ino. That catches a component swapped in the remaining window between
 *     the resolve and the open.
 *
 *  Windows is deliberately layer 1 only: Node fills dev/ino there from a
 *  different source per call and can report 0 or a disagreeing pair for an
 *  UNCHANGED file, so enforcing it would 404 every asset rather than catch
 *  anything. The residual exposure is a directory component replaced by a
 *  junction inside that narrow window, which needs write access within the root
 *  already — strictly better than the path-string check this replaced, and the
 *  best Node's API supports there.
 *
 *  Everything downstream must use the fd, never the path — handing the path back
 *  would reopen the race. Returns undefined for anything unreadable, not a
 *  regular file, or outside root. The caller owns closing the fd. */
export function openContainedFile(root: string, target: string): number | undefined {
  let fd: number | undefined;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(target);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
    fd = openSync(real, "r"); // the resolved path — no links left to swap
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("not a regular file");
    if (inodeIdentityReliable()) {
      const resolved = statSync(real);
      if (resolved.dev !== opened.dev || resolved.ino !== opened.ino) {
        throw new Error("path no longer resolves to the opened file");
      }
    }
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    return undefined;
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
