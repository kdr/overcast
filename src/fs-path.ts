// Path helpers shared across the arg-construction boundaries.

import { homedir } from "node:os";
import { join, sep } from "node:path";
import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from "node:fs";

const { O_RDONLY, O_NOFOLLOW } = constants;

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
 *  Three layers, because each covers a hole the others leave:
 *
 *  1. Resolve FIRST, then open the RESOLVED path. `realpathSync` output contains
 *     no symlinks, so the open cannot be redirected by a link along the caller's
 *     path. Legitimate symlinked assets still work — they were resolved.
 *  2. Open with `O_NOFOLLOW`, so if the final component is REPLACED by a symlink
 *     in the window between the resolve and the open, the open fails outright.
 *     Without this the dev/ino check below cannot help: the open and the stat
 *     both follow the new link and agree on the escaped target, confirming only
 *     that the fd matches what the path names NOW — not that it is inside root.
 *  3. On POSIX, dev+ino between the descriptor and the path, which rejects an
 *     identity change landing between the open and the stat.
 *
 *  Windows gets layer 1 only: `O_NOFOLLOW` is not supported there, and Node
 *  fills dev/ino from a different source per call — it can report 0 or a
 *  disagreeing pair for an UNCHANGED file, so enforcing layer 3 would 404 every
 *  asset rather than catch anything.
 *
 *  Residual, documented rather than implied away: a DIRECTORY component of the
 *  resolved path swapped for a link inside the same window (O_NOFOLLOW only
 *  guards the final component), and a hard link or file substituted at the
 *  resolved path itself. Both require write access inside the root already,
 *  which is game over for a static asset dir regardless.
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
    // O_NOFOLLOW is POSIX-only; `?? 0` degrades to a plain read elsewhere
    fd = openSync(real, O_RDONLY | (O_NOFOLLOW ?? 0));
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
