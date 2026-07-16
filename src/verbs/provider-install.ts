// `overcast provider install|remove|list --installed|create` — the installable
// provider-package feature (manifests plan, Stage B/C). A package is a directory
// (or .tgz/.tar.gz tarball) containing a provider.json manifest + its scripts;
// install validates it, rejects collisions with shipped/installed providers, and
// copies it into <home>/providers/<name>/ with a provenance stamp. Local path /
// tarball only — no git/npm fetch (invariant #10: install is arbitrary code exec,
// so the source must be something the operator already has on disk).

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { makeRecord, type OvercastRecord } from "../record.js";
import { OVERCAST_VERSION } from "../version.js";
import { providerChoices, providerPresets } from "../providers/catalog.js";
import { scanManifests, manifestSourceEntries, invalidateManifestCache } from "../providers/manifests.js";
import { installedProvidersRoot } from "../providers/installed-ref.js";
import { validateManifest, type ProviderManifest, type SourceEntry } from "../providers/manifest-schema.js";

const PROVENANCE_FILE = ".overcast-install.json";

export interface Provenance {
  name: string;
  version: string;
  installed_at?: string;
  upgraded_at?: string;
  origin: string;
  sha256: string;
  overcast_version: string;
}

function ok(payload: Record<string, unknown>, state: "ready" | "pending" = "ready"): OvercastRecord {
  return makeRecord({ verb: "provider", format: "json", payload, meta: { transient: true }, state });
}
function fail(message: string): OvercastRecord {
  return makeRecord({ verb: "provider", format: "json", payload: { error: message }, meta: { transient: true }, state: "error", error: message });
}

/** Deterministic sha256 over a package tree: sorted `<relpath>\0<filehash>\n`
 *  lines, excluding the provenance file. Used for provenance + tamper detection. */
export function hashProviderTree(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    const abs = join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (rel === "" && entry.name === PROVENANCE_FILE) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) {
        const h = createHash("sha256").update(readFileSync(join(dir, childRel))).digest("hex");
        lines.push(`${childRel}\0${h}`);
      }
    }
  };
  walk("");
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

export function readProvenance(pkgDir: string): Provenance | undefined {
  const p = join(pkgDir, PROVENANCE_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Provenance;
  } catch {
    return undefined;
  }
}

/** Collect the entries a candidate manifest would register, for collision checks
 *  and confirmation display. */
function manifestSummary(m: ProviderManifest): {
  senses: string[];
  sources: string[];
  presets: string[];
} {
  const senses: string[] = [];
  const sources: string[] = [];
  for (const e of m.entries) {
    if (e.kind === "sense") senses.push(`${e.verb}:${e.id}`);
    else sources.push([e.type, ...(e.aliases ?? [])].join("/"));
  }
  return { senses, sources, presets: Object.keys(m.presets ?? {}) };
}

/** Best-effort read of every installed package's DECLARED entries at `home`,
 *  including packages whose provider.json fails validation or is unreadable — so
 *  the collision check reserves their types/choices even though the scan drops
 *  them (an unparseable manifest still occupies its package-name slot). */
function installedDeclaredAt(home?: string): Array<{ pkg: string; choices: string[]; types: string[]; presets: string[] }> {
  const root = installedProvidersRoot(home);
  const out: Array<{ pkg: string; choices: string[]; types: string[]; presets: string[] }> = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const pkg of dirs) {
    if (pkg.startsWith(".")) continue;
    const mp = join(root, pkg, "provider.json");
    if (!existsSync(mp)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(mp, "utf8"));
    } catch {
      out.push({ pkg, choices: [], types: [], presets: [] }); // dir occupies the name
      continue;
    }
    const r = raw as { entries?: unknown[]; presets?: Record<string, unknown> };
    const choices: string[] = [];
    const types: string[] = [];
    for (const e of Array.isArray(r?.entries) ? r.entries : []) {
      const x = e as { kind?: string; verb?: string; id?: string; type?: string; aliases?: unknown[] };
      if (x?.kind === "sense" && typeof x.verb === "string" && typeof x.id === "string") choices.push(`${x.verb}:${x.id}`);
      else if (x?.kind === "source" && typeof x.type === "string") {
        types.push(x.type);
        for (const a of Array.isArray(x.aliases) ? x.aliases : []) if (typeof a === "string") types.push(a);
      }
    }
    const presets = r?.presets && typeof r.presets === "object" ? Object.keys(r.presets) : [];
    out.push({ pkg, choices, types, presets });
  }
  return out;
}

