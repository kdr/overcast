// Resolve a path to a shipped resource (examples/, skills/, ...) relative to the
// package root. tsup bundles the source tree, so import.meta.url's depth isn't
// fixed — we walk up to the dir that contains the resource. Returns undefined in
// a bun-compiled binary (virtual /$bunfs) where these trees aren't embedded.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export function shippedPath(...segments: string[]): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    if (dir.includes("$bunfs") || dir === "/") {
      // compiled bun binary: the source tree isn't embedded, but the bun-sidecar
      // ships these resources next to the executable.
      const beside = join(dirname(process.execPath), ...segments);
      return existsSync(beside) ? beside : undefined;
    }
    for (let i = 0; i < 8; i++) {
      const p = join(dir, ...segments);
      if (existsSync(p)) return p;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
