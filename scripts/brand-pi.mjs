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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const BRAND = "overcast";
const PI_PKG = "@earendil-works/pi-coding-agent";
const PI_SEGMENTS = PI_PKG.split("/"); // ["@earendil-works", "pi-coding-agent"]

// Walk up the directory tree from `startDir`; at each level probe
// node_modules/<PI_PKG>/package.json as a RAW filesystem path. This deliberately
// avoids require.resolve("<PI_PKG>/package.json"), which throws
// ERR_PACKAGE_PATH_NOT_EXPORTED because pi's `exports` map only exposes ".".
// Covers both layouts npm produces: pi nested under overcast (standalone global
// install) and pi hoisted to a shared node_modules (installed alongside others).
function findUpNodeModules(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ...PI_SEGMENTS, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // hit the filesystem root
    dir = parent;
  }
}

// Belt-and-suspenders for symlinked layouts (e.g. pnpm): resolve pi's "." entry
// — which follows symlinks into the real store — then climb to the owning
// package root (the nearest package.json whose `name` is PI_PKG).
function findViaResolve() {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(PI_PKG));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (pkg.name === PI_PKG) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

function piPackageJsonPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return findUpNodeModules(here) ?? findViaResolve();
}

function main() {
  const pkgPath = piPackageJsonPath();
  if (!pkgPath || !existsSync(pkgPath)) {
    // pi not installed yet (e.g. running before deps) — nothing to brand.
    console.error("[brand-pi] pi-coding-agent not found; skipping rebrand");
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.piConfig = pkg.piConfig ?? {};
  if (pkg.piConfig.name === BRAND) {
    return; // already branded
  }
  pkg.piConfig.name = BRAND;
  // keep configDir as-is (".pi") so the agent home / sessions don't move.
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.error(`[brand-pi] set piConfig.name="${BRAND}" in ${pkgPath}`);
}

try {
  main();
} catch (err) {
  // Branding is purely cosmetic — a failure here (e.g. a read-only global
  // node_modules) must never abort `npm install`. Warn and exit 0.
  console.error(`[brand-pi] skipped (non-fatal): ${err?.message ?? err}`);
}