/** Installed package dirs whose provider.json is present but doesn't scan (invalid
 *  schema or unparseable JSON) — the scanner drops these silently, so doctor
 *  surfaces them (they still occupy their package-name slot on disk). */
export function invalidInstalledPackages(home?: string): string[] {
  const scanned = new Set(scanManifests(home).filter((l) => l.origin === "installed").map((l) => l.pkg));
  const root = installedProvidersRoot(home);
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const pkg of dirs) {
    if (pkg.startsWith(".")) continue;
    if (existsSync(join(root, pkg, "provider.json")) && !scanned.has(pkg)) out.push(pkg);
  }
  return out;
}

/** Find what a candidate manifest collides with in the live corpus (shipped +
 *  other installed). `excludePkg` skips a package being replaced (upgrade). */
function findCollisions(m: ProviderManifest, home?: string, excludePkg?: string): string[] {
  // All corpus reads use the TARGET home so installing to a custom home isn't
  // false-flagged by a conflict in the default home (the accessors default to
  // $OVERCAST_HOME for every other caller).
  const choiceKeys = new Set(providerChoices(home).map((c) => `${c.verb}:${c.id}`));
  const sourceTypes = new Set<string>();
  for (const e of manifestSourceEntries(home)) {
    if (excludePkg && e.pkg === excludePkg) continue;
    for (const t of [e.type, ...(e.aliases ?? [])]) sourceTypes.add(t);
  }
  const presetNames = new Set(Object.keys(providerPresets(home)));
  // Fold in on-disk installed packages at the target home — INCLUDING any whose
  // provider.json is invalid/unreadable (the scan silently drops those, so their
  // declared type/choice would otherwise look free and a different-named package
  // could reuse it, leaving duplicate on-disk entries with nondeterministic
  // resolution).
  for (const decl of installedDeclaredAt(home)) {
    if (excludePkg && decl.pkg === excludePkg) continue;
    decl.choices.forEach((c) => choiceKeys.add(c));
    decl.types.forEach((t) => sourceTypes.add(t));
    decl.presets.forEach((pn) => presetNames.add(pn));
  }
  // exclude the replaced package's own contributions on upgrade
  if (excludePkg) {
    const own = scanManifests(home).find((l) => l.pkg === excludePkg && l.origin === "installed");
    for (const e of own?.manifest.entries ?? []) {
      if (e.kind === "sense") choiceKeys.delete(`${e.verb}:${e.id}`);
    }
    for (const name of Object.keys(own?.manifest.presets ?? {})) presetNames.delete(name);
  }

  const out: string[] = [];
  for (const e of m.entries) {
    if (e.kind === "sense") {
      if (choiceKeys.has(`${e.verb}:${e.id}`)) out.push(`sense choice ${e.verb}:${e.id} already provided`);
    } else {
      for (const t of [e.type, ...((e as SourceEntry).aliases ?? [])]) {
        if (sourceTypes.has(t)) out.push(`source type '${t}' already provided`);
      }
    }
  }
  for (const name of Object.keys(m.presets ?? {})) {
    if (presetNames.has(name)) out.push(`preset '${name}' already provided`);
  }
  return out;
}

/** Stage the install source (a dir or a .tgz/.tar.gz) into a temp dir and return
 *  the directory that contains provider.json. Caller must rm the returned root. */
