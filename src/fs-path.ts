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

/** Open `target` for reading and prove the OPEN DESCRIPTOR is the file that
 *  passed containment. `realpathContained` validates a path STRING; anything the
 *  caller then does with that string re-resolves it, so a symlink swapped in
 *  between lands on a different inode (TOCTOU) — the containment check says yes
 *  about one file while the server streams another.
 *
 *  Opening first and matching the resolved path's dev+ino against the
 *  descriptor's closes the window from both sides: a swap BEFORE the open is
 *  caught by containment (which now runs against the new resolved path), and a
 *  swap AFTER it by the inode mismatch. Everything downstream must use the fd,
 *  never the path — handing the path back would reopen the race.
 *
 *  Returns undefined for anything unreadable, not a regular file, or outside
 *  root. The caller owns closing the fd. */
export function openContainedFile(root: string, target: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(target, "r");
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("not a regular file");
    const realRoot = realpathSync(root);
    const real = realpathSync(target);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error("outside root");
    // Identity check only where inode identity is meaningful. POSIX dev+ino
    // uniquely names the file, so a mismatch proves a swap. Windows reports
    // these from a different source per call and can hand back 0 or a
    // disagreeing pair for an UNCHANGED file — enforcing it there would 404
    // every static asset and /media response. Fall back to the realpath
    // containment above, which is what this guarded before the fd was added.
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
