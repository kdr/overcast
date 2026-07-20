// Phase 5 config verbs: setup (bind brain LLM + per-verb providers; manage
// profiles), provider (init/list/describe a provider), doctor (readiness checks).
// Bindings live in the profile so they travel with --profile.

import { makeRecord, errRecord } from "../record.js";
import {
  loadProfile,
  saveProfile,
  resolveHome,
  profilesDir,
  resolveCloudglue,
  type Profile,
  type ProviderDescriptor,
} from "../profile.js";
import { listBuckets } from "../archive.js";
import { FFMPEG_PATH, FFPROBE_PATH, probeTool, MIN_FFMPEG } from "../media/ffmpeg.js";
import { execCapture } from "../providers/exec.js";
import { tokenizeCommand, builtinDescriptor } from "../providers/sources/index.js";
import { manifestSourceEntries } from "../providers/manifests.js";
import { tinycloudBase } from "../providers/tinycloud/envelope.js";
import { DEFAULT_QMD_MODEL } from "../providers/memory/qmd.js";
import { loadSetup, saveSetup, emptySetup } from "../state/setup.js";
import { findProviderChoice, providerChoices, providerPresets, type ProviderChoice } from "../providers/catalog.js";
import { installProvider, removeProvider, listInstalled, createProviderScaffold, invalidInstalledPackages } from "./provider-install.js";
import {
  resolveShippedArgv,
  shippedRefResolution,
  descriptorCommandStrings,
  findShippedTokenIssues,
} from "../providers/shipped-ref.js";
import { ProviderRefError } from "../providers/ref-error.js";
import { localVisionPython } from "../providers/local/vision.js";
import { PI_VERSION } from "../version.js";
import { envPresent, redactSecrets } from "../env.js";
import { listSources } from "../state/source.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VerbSpec, VerbContext } from "../registry/types.js";

const err = errRecord;

function quoteCommandArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && isRealPackage(pkg)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function isRealPackage(pkgJsonPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      dependencies?: unknown;
      files?: unknown;
    };
    return pkg.dependencies != null || pkg.files != null;
  } catch {
    return false;
  }
}

function nodeProbeExecutable(): string {
  const exe = basename(process.execPath).toLowerCase();
  return exe === "node" || exe === "node.exe" ? process.execPath : "node";
}

/** Minimum tinycloud this overcast build supports: 0.3.12 restored inline
 *  verbatim speech in the watch envelope (`segments[].speech`, feature
 *  `watch.speech.v1`), which the single-call watch/listen transcript path maps
 *  directly. Older installs (≥ 0.3.10) still work through the caption-verb
 *  fallback but are flagged by doctor; face/index need ≥ 0.3.4. */
export const MIN_TINYCLOUD = "0.3.12";
/** Latest tinycloud version this overcast build documents and recommends. */
export const RECOMMENDED_TINYCLOUD = "0.3.12";

