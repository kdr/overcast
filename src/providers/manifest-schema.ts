// provider.json manifest schema + validator. A manifest describes one provider
// PACKAGE (a directory under the shipped `providers/` tree or an installed
// package under `<home>/providers/<name>/`). It declares one or more EXEC
// entries — sense choices and/or OSINT source types — plus preset contributions.
//
// This module is intentionally dependency-free (no fs, no profile.ts, no
// shipped-ref.ts) so it can be shared by the runtime scanner
// (src/providers/manifests.ts), the install command, and the CI validation
// test without import cycles. Ref resolution + fs discovery live in manifests.ts.
//
// Only EXEC providers are manifest-described (CLAUDE.md invariant #6 as scoped by
// the manifests plan): the inproc DB choices, the `clearsBinding` builtins
// (ffmpeg/playwright), the brain-vision `see` default, and the script-less
// tinycloud watch/listen/face CLI bindings stay hardcoded in TS.

export interface ProviderManifest {
  /** schema version; current = 1. */
  manifest_version: 1;
  /** package identity. For installed packages this MUST equal the install dir
   *  name and is the `installed:<name>/…` namespace. Charset below; the names
   *  `sources` / `senses` / `engines` are reserved (they collide with the
   *  shipped-layout regex in shipped-ref.ts). */
  name: string;
  /** informational version string (semver-ish). */
  version: string;
  description?: string;
  homepage?: string;
  entries: ProviderManifestEntry[];
  /** named presets this package contributes; each maps to {verb,choice} pairs
   *  that MUST reference entries declared in this same manifest. */
  presets?: Record<string, Array<{ verb: string; choice: string }>>;
}

export type ProviderManifestEntry = SenseEntry | SourceEntry;

interface EntryBase {
  kind: "sense" | "source";
  label: string;
  summary: string;
  /** env vars this provider reads; surfaced as missing_env by `provider setup
   *  plan` and (for sources) by doctor. */
  env?: string[];
}

export interface SenseManifestDescriptor {
  type: "exec";
  /** command template. Carries `shipped:`/`installed:` refs inline (resolved at
   *  spawn), the `{{input}}` media placeholder (rendered by run.ts), and an
   *  optional `{{env:VAR|default}}` token expanded when the choice is
   *  materialized (replaces the catalog.ts DETECT_PY build-time interpolation). */
  run: string;
  init?: string;      // scanner wraps into { command: init } for the descriptor
  describe?: string;
}

export interface SenseEntry extends EntryBase {
  kind: "sense";
  /** catalog choice id — unique per verb across all packages. */
  id: string;
  verb: string;
  descriptor: SenseManifestDescriptor;
  indexableDefault?: boolean;
}

/** doctor --sources check descriptor (consumed by the Stage-B manifest-driven
 *  cascade). Discriminated by `check`; okNote/missingNote are copied verbatim
 *  from the current hardcoded cascade so behavior is byte-identical. */
export interface SourceDoctor {
  check: "env_all" | "env_any" | "keyless" | "probe_init" | "reuse_playwright";
  /** env keys for env_all (all required) / env_any (any satisfies). */
  env?: string[];
  okNote: string;
  missingNote?: string;
  /** probe_init only: shown when the provider base can't be built at all. */
  unavailableNote?: string;
}

export interface SourceEntry extends EntryBase {
  kind: "source";
  /** `source add <type>:<ref>` type — unique across packages. */
  type: string;
  /** extra type spellings resolving to this same entry (x → ["twitter"]). */
  aliases?: string[];
  /** base argv (command + leading args); the op (enumerate|fetch|init) is
   *  appended at spawn. Script tokens are `shipped:`/`installed:` refs, resolved
   *  to absolute paths when the SourceDescriptor is built (the doctor plate probe
   *  spawns base verbatim, so it must not carry unresolved refs). */
  base: string[];
  /** human creds/deps note (SourceDescriptor.needs). */
  needs?: string;
  /** per-op exec budget in ms for slow backends (Apify run-sync = 360000). */
  timeoutMs?: number;
  /** the source honors `--limit 0` = enumerate everything (yt-dlp local
   *  enumeration). Without it the seam never forwards a 0 — the provider's own
   *  default cap applies instead. */
  uncappedLimit?: boolean;
  /** alternate fetch kinds served instead of the default media download
   *  (youtube: ["transcript","thumb"]); gates --transcript/--thumb routing. */
  fetchKinds?: string[];
  /** doctor --sources check; omit for sources that have no check today
   *  (youtube/dl/overpass/firms/flights/yandeximg) to preserve parity. */
  doctor?: SourceDoctor;
  /** hostnames this source claims for ad-hoc `capture <url>` routing. */
  hosts?: string[];
  /** documentation-only ref grammars (tiktok:@user, …) for skill-gen. */
  refForms?: Array<{ form: string; note?: string }>;
}