function stageSource(src: string): { staged: string; cleanup: () => void; error?: string } {
  const abs = resolve(src);
  if (!existsSync(abs)) return { staged: "", cleanup: () => {}, error: `no such path: ${src}` };
  const staging = mkdtempSync(join(tmpdir(), "oc-provider-install-"));
  const cleanup = () => rmSync(staging, { recursive: true, force: true });
  const st = statSync(abs);
  if (st.isDirectory()) {
    cpSync(abs, join(staging, "pkg"), { recursive: true });
    return { staged: join(staging, "pkg"), cleanup };
  }
  if (/\.(tgz|tar\.gz)$/.test(abs)) {
    const out = join(staging, "pkg");
    mkdirSync(out, { recursive: true });
    // Path-traversal guard: list the members and refuse the whole tarball if ANY
    // entry is absolute or escapes via `..` — BEFORE extracting, since tar would
    // otherwise write the offending member outside the staging dir (a post-extract
    // scan can't see a file that already escaped). system tar is a prerequisite.
    const list = spawnSync("tar", ["-tzf", abs], { encoding: "utf8", timeout: 60_000 });
    if (list.error || list.status !== 0) {
      cleanup();
      return { staged: "", cleanup: () => {}, error: `tar listing failed: ${(list.stderr || list.error?.message || "").slice(0, 200)}` };
    }
    const unsafe = list.stdout
      .split("\n")
      .map((e) => e.trim())
      // reject absolute (POSIX / Windows drive), ~, and `..` traversal with EITHER separator
      .find((e) => e && (e.startsWith("/") || e.startsWith("~") || /^[a-zA-Z]:/.test(e) || e.split(/[/\\]/).includes("..")));
    if (unsafe) {
      cleanup();
      return { staged: "", cleanup: () => {}, error: `tarball has an unsafe member '${unsafe}' — refused (path traversal / absolute path)` };
    }
    const res = spawnSync("tar", ["-xzf", abs, "-C", out], { encoding: "utf8", timeout: 60_000 });
    if (res.error || res.status !== 0) {
      cleanup();
      return { staged: "", cleanup: () => {}, error: `tar extraction failed: ${(res.stderr || res.error?.message || "").slice(0, 200)}` };
    }
    // a tarball may wrap the package in a single top-level dir
    const root = findManifestDir(out);
    if (!root) {
      cleanup();
      return { staged: "", cleanup: () => {}, error: "tarball has no provider.json" };
    }
    return { staged: root, cleanup };
  }
  cleanup();
  return { staged: "", cleanup: () => {}, error: "install source must be a directory or a .tgz/.tar.gz tarball" };
}

function findManifestDir(root: string): string | undefined {
  if (existsSync(join(root, "provider.json"))) return root;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(root, e.name, "provider.json"))) return join(root, e.name);
  }
  return undefined;
}

/** Every file under a staged package must live inside it (no symlink escape). */
function hasUnsafePaths(dir: string): boolean {
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory() && walk(join(d, e.name))) return true;
    }
    return false;
  };
  return walk(dir);
}

export interface InstallOpts {
  yes?: boolean;
  upgrade?: boolean;
}

export function installProvider(src: string, opts: InstallOpts, home?: string): OvercastRecord[] {
  invalidateManifestCache();
  const { staged, cleanup, error } = stageSource(src);
  if (error) return [fail(error)];
  try {
    if (hasUnsafePaths(staged)) return [fail("package contains a symlink — refused (path-escape guard)")];
    const manifestPath = join(staged, "provider.json");
    if (!existsSync(manifestPath)) return [fail("package has no provider.json")];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      return [fail(`provider.json is not valid JSON: ${(e as Error).message}`)];
    }
    const res = validateManifest(raw, { installed: true });
    if (!res.ok) return [fail(`invalid provider.json:\n- ${res.errors.join("\n- ")}`)];
    const manifest = raw as ProviderManifest;

    const target = join(installedProvidersRoot(home), manifest.name);
    const alreadyInstalled = existsSync(target);
    if (alreadyInstalled && !opts.upgrade) {
      return [fail(`provider package '${manifest.name}' is already installed — reinstall with --upgrade, or \`provider remove ${manifest.name}\` first`)];
    }

    const collisions = findCollisions(manifest, home, opts.upgrade ? manifest.name : undefined);
    if (collisions.length) {
      return [fail(`'${manifest.name}' collides with existing providers:\n- ${collisions.join("\n- ")}`)];
    }

    const summary = manifestSummary(manifest);
    if (opts.yes !== true) {
      return [ok({
        op: "provider_install",
        name: manifest.name,
        version: manifest.version,
        origin: resolve(src),
        upgrade: alreadyInstalled,
        registers: summary,
        confirmation_required: true,
        confirm_with: `overcast provider install ${src}${opts.upgrade ? " --upgrade" : ""} --yes`,
      }, "pending")];
    }

    // write provenance, then atomically swap into place
    const sha256 = hashProviderTree(staged);
    const now = timestamp();
    const prov: Provenance = {
      name: manifest.name,
      version: manifest.version,
      origin: resolve(src),
      sha256,
      overcast_version: OVERCAST_VERSION,
      ...(alreadyInstalled ? { upgraded_at: now } : { installed_at: now }),
    };
    writeFileSync(join(staged, PROVENANCE_FILE), JSON.stringify(prov, null, 2) + "\n");

    mkdirSync(installedProvidersRoot(home), { recursive: true });
    if (alreadyInstalled) {
      const backup = `${target}.bak-${process.pid}`;
      renameSync(target, backup);
      try {
        cpSync(staged, target, { recursive: true });
        rmSync(backup, { recursive: true, force: true });
      } catch (e) {
        rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
        return [fail(`upgrade failed, restored previous install: ${(e as Error).message}`)];
      }
    } else {
      cpSync(staged, target, { recursive: true });
    }
    invalidateManifestCache();
    return [ok({
      op: "provider_install",
      name: manifest.name,
      version: manifest.version,
      installed_at: prov.installed_at ?? prov.upgraded_at,
      upgraded: alreadyInstalled,
      dir: target,
      registers: summary,
      provenance: prov,
    })];
  } finally {
    cleanup();
  }
}

