// Locate the built chair console (web/chair → vite build → assets/chair-console).
// Resolution mirrors the other shipped resources (skills/, providers/, the audio
// sting): repo/package walk-up in dev + npm installs, "beside the executable"
// for the bun binary (copied there by scripts/bun-sidecar.mjs). When absent the
// bridge serves its built-in minimal fallback page instead.

import { dirname } from "node:path";
import { shippedPath } from "../pkg.js";

export function chairConsoleDir(): string | undefined {
  // Resolve by the index.html SENTINEL, not just the directory — same walk-up
  // shadowing trap as the situation console (see src/situation/assets.ts): a
  // stale/partial `assets/chair-console/` beside the dev binary would otherwise
  // win the walk-up and force the bridge onto its fallback page even when a
  // complete build exists further up the tree.
  const index = shippedPath("assets", "chair-console", "index.html");
  return index ? dirname(index) : undefined;
}
