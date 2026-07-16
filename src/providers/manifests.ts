// Runtime scanner for provider.json manifests. Discovers + validates manifests
// under the shipped `providers/` tree and the installed-package root
// (<home>/providers/<pkg>/), then materializes them into the shapes the rest of
// the code consumes: ProviderChoice[] (sense catalog), SourceDescriptor lookup
// (OSINT sources), the merged preset map, and host-routing entries.
//
// The shipped manifests are cached per-process; installed packages are scanned
// that repoints $OVERCAST_HOME re-scans); install/remove call
// invalidateManifestCache(). Choice materialization runs per call so
// `{{env:VAR|default}}` tokens reflect the current environment (parity with the
// old catalog.ts reading process.env.DETECT_PY per invocation).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { shippedProvidersRoot } from "../pkg.js";
import { resolveShippedRefToken } from "./shipped-ref.js";
import { installedProvidersRoot, isInstalledRef, resolveInstalledRefToken } from "./installed-ref.js";
import {
  type ProviderManifest,
  type SenseEntry,
  type SourceEntry,
  validateManifest,
} from "./manifest-schema.js";
import type { ProviderChoice } from "./catalog.js";
import type { ProviderDescriptor } from "../profile.js";
import type { SourceDescriptor } from "./sources/index.js";

export interface LoadedManifest {
  manifest: ProviderManifest;
  /** absolute directory containing this provider.json. */
  dir: string;
  origin: "shipped" | "installed";
  /** install-package name = origin dir name for installed; manifest.name otherwise. */
  pkg: string;
}

export { installedProvidersRoot };

let shippedCache: { root: string; loaded: LoadedManifest[] } | undefined;

export function invalidateManifestCache(): void {
  shippedCache = undefined;
}

function scanRootFor(dir: string, origin: "shipped" | "installed", depth: number, out: LoadedManifest[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const manifestPath = join(dir, "provider.json");
  if (entries.some((e) => e.isFile() && e.name === "provider.json")) {
    loadOne(manifestPath, dir, origin, out);
    // a package directory is a leaf — don't descend into a package's own subdirs
    // looking for more manifests.
    return;
  }
  if (depth <= 0) return;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith(".")) {
      scanRootFor(join(dir, e.name), origin, depth - 1, out);
    }
  }
}

function loadOne(manifestPath: string, dir: string, origin: "shipped" | "installed", out: LoadedManifest[]): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return; // unreadable/invalid JSON → skip (doctor reports installed packages separately)
  }
  const res = validateManifest(raw, { installed: origin === "installed" });
  if (!res.ok) return; // invalid → skip; CI test asserts shipped manifests validate
  const manifest = raw as ProviderManifest;
  // installed package identity = its directory name (the `installed:<pkg>/…`
  // namespace); shipped identity = the manifest's declared name.
  const pkg = origin === "installed" ? basename(dir) : manifest.name;
  out.push({ manifest, dir, origin, pkg });
}

/** Discover + validate all manifests. Cached; sorted deterministically (shipped
 *  before installed, then by package name) so choice/source ordering is stable. */
export function scanManifests(home?: string): LoadedManifest[] {
  const shippedRoot = shippedProvidersRoot();
  // The shipped tree is immutable for the process, so cache it. Installed packages
  // change on disk (install/remove/manual edits), so scan them FRESH every call —
  // the catalog, builtinDescriptor, and collision/doctor helpers never serve a
  // stale installed manifest. invalidateManifestCache() only resets the shipped
  // cache (rarely needed).
  let shipped: LoadedManifest[];
  if (shippedCache && shippedCache.root === (shippedRoot ?? "")) {
    shipped = shippedCache.loaded;
  } else {
    shipped = [];
    if (shippedRoot) scanRootFor(shippedRoot, "shipped", 4, shipped);
    shippedCache = { root: shippedRoot ?? "", loaded: shipped };
  }

  const installed: LoadedManifest[] = [];
  const installedRoot = installedProvidersRoot(home);
  if (existsSync(installedRoot)) {
    for (const e of safeReaddir(installedRoot)) {
      if (e.startsWith(".")) continue;
      const pkgDir = join(installedRoot, e);
      try {
        if (!statSync(pkgDir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(pkgDir, "provider.json"))) loadOne(join(pkgDir, "provider.json"), pkgDir, "installed", installed);
    }
  }

  const loaded = [...shipped, ...installed];
  loaded.sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === "shipped" ? -1 : 1;
    return a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0;
  });
  return loaded;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Expand `{{env:VAR|default}}` tokens (|| semantics, matching the old
 *  `process.env.DETECT_PY || "python3"`). `{{input}}` is left for run.ts. */