export function removeProvider(name: string, opts: { yes?: boolean }, home?: string): OvercastRecord[] {
  const target = join(installedProvidersRoot(home), name);
  if (!existsSync(target)) return [fail(`provider package '${name}' is not installed`)];
  // warn about bindings that reference this package
  const boundRefs = referencesToPackage(name, home);
  if (opts.yes !== true) {
    return [ok({
      op: "provider_remove",
      name,
      still_bound: boundRefs,
      confirmation_required: true,
      confirm_with: `overcast provider remove ${name} --yes`,
    }, "pending")];
  }
  rmSync(target, { recursive: true, force: true });
  invalidateManifestCache();
  return [ok({ op: "provider_remove", name, removed: true, was_bound: boundRefs })];
}

/** Scan installed packages for `provider list --installed` / doctor. */
export function listInstalled(home?: string): Array<{
  name: string;
  version: string;
  dir: string;
  entries: Array<{ kind: string; ref: string }>;
  provenance?: Provenance;
  tampered: boolean;
}> {
  return scanManifests(home)
    .filter((l) => l.origin === "installed")
    .map((l) => {
      const prov = readProvenance(l.dir);
      let tampered = false;
      if (prov?.sha256) {
        try {
          tampered = hashProviderTree(l.dir) !== prov.sha256;
        } catch {
          tampered = false;
        }
      }
      return {
        name: l.pkg,
        version: l.manifest.version,
        dir: l.dir,
        entries: l.manifest.entries.map((e) =>
          e.kind === "sense" ? { kind: "sense", ref: `${e.verb}:${e.id}` } : { kind: "source", ref: e.type },
        ),
        provenance: prov,
        tampered,
      };
    });
}

/** Descriptor command strings across an installed package that some profile /
 *  case still binds (best-effort; drives the remove warning). */
function referencesToPackage(name: string, home?: string): string[] {
  // A shallow scan: any installed:<name>/ token in the scanned manifests is
  // self-referential; the meaningful bindings live in profiles/case policies,
  // surfaced by `doctor` provider-paths after removal. Kept minimal here.
  return scanManifests(home)
    .filter((l) => l.origin === "installed" && l.pkg === name)
    .flatMap((l) => l.manifest.entries.map((e) => (e.kind === "sense" ? `${e.verb}:${e.id}` : `source:${e.type}`)));
}

// Date.now()/new Date() are available in the CLI runtime (unlike workflow scripts).
function timestamp(): string {
  return new Date().toISOString();
}

// ---- provider create (scaffold) ---------------------------------------------

