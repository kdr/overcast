// Locate the built situation console (web/situation → vite build →
// assets/situation-console). Same resolution as the chair console: repo/package
// walk-up in dev + npm installs, "beside the executable" for the bun binary
// (copied there by scripts/bun-sidecar.mjs). When absent the server 404s the
// root (there is no inline fallback — the situation page is all rendering, so a
// degraded page would be an empty shell; run `npm run build:web`).

import { shippedPath } from "../pkg.js";

export function situationConsoleDir(): string | undefined {
  return shippedPath("assets", "situation-console");
}