function expandEnvTemplate(cmd: string): string {
  return cmd.replace(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)(?:\|([^}]*))?\}\}/g, (_m, name: string, def?: string) => {
    return process.env[name] || def || "";
  });
}

/** Sense manifest entries → ProviderChoice[] (env-expanded, per call). */
export function manifestChoices(home?: string): ProviderChoice[] {
  const choices: ProviderChoice[] = [];
  for (const lm of scanManifests(home)) {
    for (const entry of lm.manifest.entries) {
      if (entry.kind !== "sense") continue;
      choices.push(senseChoice(entry));
    }
  }
  return choices;
}

function senseChoice(entry: SenseEntry): ProviderChoice {
  const d = entry.descriptor;
  const descriptor: ProviderDescriptor = {
    type: "exec",
    run: expandEnvTemplate(d.run),
    init: d.init ? { command: expandEnvTemplate(d.init) } : undefined,
    describe: d.describe ? expandEnvTemplate(d.describe) : undefined,
  };
  const choice: ProviderChoice = {
    id: entry.id,
    verb: entry.verb,
    label: entry.label,
    summary: entry.summary,
    descriptor,
  };
  if (entry.env) choice.env = entry.env;
  if (entry.indexableDefault !== undefined) choice.indexableDefault = entry.indexableDefault;
  return choice;
}

/** Merge every manifest's preset contributions. */
export function manifestPresets(home?: string): Record<string, Array<{ verb: string; choice: string }>> {
  const out: Record<string, Array<{ verb: string; choice: string }>> = {};
  for (const lm of scanManifests(home)) {
    for (const [name, items] of Object.entries(lm.manifest.presets ?? {})) {
      if (!out[name]) out[name] = items.map((i) => ({ verb: i.verb, choice: i.choice }));
    }
  }
  return out;
}

/** Flatten all source entries with their origin/package for doctor + docs. */
export function manifestSourceEntries(home?: string): Array<SourceEntry & { origin: "shipped" | "installed"; pkg: string }> {
  const out: Array<SourceEntry & { origin: "shipped" | "installed"; pkg: string }> = [];
  for (const lm of scanManifests(home)) {
    for (const entry of lm.manifest.entries) {
      if (entry.kind !== "source") continue;
      out.push({ ...entry, origin: lm.origin, pkg: lm.pkg });
    }
  }
  return out;
}

/** Build a SourceDescriptor for a source type (or one of its aliases). Script
 *  refs in `base` are resolved to absolute paths here — the descriptor's base is
 *  spawned verbatim by the doctor plate probe, so it must not carry raw refs.
 *  Returns undefined when the type is unknown or its script isn't in this build
 *  (parity with the old `script ? {...} : undefined`). */
export function manifestSourceDescriptor(type: string, home?: string): SourceDescriptor | undefined {
  for (const entry of manifestSourceEntries(home)) {
    if (entry.type !== type && !(entry.aliases ?? []).includes(type)) continue;
    const base = resolveBase(entry.base, home);
    if (!base) return undefined;
    return { type, base, needs: entry.needs, timeoutMs: entry.timeoutMs };
  }
  return undefined;
}

function resolveBase(base: string[], home?: string): string[] | undefined {
  const out: string[] = [];
  for (const token of base) {
    if (isInstalledRef(token)) {
      const abs = resolveInstalledRefToken(token, home);
      if (!abs) return undefined;
      out.push(abs);
    } else if (token.startsWith("shipped:")) {
      const abs = resolveShippedRefToken(token);
      if (!abs) return undefined;
      out.push(abs);
    } else {
      out.push(token);
    }
  }
  return out;
}

/** Host → source type routes contributed by manifests (for ad-hoc capture). */
export function manifestHostRoutes(): Array<{ host: string; type: string }> {
  const out: Array<{ host: string; type: string }> = [];
  for (const entry of manifestSourceEntries()) {
    for (const host of entry.hosts ?? []) out.push({ host: host.toLowerCase(), type: entry.type });
  }
  return out;
}
