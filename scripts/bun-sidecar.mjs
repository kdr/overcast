#!/usr/bin/env node
// Post-build for the standalone bun binary. A `bun --compile` executable resolves
// pi's getPackageDir() to the EXECUTABLE's directory, so pi looks for two things
// next to dist/bin/overcast:
//   1. package.json  — read for piConfig.name (rebrands pi → "overcast")
//   2. theme/dark.json + theme/light.json — pi's BUILTIN themes; initTheme()
//      reads them on every TUI/headless launch and HARD-CRASHES if missing
//      (ENOENT … /theme/dark.json), which broke the binary's agent mode.
// We copy both here so the compiled binary is self-sufficient.
import { writeFileSync, mkdirSync, copyFileSync, existsSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Output dir defaults to dist/bin (the `build:bun` path); the release workflow
// passes a per-platform dir (e.g. dist/release/darwin-arm64) so each compiled
// binary gets its own sidecar tree to tar up.
const OUT = process.argv[2] || "dist/bin";
mkdirSync(OUT, { recursive: true });

// version tracks package.json (the source of truth; see scripts/sync-version.mjs)
const VERSION = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;

// 1) branding sidecar
writeFileSync(
  join(OUT, "package.json"),
  JSON.stringify(
    { name: "overcast", version: VERSION, type: "module", private: true, piConfig: { name: "overcast" } },
    null,
    2,
  ) + "\n",
);

// 2) pi's builtin theme JSONs → dist/bin/theme/
let copied = 0;
try {
  // pi's "exports" map blocks require.resolve of subpaths, so reference the
  // builtin theme dir directly under node_modules (build runs from repo root).
  const themeSrc = join(
    process.cwd(),
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme",
  );
  const themeDst = join(OUT, "theme");
  mkdirSync(themeDst, { recursive: true });
  for (const f of ["dark.json", "light.json", "theme-schema.json"]) {
    const src = join(themeSrc, f);
    if (existsSync(src)) {
      copyFileSync(src, join(themeDst, f));
      copied++;
    }
  }
} catch (e) {
  console.error(`[build:bun] WARNING: could not copy pi builtin themes (${e.message}); the binary's TUI may crash on launch`);
}

// 3) shipped provider scripts → dist/bin/providers/. The compiled binary
// can't read the bundled source tree (/$bunfs), so shippedProviderPath()/
// shippedSource() resolve these from beside the executable — needed for the
// builtin youtube/tiktok/web sources and the turnkey Hugging Face `see`.
let providers = 0;
try {
  const src = join(process.cwd(), "providers");
  if (existsSync(src)) {
    cpSync(src, join(OUT, "providers"), { recursive: true });
    providers = 1;
  }
} catch (e) {
  console.error(`[build:bun] WARNING: could not copy shipped providers (${e.message}); builtin sources won't resolve on the binary`);
}

// 4) branding audio (the sting) → dist/bin/assets/branding/, so shippedPath()
// resolves it beside the compiled binary like the provider scripts above.
let sting = 0;
try {
  const src = join(process.cwd(), "assets", "branding", "sting.m4a");
  if (existsSync(src)) {
    mkdirSync(join(OUT, "assets", "branding"), { recursive: true });
    copyFileSync(src, join(OUT, "assets", "branding", "sting.m4a"));
    sting = 1;
  }
} catch {
  /* cosmetic; the binary just stays quiet without it */
}

// 5) chair console (vite build output) → dist/bin/assets/chair-console/, so
// /chair serves the real SPA from beside the binary; without it the bridge
// falls back to its inline minimal page.
let chair = 0;
try {
  const src = join(process.cwd(), "assets", "chair-console");
  if (existsSync(src)) {
    cpSync(src, join(OUT, "assets", "chair-console"), { recursive: true });
    chair = 1;
  } else {
    console.error("[build:bun] WARNING: assets/chair-console missing (run `npm run build:web`); /chair will serve the fallback page");
  }
} catch (e) {
  console.error(`[build:bun] WARNING: could not copy chair console (${e.message}); /chair will serve the fallback page`);
}

// 6) situation console (vite build output) → dist/bin/assets/situation-console/,
// so `overcast situation` serves the live page from beside the binary; without
// it the server 404s the root (there is no inline fallback for this one).
let situation = 0;
try {
  const src = join(process.cwd(), "assets", "situation-console");
  if (existsSync(src)) {
    cpSync(src, join(OUT, "assets", "situation-console"), { recursive: true });
    situation = 1;
  } else {
    console.error("[build:bun] WARNING: assets/situation-console missing (run `npm run build:web`); `situation` will 404 its page");
  }
} catch (e) {
  console.error(`[build:bun] WARNING: could not copy situation console (${e.message}); \`situation\` will 404 its page`);
}

console.error(
  `[build:bun] wrote ${OUT}/package.json + ${copied} builtin theme file(s)` +
    `${providers ? " + shipped providers" : ""}${sting ? " + branding audio" : ""}${chair ? " + chair console" : ""}${situation ? " + situation console" : ""}`,
);
