// Resolve a path to a shipped resource (providers/, skills/, ...) relative to the
// package root. tsup bundles the source tree, so import.meta.url's depth isn't
// fixed — we walk up to the dir that contains the resource. Returns undefined in
// a bun-compiled binary (virtual /$bunfs) where these trees aren't embedded.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/** Resolve a shipped provider script under the top-level `providers/` tree
 *  (sources/, senses/, engines/) — the ONE root for shipped provider code. */
export function shippedProviderPath(...segments: string[]): string | undefined {
  return shippedPath("providers", ...segments);
}

/** Resolve the shipped `providers/` ROOT directory (for the manifest scanner).
 *  The bare-directory walk-up can't use `shippedPath("providers")`: in dev the
 *  source dir `src/providers/` shadows the real top-level tree (both are named
 *  `providers`). `providers/senses/` exists ONLY in the shipped tree (src/providers
 *  has no senses/ subdir), so we key on it and take its parent — resolving to the
 *  real tree in dev and to `<execDir>/providers` in the bun sidecar. */
export function shippedProvidersRoot(): string | undefined {
  const senses = shippedPath("providers", "senses");
  return senses ? dirname(senses) : undefined;
}

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