/** package names that would collide with the shipped-layout regex. */
export const RESERVED_PACKAGE_NAMES = ["sources", "senses", "engines"];

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

/** Validate a parsed manifest object in isolation (shape + per-entry rules).
 *  Cross-manifest collision checks and on-disk script existence live in the
 *  scanner/installer, which have fs + the sibling set. `opts.installed` tightens
 *  the reserved-name rule (a shipped package literally lives under senses/, so
 *  the reserved check only applies to installed package names). */
export function validateManifest(raw: unknown, opts: { installed?: boolean } = {}): ManifestValidation {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);

  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["manifest is not an object"] };
  }
  const m = raw as Record<string, unknown>;

  if (m.manifest_version !== 1) push(`manifest_version must be 1 (got ${JSON.stringify(m.manifest_version)})`);
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    push(`name must match ${NAME_RE} (got ${JSON.stringify(m.name)})`);
  } else if (opts.installed && RESERVED_PACKAGE_NAMES.includes(m.name)) {
    push(`name '${m.name}' is reserved`);
  }
  if (typeof m.version !== "string" || !m.version) push("version must be a non-empty string");
  if (m.description !== undefined && typeof m.description !== "string") push("description must be a string");

  const entries = m.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    push("entries must be a non-empty array");
    return { ok: errors.length === 0, errors };
  }

  const senseIds = new Set<string>();
  const sourceTypes = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    validateEntry(entries[i], i, push, senseIds, sourceTypes);
  }

  if (m.presets !== undefined) validatePresets(m.presets, senseIds, sourceTypes, entries as ProviderManifestEntry[], push);

  return { ok: errors.length === 0, errors };
}

function validateEntry(
  raw: unknown,
  i: number,
  push: (m: string) => void,
  senseIds: Set<string>,
  sourceTypes: Set<string>,
): void {
  const at = `entries[${i}]`;
  if (!raw || typeof raw !== "object") return push(`${at} is not an object`);
  const e = raw as Record<string, unknown>;
  if (e.kind !== "sense" && e.kind !== "source") return push(`${at}.kind must be "sense" | "source"`);
  if (typeof e.label !== "string" || !e.label) push(`${at}.label must be a non-empty string`);
  if (typeof e.summary !== "string" || !e.summary) push(`${at}.summary must be a non-empty string`);
  if (e.env !== undefined && !isStringArray(e.env)) push(`${at}.env must be a string[]`);

  if (e.kind === "sense") {
    if (typeof e.id !== "string" || !ID_RE.test(e.id)) push(`${at}.id must match ${ID_RE}`);
    else {
      const key = `${String(e.verb)}:${e.id}`;
      if (senseIds.has(key)) push(`${at} duplicate sense choice ${key} (already declared in this manifest)`);
      else senseIds.add(key);
    }
    if (typeof e.verb !== "string" || !e.verb) push(`${at}.verb must be a non-empty string`);
    const d = e.descriptor as Record<string, unknown> | undefined;
    if (!d || typeof d !== "object") return push(`${at}.descriptor is required`);
    if (d.type !== "exec") push(`${at}.descriptor.type must be "exec"`);
    if (typeof d.run !== "string" || !d.run) push(`${at}.descriptor.run must be a non-empty string`);
    else {
      if (!d.run.includes("{{input}}")) push(`${at}.descriptor.run must contain {{input}} (media is never a bare positional)`);
      for (const bad of absoluteScriptTokens(d.run)) push(`${at}.descriptor.run has an absolute script path '${bad}' (use a shipped:/installed: ref)`);
    }
    for (const f of ["init", "describe"] as const) {
      if (d[f] !== undefined && typeof d[f] !== "string") push(`${at}.descriptor.${f} must be a string`);
      else if (typeof d[f] === "string") for (const bad of absoluteScriptTokens(d[f] as string)) push(`${at}.descriptor.${f} has an absolute script path '${bad}'`);
    }
    if (e.indexableDefault !== undefined && typeof e.indexableDefault !== "boolean") push(`${at}.indexableDefault must be a boolean`);
  } else {
    if (typeof e.type !== "string" || !ID_RE.test(e.type)) push(`${at}.type must match ${ID_RE}`);
    else if (sourceTypes.has(e.type)) push(`${at} duplicate source type '${e.type}' (already declared in this manifest)`);
    else sourceTypes.add(e.type);
    if (e.aliases !== undefined) {
      if (!isStringArray(e.aliases)) push(`${at}.aliases must be a string[]`);
      else for (const a of e.aliases) {
        if (sourceTypes.has(a)) push(`${at} duplicate source type/alias '${a}' (already declared in this manifest)`);
        else sourceTypes.add(a);
      }
    }
    if (!isStringArray(e.base) || (e.base as string[]).length === 0) push(`${at}.base must be a non-empty string[]`);
    else for (const bad of (e.base as string[]).filter(isAbsoluteScriptToken)) push(`${at}.base has an absolute script path '${bad}' (use a shipped:/installed: ref)`);
    if (e.needs !== undefined && typeof e.needs !== "string") push(`${at}.needs must be a string`);
    if (e.timeoutMs !== undefined && (typeof e.timeoutMs !== "number" || e.timeoutMs <= 0)) push(`${at}.timeoutMs must be a positive number`);
    if (e.uncappedLimit !== undefined && typeof e.uncappedLimit !== "boolean") push(`${at}.uncappedLimit must be a boolean`);
    if (e.fetchKinds !== undefined && !isStringArray(e.fetchKinds)) push(`${at}.fetchKinds must be a string[]`);
    if (e.hosts !== undefined && !isStringArray(e.hosts)) push(`${at}.hosts must be a string[]`);
    validateSourceDoctor(e.doctor, at, push);
  }
}

