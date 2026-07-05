// Locate the built chair console (web/chair → vite build → assets/chair-console).
// Resolution mirrors the other shipped resources (skills/, examples/, the audio
// sting): repo/package walk-up in dev + npm installs, "beside the executable"
// for the bun binary (copied there by scripts/bun-sidecar.mjs). When absent the
// bridge serves its built-in minimal fallback page instead.

import { shippedPath } from "../pkg.js";

export function chairConsoleDir(): string | undefined {
  return shippedPath("assets", "chair-console");
}