const SENSE_SCRIPT = `#!/usr/bin/env bash
# overcast exec SENSE provider scaffold. Contract (docs/providers.md):
#   describe          → print a JSON object describing the provider
#   init              → check deps/creds; exit 0 ready, 13 = needs credentials
#   run --input <ref> → do the work; print ONE record JSON to stdout
set -euo pipefail
op="\${1:-run}"; shift || true
case "$op" in
  describe) echo '{"verb":"see","kind":"image.analysis","payload":["caption"]}'; exit 0 ;;
  init)     exit 0 ;;
esac
# run --input <ref>
input=""
while [ $# -gt 0 ]; do case "$1" in --input) input="\${2:-}"; shift 2 ;; *) shift ;; esac; done
[ -n "$input" ] || { echo "no --input" >&2; exit 2; }
# TODO: call your model here; emit one loose record.
jq -n --arg ref "$input" '{verb:"see", format:"json", payload:{caption:"TODO"}, media:{ref:$ref}, meta:{provider:"scaffold"}, state:"ready"}'
`;

const SOURCE_SCRIPT = `#!/usr/bin/env bash
# overcast exec SOURCE provider scaffold. Contract (docs/providers.md):
#   describe                       → print a JSON object describing the source
#   init                           → check creds; exit 0 ready, 13 = needs creds
#   enumerate --query <q> [--limit N] [--since S] → print a JSON ARRAY of scan.hit
#   fetch --url <u> --out <path>   → download to <path>, print one capture record
set -euo pipefail
op="\${1:-enumerate}"; shift || true
case "$op" in
  describe) echo '{"source":"scaffold","emits":"scan.hit","needs":[]}'; exit 0 ;;
  init)     exit 0 ;;
  enumerate)
    query=""
    while [ $# -gt 0 ]; do case "$1" in --query) query="\${2:-}"; shift 2 ;; *) shift ;; esac; done
    # TODO: query your backend; emit a JSON array of hits.
    jq -n --arg q "$query" '[{title:$q, url:"https://example.com", source:"scaffold"}]' ;;
  fetch)
    url=""; out=""
    while [ $# -gt 0 ]; do case "$1" in --url) url="\${2:-}"; shift 2 ;; --out) out="\${2:-}"; shift 2 ;; *) shift ;; esac; done
    # TODO: download "$url" to "$out" (e.g. curl -fsSL "$url" -o "$out").
    echo "scaffold fetch: would download $url -> $out" >&2
    jq -n --arg ref "$out" '{verb:"capture", format:"json", media:{ref:$ref}, state:"ready"}' ;;
esac
`;

/** Scaffold a template provider package (provider.json + a runnable script) that
 *  installs and passes the exec contract, so an author can start from a working
 *  package. Writes under <out>/<name>/; no creds, no network. */
export function createProviderScaffold(name: string, kind: "sense" | "source", outDir: string): OvercastRecord[] {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return [fail(`invalid package name '${name}' (lowercase [a-z0-9._-])`)];
  if (["sources", "senses", "engines"].includes(name)) return [fail(`'${name}' is a reserved package name`)];
  const dir = join(resolve(outDir), name);
  if (existsSync(dir)) return [fail(`refusing to overwrite existing path: ${dir}`)];
  const script = `${name}.sh`;
  const manifest: ProviderManifest =
    kind === "sense"
      ? {
          manifest_version: 1,
          name,
          version: "0.1.0",
          description: `${name} sense provider (scaffold)`,
          entries: [{
            kind: "sense", id: name, verb: "see",
            label: `${name} (scaffold)`, summary: "TODO: describe this provider.",
            descriptor: {
              type: "exec",
              run: `bash installed:${name}/${script} --input {{input}}`,
              init: `bash installed:${name}/${script} init`,
              describe: `bash installed:${name}/${script} describe`,
            },
          }],
        }
      : {
          manifest_version: 1,
          name,
          version: "0.1.0",
          description: `${name} source provider (scaffold)`,
          entries: [{
            kind: "source", type: name,
            label: `${name} (scaffold)`, summary: "TODO: describe this source.",
            base: ["bash", `installed:${name}/${script}`],
            needs: "none",
            doctor: { check: "keyless", okNote: `${name} ready (scaffold)` },
          }],
        };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "provider.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, script), kind === "source" ? SOURCE_SCRIPT : SENSE_SCRIPT, { mode: 0o755 });
  return [ok({
    op: "provider_create",
    name,
    kind,
    dir,
    files: ["provider.json", script],
    next: `overcast provider install ${dir} --yes`,
  })];
}
