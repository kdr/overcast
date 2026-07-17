#!/usr/bin/env node
// Single-source the overcast version. package.json is the source of truth; this
// propagates its version into the places that hard-code it:
//   - src/version.ts                  (OVERCAST_VERSION)
//   - .claude-plugin/plugin.json      (.version)
//   - .claude-plugin/marketplace.json (.metadata.version + every .plugins[].version)
//   - vscode/package.json             (.version — the .vsix rides the release train)
//   - vscode/package-lock.json        (.version + .packages[""].version)
// scripts/bun-sidecar.mjs reads package.json directly, so it needs no syncing.
//
// Usage:
//   node scripts/sync-version.mjs           # rewrite the files to match package.json
//   node scripts/sync-version.mjs --check   # exit 1 if anything is out of sync (CI guard)
//
// Wired to the `version` npm lifecycle, so `npm version <x>` keeps every surface
// in lockstep and stages the result into the version commit.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
if (!VERSION) {
  console.error("[sync-version] package.json has no version");
  process.exit(1);
}

const drift = [];

// 1) src/version.ts — the OVERCAST_VERSION literal.
const versionTsPath = join(ROOT, "src", "version.ts");
const versionTs = readFileSync(versionTsPath, "utf8");
const VERSION_RE = /(export const OVERCAST_VERSION = ")([^"]*)(";)/;
const m = versionTs.match(VERSION_RE);
if (!m) {
  console.error("[sync-version] could not find OVERCAST_VERSION in src/version.ts");
  process.exit(1);
}
if (m[2] !== VERSION) {
  drift.push(`src/version.ts (OVERCAST_VERSION=${m[2]})`);
  if (!CHECK) writeFileSync(versionTsPath, versionTs.replace(VERSION_RE, `$1${VERSION}$3`));
}

// 2) + 3) the .claude-plugin manifests — JSON we rewrite while preserving 2-space
// indent + trailing newline (matches the committed files).
const writeJson = (relPath, obj) =>
  writeFileSync(join(ROOT, relPath), JSON.stringify(obj, null, 2) + "\n");

// plugin.json — top-level .version
const pluginPath = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(join(ROOT, pluginPath), "utf8"));
if (plugin.version !== VERSION) {
  drift.push(`${pluginPath} (.version=${plugin.version})`);
  plugin.version = VERSION;
  if (!CHECK) writeJson(pluginPath, plugin);
}

// marketplace.json — .metadata.version + every .plugins[].version
const mktPath = ".claude-plugin/marketplace.json";
const mkt = JSON.parse(readFileSync(join(ROOT, mktPath), "utf8"));
let mktDirty = false;
if (mkt.metadata?.version !== VERSION) {
  drift.push(`${mktPath} (.metadata.version=${mkt.metadata?.version})`);
  (mkt.metadata ??= {}).version = VERSION;
  mktDirty = true;
}
for (const p of mkt.plugins ?? []) {
  if (p.version !== VERSION) {
    drift.push(`${mktPath} (.plugins[name=${p.name}].version=${p.version})`);
    p.version = VERSION;
    mktDirty = true;
  }
}
if (mktDirty && !CHECK) writeJson(mktPath, mkt);

// 4) vscode/package.json + its lockfile — the VS Code extension version tracks
// the root release so the .vsix attached to a GitHub Release matches the tag.
// Surgical string replace (NOT parse + re-stringify): the manifest's compact
// hand-formatting must survive the sync.
const replaceVersions = (relPath, re, expectedSites) => {
  const path = join(ROOT, relPath);
  const text = readFileSync(path, "utf8");
  let sites = 0;
  const next = text.replace(re, (whole, pre, current, post) => {
    sites += 1;
    if (current === VERSION) return whole;
    drift.push(`${relPath} (version=${current})`);
    return `${pre}${VERSION}${post}`;
  });
  // A silent zero-match would let --check pass while the .vsix version
  // diverges — fail loudly like the OVERCAST_VERSION path does.
  if (sites !== expectedSites) {
    console.error(
      `[sync-version] expected ${expectedSites} version site(s) in ${relPath}, matched ${sites} — the file's formatting drifted from the sync regex`
    );
    process.exit(1);
  }
  if (next !== text && !CHECK) writeFileSync(path, next);
};
// The manifest's own top-level version (2-space indent, so nested "version"
// keys — e.g. inside contributes — can't match).
replaceVersions("vscode/package.json", /^(  "version": ")([^"]*)(")/m, 1);
// The lockfile stamps the package version twice: at the top level and in the
// root "" packages entry — both directly follow the package name.
replaceVersions(
  "vscode/package-lock.json",
  /("name": "overcast-vscode",\n\s*"version": ")([^"]*)(")/g,
  2
);

if (CHECK) {
  if (drift.length) {
    console.error(`[sync-version] OUT OF SYNC with package.json (${VERSION}):`);
    for (const d of drift) console.error(`  - ${d}`);
    console.error("Run `npm run sync-version` (or `npm version <x>`) to fix.");
    process.exit(1);
  }
  console.error(`[sync-version] all surfaces match package.json (${VERSION})`);
} else if (drift.length) {
  console.error(`[sync-version] synced ${drift.length} file(s) to ${VERSION}:`);
  for (const d of drift) console.error(`  - ${d}`);
} else {
  console.error(`[sync-version] already at ${VERSION}; nothing to do`);
}