function validateSourceDoctor(raw: unknown, at: string, push: (m: string) => void): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object") return push(`${at}.doctor must be an object`);
  const d = raw as Record<string, unknown>;
  const checks = ["env_all", "env_any", "keyless", "probe_init", "reuse_playwright"];
  if (typeof d.check !== "string" || !checks.includes(d.check)) push(`${at}.doctor.check must be one of ${checks.join(" | ")}`);
  if ((d.check === "env_all" || d.check === "env_any") && !isStringArray(d.env)) push(`${at}.doctor.env is required for ${d.check}`);
  if (typeof d.okNote !== "string" || !d.okNote) push(`${at}.doctor.okNote must be a non-empty string`);
  if (d.missingNote !== undefined && typeof d.missingNote !== "string") push(`${at}.doctor.missingNote must be a string`);
}

function validatePresets(
  raw: unknown,
  senseIds: Set<string>,
  sourceTypes: Set<string>,
  _entries: ProviderManifestEntry[],
  push: (m: string) => void,
): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return push("presets must be an object");
  for (const [name, items] of Object.entries(raw as Record<string, unknown>)) {
    if (!ID_RE.test(name)) push(`presets['${name}'] name must match ${ID_RE}`);
    if (!Array.isArray(items)) {
      push(`presets['${name}'] must be an array`);
      continue;
    }
    for (const it of items) {
      const p = it as Record<string, unknown>;
      if (!p || typeof p.verb !== "string" || typeof p.choice !== "string") {
        push(`presets['${name}'] items must be {verb, choice}`);
        continue;
      }
      // a preset item must reference a sense choice (verb:id) or a source type in
      // this same manifest.
      if (!senseIds.has(`${p.verb}:${p.choice}`) && !sourceTypes.has(p.choice)) {
        push(`presets['${name}'] references unknown entry ${p.verb}/${p.choice} (must be declared in this manifest)`);
      }
    }
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** A token that is an absolute filesystem path to a script (would break install
 *  portability). shipped:/installed: refs and PATH commands are fine. */
function isAbsoluteScriptToken(token: string): boolean {
  return token.startsWith("/") && /\.(sh|py|mjs|cjs|js|ts)$/.test(token);
}

function absoluteScriptTokens(cmd: string): string[] {
  return cmd.split(/\s+/).filter(isAbsoluteScriptToken);
}
