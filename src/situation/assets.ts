// Locate the built situation console (web/situation → vite build →
// assets/situation-console). Same resolution as the chair console: repo/package
// walk-up in dev + npm installs, "beside the executable" for the bun binary
// (copied there by scripts/bun-sidecar.mjs). When absent the server 404s the
// root (there is no inline fallback — the situation page is all rendering, so a
// degraded page would be an empty shell; run `npm run build:web`).

import { dirname } from "node:path";
import { shippedPath } from "../pkg.js";

export function situationConsoleDir(): string | undefined {
  // Resolve the console by its index.html SENTINEL, not just the directory:
  // shippedPath's walk-up returns the first ancestor that merely *contains* the
  // dir, so a stale/partial `assets/situation-console/` (e.g. a prior `build:bun`
  // sidecar copy left beside the node dev binary in dist/bin/, or an interrupted
  // vite build) would shadow the complete build and 404 the root. Testing
  // index.html makes the walk-up step past an incomplete copy to the real one.
  const index = shippedPath("assets", "situation-console", "index.html");
  return index ? dirname(index) : undefined;
}
