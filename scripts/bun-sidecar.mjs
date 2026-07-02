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

// 3) example provider scripts → dist/bin/examples/providers/. The compiled binary
// can't read the bundled source tree (/$bunfs), so shippedPath()/shippedSource()
// resolve these from beside the executable — needed for the builtin youtube/tiktok/
// web sources and the turnkey Hugging Face `see`.
let providers = 0;
try {
  const src = join(process.cwd(), "examples", "providers");
  if (existsSync(src)) {
    cpSync(src, join(OUT, "examples", "providers"), { recursive: true });
    providers = 1;
  }
} catch (e) {
  console.error(`[build:bun] WARNING: could not copy example providers (${e.message}); builtin sources won't resolve on the binary`);
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

console.error(
  `[build:bun] wrote ${OUT}/package.json + ${copied} builtin theme file(s)` +
    `${providers ? " + example providers" : ""}${sting ? " + branding audio" : ""}`,
);