function parseSemver(s: string): [number, number, number] | undefined {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** True when version `a` is strictly older than `b`. */
function semverLt(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/** Parse a provider spec into a descriptor. Forms: builtin:<name> | exec:<cmd> |
 *  http(s)://… | inproc:<module>. `builtin:<name>` selects a shipped in-process
 *  backend (currently `see`: builtin:brain | builtin:hf); the module keeps its
 *  `builtin:` prefix so the verb recognizes it. */
export function parseProviderSpec(spec: string): ProviderDescriptor {
  if (spec.startsWith("http://") || spec.startsWith("https://")) {
    return { type: "http", endpoint: spec };
  }
  if (spec.startsWith("builtin:")) {
    return { type: "inproc", module: spec };
  }
  if (spec.startsWith("inproc:")) {
    return { type: "inproc", module: spec.slice("inproc:".length) };
  }
  if (spec.startsWith("exec:")) {
    return execDescriptor(spec.slice("exec:".length));
  }
  // bare path/command → exec
  return execDescriptor(spec);
}

/** Build an exec descriptor, wiring the documented `<cmd> init` / `<cmd> describe`
 *  subcommands (providers.md) so `provider init`/`describe` actually run them. */
function execDescriptor(run: string): ProviderDescriptor {
  // Derive the bare base command: drop a trailing {{input}} and any trailing
  // run/--input sentinel so init/describe attach to just the script.
  const base = run
    .replace(/\s*\{\{\s*input\s*\}\}\s*$/, "")
    .replace(/\s+(?:run\s+)?--input\s*$/, "")
    .replace(/\s+run\s*$/, "")
    .trim();
  return {
    type: "exec",
    // Invoke the run op with an explicit --input, so the media path is NEVER
    // argv[1] and a file literally named "init"/"describe" can't be mistaken for
    // the subcommand. init/describe are `<base> init` / `<base> describe`. An
    // EMPTY base (e.g. `exec:`) stays empty so dispatch coalesces to the default
    // command instead of spawning a bare `--input …`.
    run: base ? `${base} --input {{input}}` : run,
    init: { command: `${base} init` },
    describe: `${base} describe`,
  };
}

function providerSetupRequests(ctx: VerbContext): { items: Array<{ verb: string; choice: string; choiceName: string }>; error?: string } {
  const preset = ctx.opts.preset ? String(ctx.opts.preset).trim() : "";
  const verb = ctx.opts.verb ? String(ctx.opts.verb).trim() : "";
  const choice = ctx.opts.choice ? String(ctx.opts.choice).trim() : "";
  if (preset) {
    const presets = providerPresets(ctx.home);
    const items = presets[preset];
    if (!items) return { items: [], error: `unknown provider preset '${preset}' (expected ${Object.keys(presets).join(" | ")})` };
    return { items: items.map((i) => ({ ...i, choiceName: i.choice })) };
  }
  if (!verb || !choice) {
    return { items: [], error: "provider setup needs --verb <verb> and --choice <choice>, or --preset <preset>" };
  }
  return { items: [{ verb, choice, choiceName: choice }] };
}

interface ProviderSetupChange {
  verb: string;
  choice: string;
  label: string;
  summary: string;
  descriptor?: ProviderDescriptor;
  /** transparency: each `shipped:` ref in the descriptor → its resolved absolute
   *  path in THIS build (null = unresolvable). The stored descriptor keeps the ref. */
  resolved?: Record<string, string | null>;
  clears_binding: boolean;
  env: string[];
  missing_env: string[];
  indexable_default: boolean;
}

function providerSetupChange(verb: string, choice: ProviderChoice, home?: string): ProviderSetupChange {
  return {
    verb,
    choice: choice.id,
    label: choice.label,
    summary: choice.summary,
    descriptor: choice.descriptor,
    resolved: shippedRefResolution(choice.descriptor, home),
    clears_binding: choice.clearsBinding === true,
    env: choice.env ?? [],
    missing_env: (choice.env ?? []).filter((name) => !process.env[name]),
    indexable_default: choice.indexableDefault === true,
  };
}

function builtinProviderDefaults(): Record<string, Record<string, unknown>> {
  return {
    watch: {
      source: "builtin",
      choice: "tinycloud",
      label: "Cloudglue / tinycloud",
      summary: "Default video understanding through tinycloud watch.",
      descriptor: { type: "exec", run: "tinycloud watch {{input}} --json", init: { skill: "tinycloud-init", ensure: true }, describe: "tinycloud commands --json" },
    },
    listen: {
      source: "builtin",
      choice: "tinycloud",
      label: "Cloudglue / tinycloud speech",
      summary: "Default speech transcription through tinycloud.",
      descriptor: { type: "exec", run: "tinycloud watch {{input}} --speech-only --json", init: { skill: "tinycloud-init", ensure: true }, describe: "tinycloud commands --json" },
    },
    face: {
      source: "builtin",
      choice: "tinycloud",
      label: "Cloudglue / tinycloud face",
      summary: "Default face detect/match/search through tinycloud.",
      descriptor: { type: "exec", run: "tinycloud face detect {{input}} --json", init: { skill: "tinycloud-init", ensure: true }, describe: "tinycloud commands --json" },
    },
    see: {
      source: "builtin",
      choice: "hf-if-configured",
      label: "Hugging Face captioner or setup-needed placeholder",
      summary: "Uses the default HF image captioner when HF_TOKEN is set; otherwise reports needs_credentials until a VLM provider is bound.",
    },
    enhance: {
      source: "builtin",
      choice: "ffmpeg",
      label: "Local ffmpeg",
      summary: "Built-in deterministic ffmpeg enhancer.",
    },
  };
}

function effectiveProviders(profile: Profile): Record<string, Record<string, unknown>> {
  const out = builtinProviderDefaults();
  for (const [verb, descriptor] of Object.entries(profile.providers ?? {})) {
    out[verb] = {
      source: "profile",
      choice: "configured",
      label: "Profile binding",
      summary: "Explicit provider binding from the active profile.",
      descriptor,
    };
  }
  return out;
}

// ---- setup -----------------------------------------------------------------

export const setupVerb: VerbSpec = {
  name: "setup",
  group: "config",
  summary: "Bind the brain LLM + per-verb providers and manage profiles (setup provider|llm|memory|show).",
  description:
    "Configure and persist profiles under ~/.overcast/profiles/. `setup provider <verb> <spec>` binds a " +
    "verb to a provider (exec:<cmd> | http(s)://… | inproc:<module>). `setup llm <provider> <model>` sets " +
    "the brain. `setup memory <local-grep|qmd>` configures case search. `setup show` prints the active profile.",
  args: [
    { name: "action", summary: "provider | llm | memory | show (default: show)", choices: ["provider", "llm", "memory", "show"] },
    { name: "a", summary: "verb (provider), provider id (llm), or backend (memory)" },
    { name: "b", summary: "spec (provider), model (llm), or command (memory)" },
  ],
  flags: [
    { name: "profile", summary: "Profile name to write (default: default)", type: "string" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "setup",
  providerKey: "setup",
  run: async (ctx) => {
    const action = ctx.input ?? "show";
    const name = ctx.opts.profile ? String(ctx.opts.profile) : ctx.profileName ?? "default";
    const ho = { home: ctx.home, profile: name };
    const profile: Profile = loadProfile(ho);
    // saveProfile writes to profile.name's file; pin it to the profile we loaded
    // so edits can't land in a different file when the names differ.
    profile.name = name;

    if (action === "provider") {
      const verb = ctx.rest[0];
      const spec = ctx.rest[1];
      if (!verb || !spec) return [err("setup", "usage: setup provider <verb> <spec>")];
      profile.providers = { ...profile.providers, [verb]: parseProviderSpec(spec) };
      const path = saveProfile(profile, ho);
      return [makeRecord({ verb: "setup", format: "json", payload: { bound: verb, descriptor: profile.providers[verb], profile: name, path }, state: "ready" })];
    }
    if (action === "llm") {
      const provider = ctx.rest[0];
      const model = ctx.rest[1];
      if (!provider) return [err("setup", "usage: setup llm <provider> [model]")];
      profile.llm = { provider, model };
      const path = saveProfile(profile, ho);
      return [makeRecord({ verb: "setup", format: "json", payload: { llm: profile.llm, profile: name, path }, state: "ready" })];
    }
    if (action === "memory") {
      const backend = (ctx.rest[0] ?? "local-grep").trim();
      if (!backend) return [err("setup", "usage: setup memory <local-grep|qmd|cloudglue> [command|index]")];
      // `cloudglue` is the CASE-scoped, opt-in cloud tier for `ask --deep`
      // (invariant #2 BYO spirit — uploads/queries cost money, so it is NEVER
      // auto-enabled). Unlike local-grep/qmd it does not bind a profile provider:
      // it pins the case's media-descriptions collection, so it lives in the case
      // setup (.overcast/setup.json). `[index]` pins a specific media-descriptions
      // index (id/name); `off` clears the opt-in.
      if (backend === "cloudglue") {
        const setup = loadSetup(ctx.case) ?? emptySetup(ctx.case.exists() ? ctx.case.info().name : "case");
        const arg = (ctx.rest[1] ?? "").trim();
        if (/^(off|false|none|disable|clear)$/i.test(arg)) {
          delete setup.memory.cloudglue;
        } else {
          setup.memory.cloudglue = arg ? { index: arg } : {};
        }
        setup.updated_at = new Date().toISOString();
        saveSetup(ctx.case, setup);
        return [makeRecord({ verb: "setup", format: "json", payload: { memory: { cloudglue: setup.memory.cloudglue ?? null }, case: ctx.case.dir }, state: "ready" })];
      }
      if (backend !== "local-grep" && backend !== "local" && backend !== "qmd") {
        return [err("setup", `unknown memory backend '${backend}' (expected local-grep | qmd | cloudglue)`)];
      }
      if (backend === "local-grep" || backend === "local") {
        profile.memory = [];
      } else {
        const command = ctx.rest.slice(1).map(quoteCommandArg).join(" ").trim() || undefined;
        profile.memory = [{
          type: "exec",
          backend: "qmd",
          id: "qmd",
          command,
          model: DEFAULT_QMD_MODEL,
        }];
      }
      const path = saveProfile(profile, ho);
      return [makeRecord({ verb: "setup", format: "json", payload: { memory: profile.memory ?? [], profile: name, path }, state: "ready" })];
    }
    // a typo like `setup provder` must not read as a successful `show`
    if (action && action !== "show") {
      return [err("setup", `unknown setup action '${action}' (expected provider | llm | memory | show)`)];
    }
    // show
    return [makeRecord({ verb: "setup", format: "json", payload: { profile: profile }, meta: { transient: true }, state: "ready" })];
  },
};

// ---- provider (init/list/describe) -----------------------------------------

export const providerVerb: VerbSpec = {
  name: "provider",
  group: "config",
  summary: "Run provider setup/init hooks, or list/describe bound providers (provider setup|init|list|describe).",
  description:
    "`provider setup plan|apply|show` configures catalog-backed provider choices for a profile. " +
    "`provider install <path|tarball>` installs a third-party provider package (a provider.json " +
    "manifest + scripts) — `provider create <name> --kind sense|source` scaffolds one, " +
    "`list --installed` / `remove <name>` manage them. `provider init <verb>` runs the bound " +
    "provider's init step; `provider list` shows the active bindings.",
  args: [
    { name: "action", summary: "setup | install | remove | create | init | list | describe (default: list)", choices: ["setup", "install", "remove", "create", "init", "list", "describe"] },
    { name: "verb", summary: "setup subcommand, verb to init/describe, or the install path / package name" },
  ],
  flags: [
    { name: "profile", summary: "Profile name to write/read (default: active/default)", type: "string" },
    { name: "verb", summary: "provider setup: verb to configure", type: "string" },
    { name: "choice", summary: "provider setup: catalog choice id", type: "string" },
    { name: "preset", summary: `provider setup: preset id (${Object.keys(providerPresets()).join("|")})`, type: "string" },
    { name: "yes", summary: "confirm a mutating action (setup apply / install / remove)", type: "boolean" },
    { name: "installed", summary: "provider list: show installed provider packages", type: "boolean" },
    { name: "upgrade", summary: "provider install: replace an already-installed package of the same name", type: "boolean" },
    { name: "kind", summary: "provider create: sense | source (default: sense)", type: "string", choices: ["sense", "source"] },
    { name: "out", summary: "provider create: output directory (default: ./)", type: "string" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "provider",
  providerKey: "provider",
  run: async (ctx) => {
    const action = ctx.input ?? "list";
    const profileName = ctx.opts.profile ? String(ctx.opts.profile) : ctx.profileName ?? ctx.profile.name ?? "default";
    const profile = loadProfile({ home: ctx.home, profile: profileName });
    profile.name = profileName;
    const providers = profile.providers ?? {};
    if (action === "setup") {
      const sub = ctx.rest[0] ?? "show";
      if (sub === "show") {
        // choices carry a `resolved` map (shipped: ref → absolute path in this
        // build) for transparency; the descriptor itself keeps the portable ref.
        const choices = providerChoices(ctx.home).map((c) => ({ ...c, resolved: shippedRefResolution(c.descriptor, ctx.home) }));
        return [makeRecord({ verb: "provider", format: "json", payload: { profile: profileName, choices, presets: providerPresets(ctx.home), providers }, meta: { transient: true }, state: "ready" })];
      }
      if (sub !== "plan" && sub !== "apply") {
        return [err("provider", "usage: provider setup [show|plan|apply] [--verb <verb> --choice <choice> | --preset <preset>] [--profile <name>] [--yes]")];
      }
      const requested = providerSetupRequests(ctx);
      if (requested.error) return [err("provider", requested.error)];
      const selected = requested.items.map((i) => ({ ...i, choice: findProviderChoice(i.verb, i.choice, ctx.home) }));
      const missing = selected.find((i) => !i.choice);
      if (missing) return [err("provider", `unknown provider choice '${missing.choiceName}' for verb '${missing.verb}'`)];
      const changes = selected.map((i) => providerSetupChange(i.verb, i.choice!, ctx.home));
      const payload = {
        op: "provider_setup",
        profile: profileName,
        saved: sub === "apply" && ctx.opts.yes === true,
        changes,
        confirmation_required: sub === "apply" && ctx.opts.yes !== true,
        confirm_with: sub === "apply" && ctx.opts.yes !== true ? "overcast provider setup apply ... --yes" : undefined,
      };
      if (sub === "plan" || ctx.opts.yes !== true) {
        return [makeRecord({ verb: "provider", format: "json", payload, meta: { transient: true }, state: "pending" })];
      }
      profile.providers = { ...(profile.providers ?? {}) };
      for (const change of changes) {
        if (change.clears_binding) delete profile.providers[change.verb];
        else if (change.descriptor) profile.providers[change.verb] = change.descriptor as ProviderDescriptor;
      }
      const path = saveProfile(profile, { home: ctx.home, profile: profileName });
      return [makeRecord({ verb: "provider", format: "json", payload: { ...payload, path, providers: profile.providers }, state: "ready" })];
    }
    if (action === "install") {
      const src = ctx.rest[0];
      if (!src) return [err("provider", "usage: provider install <path|tarball> [--upgrade] [--yes]")];
      return installProvider(src, { yes: ctx.opts.yes === true, upgrade: ctx.opts.upgrade === true }, ctx.home);
    }
    if (action === "remove") {
      const name = ctx.rest[0];
      if (!name) return [err("provider", "usage: provider remove <package-name> [--yes]")];
      return removeProvider(name, { yes: ctx.opts.yes === true }, ctx.home);
    }
    if (action === "create") {
      const name = ctx.rest[0];
      if (!name) return [err("provider", "usage: provider create <name> [--kind sense|source] [--out <dir>]")];
      const kind = ctx.opts.kind === "source" ? "source" : "sense";
      return createProviderScaffold(name, kind, ctx.opts.out ? String(ctx.opts.out) : ".");
    }
    if (action === "list") {
      if (ctx.opts.installed === true) {
        return [makeRecord({ verb: "provider", format: "json", payload: { installed: listInstalled(ctx.home) }, meta: { transient: true }, state: "ready" })];
      }
      return [makeRecord({ verb: "provider", format: "json", payload: { profile: profileName, providers, effective: effectiveProviders(profile) }, meta: { transient: true }, state: "ready" })];
    }
    if (action !== "describe" && action !== "init") {
      return [err("provider", `unknown provider action '${action}' (expected setup | install | remove | create | init | list | describe)`)];
    }
    const verb = ctx.rest[0];
    if (!verb) return [err("provider", `usage: provider ${action} <verb>`)];
    const desc = providers[verb];
    if (!desc) return [err("provider", `no provider bound for '${verb}' (try \`setup provider ${verb} <spec>\`)`)];

    if (action === "describe") {
      if (desc.describe) {
        let parts: string[];
        try {
          // descriptor commands may carry `shipped:` refs — resolve at exec time.
          parts = resolveShippedArgv(tokenizeCommand(desc.describe), ctx.home);
        } catch (e) {
          if (!(e instanceof ProviderRefError)) throw e;
          return [err("provider", e.message)];
        }
        const res = await execCapture(parts[0], parts.slice(1), { signal: ctx.signal, timeoutMs: 60_000 }).catch((e) => {
          // a spawn/timeout failure becomes an error record; a cancellation propagates
          if (ctx.signal?.aborted) throw e;
          return { code: 1, stdout: "", stderr: (e as Error).message };
        });
        // exit 13 = needs credentials (the exec contract), like provider init + the exec boundary
        const dstate = res.code === 0 ? "ready" : res.code === 13 ? "needs_credentials" : "error";
        // a provider's describe command may echo a credentialed URL / token; redact
        // before it lands on disk in the record (mirrors the exec-boundary redaction).
        return [makeRecord({ verb: "provider", format: "json", payload: { verb, describe: redactSecrets(res.stdout || res.stderr) }, state: dstate })];
      }
      return [makeRecord({ verb: "provider", format: "json", payload: { verb, descriptor: desc }, state: "ready" })];
    }

    // init
    const init = desc.init;
    if (!init) return [makeRecord({ verb: "provider", format: "json", payload: { verb, note: "no init step" }, state: "ready" })];
    if (typeof init === "object" && init.skill) {
      return [makeRecord({ verb: "provider", format: "json", payload: { verb, skill: init.skill, guidance: `init uses the '${init.skill}' skill; install/run it (skill auto-load is not wired yet)` }, state: "needs_credentials" })];
    }
    const cmd = typeof init === "string" ? init : init.command;
    if (!cmd) return [makeRecord({ verb: "provider", format: "json", payload: { verb }, state: "ready" })];
    let parts: string[];
    try {
      // descriptor init commands may carry `shipped:` refs — resolve at exec time.
      parts = resolveShippedArgv(tokenizeCommand(cmd), ctx.home);
    } catch (e) {
      if (!(e instanceof ProviderRefError)) throw e;
      return [err("provider", e.message)];
    }
    const res = await execCapture(parts[0], parts.slice(1), { signal: ctx.signal, timeoutMs: 5 * 60_000 }).catch((e) => {
      // a spawn/timeout failure becomes an error record; a cancellation propagates
      if (ctx.signal?.aborted) throw e;
      return { code: 1, stdout: "", stderr: (e as Error).message };
    });
    // exec contract (providers.md): exit 13 = needs credentials, not a hard error.
    const state = res.code === 0 ? "ready" : res.code === 13 ? "needs_credentials" : "error";
    // redact BEFORE truncating: an init command may echo a token/credentialed URL,
    // and slicing first could cut a secret mid-token so the pattern no longer matches.
    return [makeRecord({ verb: "provider", format: "json", payload: { verb, init: cmd, stdout: redactSecrets(res.stdout).slice(0, 1000), stderr: redactSecrets(res.stderr).slice(0, 1000) }, state, error: state === "error" ? `init exited ${res.code}` : undefined })];
  },
};

// ---- doctor ----------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export const doctorVerb: VerbSpec = {
  name: "doctor",
  group: "config",
  summary: "Preflight: check pi version, ffmpeg/ffprobe, Cloudglue creds, tinycloud, provider bindings.",
  args: [],
  flags: [
    { name: "sources", summary: "Also check configured source-provider credentials", type: "boolean" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "doctor",
  providerKey: "doctor",
  run: async (ctx) => {
    const checks: Check[] = [];

    // pinned pi (report the build's pinned version; not hardcoded to one release)
    checks.push({ name: "pi", ok: /^\d+\.\d+\.\d+$/.test(PI_VERSION), detail: `pinned ${PI_VERSION}` });

    // ffmpeg + ffprobe — a SYSTEM prerequisite (on PATH or via OVERCAST_FFMPEG/
    // OVERCAST_FFPROBE). Report presence + version, and flag installs older than
    // the recommended minimum.
    for (const [label, bin] of [["ffmpeg", FFMPEG_PATH], ["ffprobe", FFPROBE_PATH]] as const) {
      const info = await probeTool(bin);
      const detail = info.ok
        ? `${info.version ?? "ok"}${info.recent === false ? ` (recommend ≥ ${MIN_FFMPEG})` : ""}`
        : `not found on PATH — install ffmpeg ≥ ${MIN_FFMPEG} (e.g. \`brew install ffmpeg\` / \`apt install ffmpeg\`)`;
      checks.push({ name: label, ok: info.ok, detail });
    }

    // Cloudglue creds (brain provider)
    const cg = resolveCloudglue();
    checks.push({ name: "cloudglue", ok: Boolean(cg.apiKey), detail: cg.apiKey ? `key present, baseUrl ${cg.baseUrl}` : "no CLOUDGLUE_API_KEY / tinycloud config" });

    // tinycloud CLI (default sense backend). Honor OVERCAST_TINYCLOUD_CMD so a
    // custom path/wrapper is the one actually checked. Parse the version to flag
    // installs older than the supported floor and recommend the latest
    // documented tinycloud build when an older-but-compatible CLI is present.
    const [tcCmd, ...tcLead] = tinycloudBase();
    const tc = await execCapture(tcCmd, [...tcLead, "--version"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const tcVer = parseSemver(`${tc.stdout} ${tc.stderr}`);
    const tcOld = tcVer ? semverLt(tcVer, parseSemver(MIN_TINYCLOUD)!) : false;
    const tcBehind = tcVer ? semverLt(tcVer, parseSemver(RECOMMENDED_TINYCLOUD)!) : false;
    checks.push({
      name: "tinycloud",
      ok: tc.code === 0,
      detail:
        tc.code !== 0
          ? `tinycloud CLI not on PATH (install latest: \`npm i -g @cloudglue/tinycloud@${RECOMMENDED_TINYCLOUD}\` or \`tinycloud install --latest\`)`
          : tcVer
            ? `${tcVer.join(".")}${tcOld ? ` (overcast needs ≥ ${MIN_TINYCLOUD} for inline watch/listen transcripts — run \`tinycloud update\`)` : tcBehind ? ` (update recommended: latest tested ${RECOMMENDED_TINYCLOUD}; run \`tinycloud update\`)` : ""}`
            : "CLI available",
    });

    const qmdSpec = (ctx.profile.memory ?? []).find((m) => (m.backend ?? m.id ?? "").toLowerCase() === "qmd");
    const qmdConfigured = Boolean(qmdSpec || process.env.OVERCAST_QMD_CMD || process.env.OVERCAST_QMD_MODEL);
    const qmdCmd = tokenizeCommand(qmdSpec?.command ?? qmdSpec?.run ?? process.env.OVERCAST_QMD_CMD ?? "qmd");
    const qmd = await execCapture(qmdCmd[0], [...qmdCmd.slice(1), "--help"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (qmdConfigured || qmd.code === 0) {
      checks.push({
        name: "qmd",
        ok: qmd.code === 0,
        detail: qmd.code === 0
          ? `optional semantic memory CLI available (${DEFAULT_QMD_MODEL})`
          : "optional semantic memory CLI missing — install with `npm install -g @tobilu/qmd`",
      });
    }

    // Delegates to the ONE Chromium resolver the renderer launches with —
    // providers/engines/screenshot/chromium-exec.mjs (override → playwright's
    // default → the build actually on disk under PLAYWRIGHT_BROWSERS_PATH; managed
    // cloud images pin a different revision than the installed playwright expects)
    // — so doctor reports green exactly where the renderer will in fact launch.
    const chromiumExecMjs = join(packageRoot(), "providers", "engines", "screenshot", "chromium-exec.mjs");
    const playwrightProbe = [
      "try {",
      "  const { pathToFileURL } = await import('node:url');",
      "  const { chromium } = await import('playwright');",
      "  const { resolveChromiumExecutable } = await import(pathToFileURL(process.env.OC_CHROMIUM_EXEC_MJS).href);",
      "  const p = resolveChromiumExecutable(chromium);",
      "  if (!p) throw new Error('Chromium browser payload missing');",
      "  console.log(p);",
      "} catch (e) {",
      "  console.error(e && e.message ? e.message : String(e));",
      "  process.exit(1);",
      "}",
    ].join("\n");
    const playwright = await execCapture(nodeProbeExecutable(), ["-e", playwrightProbe], {
      cwd: packageRoot(),
      timeoutMs: 15_000,
      env: { ...process.env, OC_CHROMIUM_EXEC_MJS: chromiumExecMjs },
    })
      .catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    checks.push({
      name: "playwright",
      ok: playwright.code === 0,
      detail: playwright.code === 0
        ? `optional HTML screenshot renderer available (${playwright.stdout.trim()})`
        : "optional HTML screenshot renderer missing — run `npm install --include=optional` and `npx playwright install chromium`",
    });

    const uv = await execCapture("uv", ["--version"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const localPy = localVisionPython();
    const localVision = await execCapture(localPy, ["-c", "import cv2, numpy; print('image-ok')"], { timeoutMs: 30_000 })
      .catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    const localFace = await execCapture(localPy, ["-c", "import deepface, numpy; print('face-ok')"], { timeoutMs: 30_000 })
      .catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    // audio deps: scipy is the fingerprint half (audio-fp); transformers+torch is
    // the heavier CLAP half (basic-clap). Probe imports only — never load a model
    // (from_pretrained would trigger a ~776MB download).
    const localAudioFp = await execCapture(localPy, ["-c", "import scipy, numpy; print('audio-ok')"], { timeoutMs: 30_000 })
      .catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    const localClap = await execCapture(localPy, ["-c", "import transformers, torch; print('clap-ok')"], { timeoutMs: 60_000 })
      .catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    checks.push({
      name: "uv",
      ok: uv.code === 0,
      detail: uv.code === 0 ? (uv.stdout || uv.stderr).trim() : "uv missing — install it, then run `scripts/visual-db-uv.sh`",
    });
    checks.push({
      name: "visual-db",
      ok: localVision.code === 0,
      detail: localVision.code === 0
        ? `image deps OK via ${localPy}${localFace.code === 0 ? "; face deps OK" : "; face deps missing (run scripts/visual-db-uv.sh --face)"}`
        : `image deps missing via ${localPy} — run \`scripts/visual-db-uv.sh\` and set OC_VISUAL_DB_PY if needed`,
    });
    checks.push({
      name: "audio-db",
      // gate on the lightweight scipy half; CLAP is optional and reported in detail.
      ok: localAudioFp.code === 0,
      detail: localAudioFp.code === 0
        ? `fingerprint deps OK via ${localPy}${localClap.code === 0 ? "; clap deps OK" : "; clap deps missing (run scripts/visual-db-uv.sh --clap)"}`
        : `fingerprint deps missing via ${localPy} — run \`scripts/visual-db-uv.sh --audio\` (scipy) and set OC_VISUAL_DB_PY if needed`,
    });
    // enhance --ops separate/segment (local-models provider): report which stacks
    // are installed. Informational (ok) — these are opt-in and don't gate core.
    const localSegment = await execCapture(localPy, ["-c", "import transformers, torch; print('seg-ok')"], { timeoutMs: 30_000 })
      .catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    const localVoice = await execCapture(localPy, ["-c", "import pyannote.audio; print('voice-ok')"], { timeoutMs: 30_000 })
      .catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    const segPart = localSegment.code === 0 ? "segment deps OK" : "segment deps missing (scripts/visual-db-uv.sh --segment)";
    const voicePart = localVoice.code === 0
      ? `voice deps OK${envPresent("HF_TOKEN") || envPresent("HUGGING_FACE_HUB_TOKEN") ? "" : " (set HF_TOKEN + accept pyannote license)"}`
      : "voice deps missing (scripts/visual-db-uv.sh --voice)";
    checks.push({
      name: "enhance-local",
      ok: true,
      detail: `${segPart}; ${voicePart}`,
    });
    // voice match (voice-print DB): same pyannote stack as enhance --ops separate.
    // Informational (ok) — opt-in; the windowed default needs NO token (the
    // wespeaker embedding model is ungated), only --diarize is HF-gated.
    checks.push({
      name: "voice-match",
      ok: true,
      detail: localVoice.code === 0
        ? `speaker-verification deps OK via ${localPy} (wespeaker model ~26MB downloads on first run)${envPresent("HF_TOKEN") || envPresent("HUGGING_FACE_HUB_TOKEN") ? "; --diarize token present" : "; --diarize needs HF_TOKEN + accepted pyannote license"}`
        : "voice deps missing — run `scripts/visual-db-uv.sh --voice` for `voice add/match`",
    });

    // exiftool — optional system CLI backing the `exif` metadata/GPS sense.
    // Honor OVERCAST_EXIFTOOL_CMD so a custom path/wrapper is the one checked
    // (same knob the shipped exif.sh reads; lets offline tests point at a fake).
    // Split on whitespace to MATCH the shipped exif.sh/verify.sh (`read -r -a <<<`),
    // so a space-containing override path fails here too rather than passing the
    // check yet breaking when the sense actually runs.
    const exiftoolCmd = (process.env.OVERCAST_EXIFTOOL_CMD || "exiftool").trim().split(/\s+/);
    const exiftool = await execCapture(exiftoolCmd[0], [...exiftoolCmd.slice(1), "-ver"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    checks.push({
      name: "exiftool",
      ok: exiftool.code === 0,
      detail: exiftool.code === 0
        ? `optional metadata/GPS sense (exif) available (v${exiftool.stdout.trim()})`
        : "optional — install exiftool for the `exif` sense (`brew install exiftool` / `apt install libimage-exiftool-perl`)",
    });

    // c2patool — optional system CLI backing the `verify` C2PA provenance sense.
    const c2patoolCmd = (process.env.OVERCAST_C2PATOOL_CMD || "c2patool").trim().split(/\s+/);
    const c2patool = await execCapture(c2patoolCmd[0], [...c2patoolCmd.slice(1), "--version"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    checks.push({
      name: "c2patool",
      ok: c2patool.code === 0,
      detail: c2patool.code === 0
        ? `optional C2PA provenance sense (verify) available (${c2patool.stdout.trim()})`
        : "optional — install c2patool for the `verify` sense (`brew install c2patool` / `cargo install c2patool`)",
    });

    // geocode — OPT-IN reverse-geocode provider for `exif --geocode`. Report
    // whether a provider is bound and whether curl is present (its default dep).
    const geocodeBound = Boolean(ctx.profile.providers?.geocode);
    const geocodeCurl = await execCapture("curl", ["--version"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    checks.push({
      name: "geocode",
      ok: true, // opt-in — never gates
      detail: geocodeBound
        ? `bound (exif --geocode enabled)${geocodeCurl.code === 0 ? "" : "; curl missing (the default Nominatim provider needs it)"}`
        : "optional/off — bind to enable `exif --geocode` (`overcast provider setup apply --verb geocode --choice nominatim --yes`)",
    });


    const configuredSources = listSources(ctx.case);
    const sourceTypes = new Set(configuredSources.map((s) => s.type));
    // Source credential checks are driven by each source manifest's `doctor`
    // descriptor (providers/sources/<type>/provider.json). A type is checked when
    // --sources is passed OR it's configured in this case (via its type or an
    // alias). Sources with no `doctor` field (youtube/dl/overpass/firms/flights/
    // yandeximg) emit no check, exactly as before. Detail strings live verbatim in
    // the manifests, so the output is unchanged from the old hardcoded cascade.
    const seenSourceCheck = new Set<string>();
    for (const entry of manifestSourceEntries(ctx.home)) {
      const d = entry.doctor;
      if (!d) continue;
      const names = [entry.type, ...(entry.aliases ?? [])];
      const wanted = ctx.opts.sources === true || names.some((n) => sourceTypes.has(n));
      if (!wanted) continue;
      if (seenSourceCheck.has(entry.type)) continue;
      seenSourceCheck.add(entry.type);
      const name = `source:${entry.type}`;
      if (d.check === "keyless") {
        checks.push({ name, ok: true, detail: d.okNote });
      } else if (d.check === "reuse_playwright") {
        checks.push({ name, ok: playwright.code === 0, detail: playwright.code === 0 ? d.okNote : (d.missingNote ?? d.okNote) });
      } else if (d.check === "probe_init") {
        // can't be judged from env alone (e.g. plate: actor-or-override). Probe the
        // provider's own `init` health check (exit 0 = ready, 13 = missing creds).
        const desc = builtinDescriptor(entry.type, ctx.home);
        let pok = false;
        let detail = d.unavailableNote ?? d.missingNote ?? `${entry.type} provider unavailable`;
        if (desc) {
          const [pcmd, ...plead] = desc.base;
          const res = await execCapture(pcmd, [...plead, "init"], { signal: ctx.signal, timeoutMs: 15_000 }).catch(
            () => ({ code: 1, stdout: "", stderr: "" }),
          );
          pok = res.code === 0;
          detail = pok ? d.okNote : (d.missingNote ?? detail);
        }
        checks.push({ name, ok: pok, detail });
      } else {
        // env_all (all present) / env_any (any present)
        const keys = d.env ?? [];
        const present = d.check === "env_any" ? keys.some(envPresent) : keys.every(envPresent);
        checks.push({ name, ok: present, detail: present ? d.okNote : (d.missingNote ?? `${keys.join("/")} missing`) });
      }
    }

    // home / profiles
    const home = resolveHome({ home: ctx.home });
    const pdir = profilesDir(home);
    const profiles = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
    checks.push({ name: "home", ok: true, detail: `${home} (${profiles.length} profile(s))` });

    // global archive buckets (case-shaped stores under <home>/archive)
    const buckets = listBuckets(ctx.home);
    checks.push({
      name: "archive",
      ok: true,
      detail: buckets.length
        ? `${buckets.length} bucket(s): ${buckets.map((b) => b.name).join(", ")}`
        : "no buckets yet (create one with `overcast archive init <bucket>`)",
    });

    // provider bindings
    const bound = Object.keys(ctx.profile.providers ?? {});
    checks.push({ name: "providers", ok: bound.length > 0, detail: bound.length ? bound.join(", ") : "none bound (defaults apply)" });

    // installed provider packages: flag any whose files changed since install
    // (sha256 mismatch vs .overcast-install.json) OR whose provider.json no longer
    // scans (invalid/unreadable — the scanner drops these silently, so an operator
    // never learns why a package vanished from the catalog). Elevated to doctor so
    // neither goes unnoticed. Only emitted when packages are present.
    const installedPkgs = listInstalled(ctx.home);
    const invalidPkgs = invalidInstalledPackages(ctx.home);
    if (installedPkgs.length || invalidPkgs.length) {
      const problems = [
        ...installedPkgs.filter((p) => p.tampered).map((p) => `${p.name} (tampered)`),
        ...invalidPkgs.map((n) => `${n} (invalid manifest)`),
      ];
      checks.push({
        name: "installed-providers",
        ok: problems.length === 0,
        detail: problems.length
          ? `${problems.length} package(s) need attention: ${problems.join(", ")} — \`provider install --upgrade\` to re-stamp, fix the manifest, or \`provider remove\``
          : `${installedPkgs.length} installed: ${installedPkgs.map((p) => p.name).join(", ")}`,
      });
    }

    // provider paths: flag bindings whose `shipped:` ref doesn't resolve in this
    // build, or that still carry a stale absolute shipped-provider path healing
    // couldn't rewrite (loadProfile heals recognized old paths on load — what
    // remains here is genuinely broken).
    const pathIssues: string[] = [];
    const scanDescriptors = (source: string, providers: Record<string, ProviderDescriptor | undefined>) => {
      for (const [verb, desc] of Object.entries(providers)) {
        if (!desc || typeof desc !== "object") continue;
        for (const cmd of descriptorCommandStrings(desc)) {
          for (const issue of findShippedTokenIssues(cmd, ctx.home)) {
            const label =
              issue.kind === "unresolvable_ref"
                ? "unresolvable"
                : issue.kind === "missing_script"
                  ? "missing script"
                  : "stale path";
            pathIssues.push(`${source} ${verb}: ${label} ${issue.token}`);
          }
        }
      }
    };
    scanDescriptors("profile", ctx.profile.providers ?? {});
    const casePolicies = loadSetup(ctx.case)?.providers ?? {};
    scanDescriptors(
      "case-setup",
      Object.fromEntries(
        Object.entries(casePolicies).map(([verb, policy]) => [verb, policy?.descriptor as ProviderDescriptor | undefined]),
      ),
    );
    checks.push({
      name: "provider-paths",
      ok: pathIssues.length === 0,
      detail: pathIssues.length
        ? `${pathIssues.join("; ")} — re-run \`overcast provider setup apply --verb <verb> --choice <id> --yes\` (recognized old install paths heal automatically on load), or re-bind a moved custom/demo script to an existing path`
        : "bindings resolve (shipped: refs OK, no stale provider paths)",
    });

    const coreOk = checks.filter((c) => ["pi", "ffmpeg", "ffprobe"].includes(c.name)).every((c) => c.ok);
    // non-core but important: the default sense backend (tinycloud) + creds. If
    // tinycloud is missing AND no custom watch provider is bound, the headline
    // `watch`/`listen` won't run — surface that as a warning, not a green light.
    const warnings: string[] = [];
    const hasCustomSense = ["watch", "listen"].some((v) => {
      const b = ctx.profile.providers?.[v];
      if (!b) return false;
      // an http/inproc binding (endpoint/module, no run) is also a custom sense
      if (b.endpoint || b.module) return true;
      return b.run ? !/^\s*tinycloud\b/.test(b.run) : false;
    });
    // tinycloud missing is ALWAYS a warning: face / index / `ask --index`
    // call it by default and can't be fully bound away, so a custom watch/listen
    // provider only spares those two verbs — not the rest.
    if (!checks.find((c) => c.name === "tinycloud")?.ok) {
      warnings.push(
        hasCustomSense
          ? "tinycloud CLI missing — face/index/`ask --index` still call it and will fail (watch/listen are bound to custom providers)"
          : "tinycloud CLI missing and no custom watch/listen provider bound — watch/listen/face/index will fail",
      );
    }
    if (tcOld) {
      warnings.push(`tinycloud is older than ${MIN_TINYCLOUD} — watch/listen need ≥ ${MIN_TINYCLOUD} for inline verbatim transcripts (\`watch.speech.v1\`), face/index need ≥ 0.3.4 (run \`tinycloud update\`)`);
    } else if (tcBehind) {
      warnings.push(`tinycloud ${tcVer?.join(".")} is older than the recommended ${RECOMMENDED_TINYCLOUD} — run \`tinycloud update\` to pick up the latest face validation and reliability behavior`);
    }
    if (!checks.find((c) => c.name === "cloudglue")?.ok) {
      warnings.push("no Cloudglue key — the default sense backend and the Cloudglue brain are unavailable");
    }
    if (qmdConfigured && !checks.find((c) => c.name === "qmd")?.ok) {
      warnings.push("qmd memory is configured but qmd is not available — install with `npm install -g @tobilu/qmd` or update OVERCAST_QMD_CMD");
    }
    if (pathIssues.length) {
      warnings.push(
        "provider bindings point at missing shipped provider files (unresolvable shipped: ref or stale absolute path) — re-bind with `overcast provider setup apply --verb <verb> --choice <id> --yes`",
      );
    }
    const ok = coreOk && warnings.length === 0;
    return [
      makeRecord({
        verb: "doctor",
        format: "json",
        payload: { checks, ok, core_ok: coreOk, warnings, profiles },
        meta: { case: ctx.case.dir },
        state: ok ? "ready" : "error",
        error: ok ? undefined : !coreOk ? "one or more core checks failed" : warnings.join("; "),
      }),
    ];
  },
};
