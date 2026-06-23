#!/usr/bin/env node
// Rebrand the pinned pi host as "overcast" using pi's own supported hook:
// `piConfig.name` in the @earendil-works/pi-coding-agent package.json. pi reads
// it as APP_NAME / APP_TITLE, so the tab title (π → overcast), the `/quit`
// description ("Quit overcast"), the startup logo, and update strings all
// rebrand — WITHOUT moving the agent home (we leave `configDir` = ".pi", so
// ~/.pi/agent sessions/auth are preserved). Idempotent; safe to re-run.
//
// Runs on `postinstall`. For the standalone bun binary, the same package.json
// must sit next to the executable (handled by the build:bun step).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const BRAND = "overcast";

function piPackageJsonPath() {
  // resolve the installed pi-coding-agent package.json
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@earendil-works/pi-coding-agent/package.json");
  } catch {
    // fall back to the conventional node_modules location
    const p = new URL(
      "../node_modules/@earendil-works/pi-coding-agent/package.json",
      import.meta.url,
    ).pathname;
    return existsSync(p) ? p : undefined;
  }
}

function main() {
  const path = piPackageJsonPath();
  if (!path || !existsSync(path)) {
    // pi not installed yet (e.g. running before deps) — nothing to brand.
    console.error("[brand-pi] pi-coding-agent not found; skipping rebrand");
    return;
  }
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.piConfig = pkg.piConfig ?? {};
  if (pkg.piConfig.name === BRAND) {
    return; // already branded
  }
  pkg.piConfig.name = BRAND;
  // keep configDir as-is (".pi") so the agent home / sessions don't move.
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.error(`[brand-pi] set piConfig.name="${BRAND}" in ${path}`);
}

main();
