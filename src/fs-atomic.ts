// Atomic file write: write a temp file in the SAME directory, then rename over
// the target. rename(2) is atomic within a filesystem, so a concurrent reader
// sees either the old bytes or the new bytes — never a half-written file.
//
// overcast has no lock/permission layer and explicitly runs concurrent verb
// invocations (`scan --pull` fan-out, `monitor --every`, `/chair` driving a
// second session). The state stores (setup/seen/source/target/index) are
// full-file read-modify-writes; a plain writeFileSync can be observed mid-write
// (e.g. `loadSetup` catches the parse error and silently reverts bindings to
// defaults). This closes that torn-read window for the small JSON state files.

import { writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

export function writeFileAtomic(file: string, data: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup of the temp file */
    }
    throw err;
  }
}
