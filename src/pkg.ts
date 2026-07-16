// Resolve a path to a shipped resource (providers/, skills/, ...) relative to the
// package root. tsup bundles the source tree, so import.meta.url's depth isn't
// fixed — we walk up to the dir that contains the resource. Returns undefined in
// a bun-compiled binary (virtual /$bunfs) where these trees aren't embedded.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";

/** Resolve a shipped provider script under the top-level `providers/` tree
 *  (sources/, senses/, engines/) — the ONE root for shipped provider code. */
export function shippedProviderPath(...segments: string[]): string | undefined {
  return shippedPath("providers", ...segments);
}

/** True when a `providers/` dir is the real, current shipped tree — i.e. it
 *  actually carries `provider.json` manifests (any `senses/<pkg>/provider.json`),
 *  not just scripts. Used to step past an incomplete/stale sidecar copy. */
function providersTreeHasManifest(providersDir: string): boolean {
  try {
    const senses = join(providersDir, "senses");
    for (const e of readdirSync(senses, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(senses, e.name, "provider.json"))) return true;
    }
  } catch {
    /* no senses/ dir → not the tree */
  }
  return false;
}

/** Resolve the shipped `providers/` ROOT directory (for the manifest scanner).
 *  The bare-directory walk-up can't use `shippedPath("providers")`: in dev the
 *  source dir `src/providers/` (no `senses/`) shadows the tree, and a stale
 *  `dist/bin/providers/` left by an old `build:bun` — scripts but NO manifests —
 *  can shadow the real tree when running the tsup `node dist/bin/overcast.js`
 *  (same shadow class as the situation-console fix). So we require the candidate
 *  to actually contain manifests, stepping past a scripts-only copy. In the bun
 *  binary the sidecar beside the executable IS the tree (its build copies the
 *  current manifests), so resolve there directly. */
export function shippedProvidersRoot(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    if (dir.includes("$bunfs") || dir === "/") {
      const beside = join(dirname(process.execPath), "providers");
      return existsSync(beside) ? beside : undefined;
    }
    for (let i = 0; i < 8; i++) {
      const cand = join(dir, "providers");
      if (providersTreeHasManifest(cand)) return cand;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
