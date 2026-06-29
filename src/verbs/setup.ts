// Phase 5 config verbs: setup (bind brain LLM + per-verb providers; manage
// profiles), provider (init/list/describe a provider), doctor (readiness checks).
// Bindings live in the profile so they travel with --profile.

import { makeRecord, type OvercastRecord } from "../record.js";
import {
  loadProfile,
  saveProfile,
  resolveHome,
  profilesDir,
  resolveCloudglue,
  type Profile,
  type ProviderDescriptor,
} from "../profile.js";
import { FFMPEG_PATH, FFPROBE_PATH, probeTool, MIN_FFMPEG } from "../media/ffmpeg.js";
import { execCapture } from "../providers/exec.js";
import { tokenizeCommand } from "../providers/sources/index.js";
import { tinycloudBase } from "../providers/tinycloud/envelope.js";
import { DEFAULT_QMD_MODEL } from "../providers/memory/qmd.js";
import { findProviderChoice, providerChoices, PROVIDER_PRESETS, type ProviderChoice } from "../providers/catalog.js";
import { PI_VERSION } from "../version.js";
import { envPresent } from "../env.js";
import { listSources } from "../state/source.js";
import { existsSync, readdirSync } from "node:fs";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
}

function quoteCommandArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** Minimum tinycloud the face + index verbs need (`face match` landed in
 *  0.3.4). Older installs run watch/listen fine but lack face/index support. */
export const MIN_TINYCLOUD = "0.3.4";
/** Latest tinycloud version this overcast build documents and recommends. */
export const RECOMMENDED_TINYCLOUD = "0.3.6";

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

/** Parse a provider spec into a descriptor. Forms: exec:<cmd> | http(s)://… | inproc:<module>. */
export function parseProviderSpec(spec: string): ProviderDescriptor {
  if (spec.startsWith("http://") || spec.startsWith("https://")) {
    return { type: "http", endpoint: spec };
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
    const items = PROVIDER_PRESETS[preset];
    if (!items) return { items: [], error: `unknown provider preset '${preset}' (expected ${Object.keys(PROVIDER_PRESETS).join(" | ")})` };
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
  clears_binding: boolean;
  env: string[];
  missing_env: string[];
  indexable_default: boolean;
}

function providerSetupChange(verb: string, choice: ProviderChoice): ProviderSetupChange {
  return {
    verb,
    choice: choice.id,
    label: choice.label,
    summary: choice.summary,
    descriptor: choice.descriptor,
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
  summary: "Bind the brain LLM + per-verb providers and manage profiles (setup provider|llm|show).",
  description:
    "Configure and persist profiles under ~/.overcast/profiles/. `setup provider <verb> <spec>` binds a " +
    "verb to a provider (exec:<cmd> | http(s)://… | inproc:<module>). `setup llm <provider> <model>` sets " +
    "the brain. `setup memory <local-grep|qmd>` configures case search. `setup show` prints the active profile.",
  args: [
    { name: "action", summary: "provider | llm | memory | show (default: show)" },
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
      if (!backend) return [err("setup", "usage: setup memory <local-grep|qmd> [command]")];
      if (backend !== "local-grep" && backend !== "local" && backend !== "qmd") {
        return [err("setup", `unknown memory backend '${backend}' (expected local-grep | qmd)`)];
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
    "`provider init <verb>` runs the bound provider's init step — a command, or guidance for a " +
    "skill-based init (not wired yet). `provider list` shows the active bindings.",
  args: [
    { name: "action", summary: "setup | init | list | describe (default: list)" },
    { name: "verb", summary: "setup subcommand, or verb whose provider to init/describe" },
  ],
  flags: [
    { name: "profile", summary: "Profile name to write/read (default: active/default)", type: "string" },
    { name: "verb", summary: "provider setup: verb to configure", type: "string" },
    { name: "choice", summary: "provider setup: catalog choice id", type: "string" },
    { name: "preset", summary: "provider setup: preset id (cloudglue|hf|fal|elevenlabs|local-detect)", type: "string" },
    { name: "yes", summary: "provider setup apply: confirm profile changes", type: "boolean" },
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
        return [makeRecord({ verb: "provider", format: "json", payload: { profile: profileName, choices: providerChoices(), presets: PROVIDER_PRESETS, providers }, meta: { transient: true }, state: "ready" })];
      }
      if (sub !== "plan" && sub !== "apply") {
        return [err("provider", "usage: provider setup [show|plan|apply] [--verb <verb> --choice <choice> | --preset <preset>] [--profile <name>] [--yes]")];
      }
      const requested = providerSetupRequests(ctx);
      if (requested.error) return [err("provider", requested.error)];
      const selected = requested.items.map((i) => ({ ...i, choice: findProviderChoice(i.verb, i.choice) }));
      const missing = selected.find((i) => !i.choice);
      if (missing) return [err("provider", `unknown provider choice '${missing.choiceName}' for verb '${missing.verb}'`)];
      const changes = selected.map((i) => providerSetupChange(i.verb, i.choice!));
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
    if (action === "list") {
      return [makeRecord({ verb: "provider", format: "json", payload: { profile: profileName, providers, effective: effectiveProviders(profile) }, meta: { transient: true }, state: "ready" })];
    }
    if (action !== "describe" && action !== "init") {
      return [err("provider", `unknown provider action '${action}' (expected setup | init | list | describe)`)];
    }
    const verb = ctx.rest[0];
    if (!verb) return [err("provider", `usage: provider ${action} <verb>`)];
    const desc = providers[verb];
    if (!desc) return [err("provider", `no provider bound for '${verb}' (try \`setup provider ${verb} <spec>\`)`)];

    if (action === "describe") {
      if (desc.describe) {
        const parts = tokenizeCommand(desc.describe);
        const res = await execCapture(parts[0], parts.slice(1), { signal: ctx.signal, timeoutMs: 60_000 }).catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
        // exit 13 = needs credentials (the exec contract), like provider init + the exec boundary
        const dstate = res.code === 0 ? "ready" : res.code === 13 ? "needs_credentials" : "error";
        return [makeRecord({ verb: "provider", format: "json", payload: { verb, describe: res.stdout || res.stderr }, state: dstate })];
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
    const parts = tokenizeCommand(cmd);
    const res = await execCapture(parts[0], parts.slice(1), { signal: ctx.signal, timeoutMs: 5 * 60_000 }).catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
    // exec contract (providers.md): exit 13 = needs credentials, not a hard error.
    const state = res.code === 0 ? "ready" : res.code === 13 ? "needs_credentials" : "error";
    return [makeRecord({ verb: "provider", format: "json", payload: { verb, init: cmd, stdout: res.stdout.slice(0, 1000), stderr: res.stderr.slice(0, 1000) }, state, error: state === "error" ? `init exited ${res.code}` : undefined })];
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
    // installs older than the face/index minimum and recommend the latest
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
            ? `${tcVer.join(".")}${tcOld ? ` (face/index verbs need ≥ ${MIN_TINYCLOUD} — run \`tinycloud update\`)` : tcBehind ? ` (update recommended: latest tested ${RECOMMENDED_TINYCLOUD}; run \`tinycloud update\`)` : ""}`
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

    const configuredSources = listSources(ctx.case);
    const sourceTypes = new Set(configuredSources.map((s) => s.type));
    if (ctx.opts.sources === true || sourceTypes.has("tiktok")) {
      checks.push({
        name: "source:tiktok",
        ok: envPresent("APIFY_TOKEN"),
        detail: envPresent("APIFY_TOKEN")
          ? "APIFY_TOKEN present"
          : "APIFY_TOKEN missing; put it in .env before launching overcast or export it in the shell",
      });
    }
    if (ctx.opts.sources === true || sourceTypes.has("web")) {
      checks.push({
        name: "source:web",
        ok: envPresent("TAVILY_API_KEY") || envPresent("BRAVE_API_KEY"),
        detail: envPresent("TAVILY_API_KEY") || envPresent("BRAVE_API_KEY")
          ? "web source key present"
          : "TAVILY_API_KEY or BRAVE_API_KEY missing for web source scans",
      });
    }

    // home / profiles
    const home = resolveHome({ home: ctx.home });
    const pdir = profilesDir(home);
    const profiles = existsSync(pdir) ? readdirSync(pdir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [];
    checks.push({ name: "home", ok: true, detail: `${home} (${profiles.length} profile(s))` });

    // provider bindings
    const bound = Object.keys(ctx.profile.providers ?? {});
    checks.push({ name: "providers", ok: bound.length > 0, detail: bound.length ? bound.join(", ") : "none bound (defaults apply)" });

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
      warnings.push(`tinycloud is older than ${MIN_TINYCLOUD} — the face + index verbs need ≥ ${MIN_TINYCLOUD} (run \`tinycloud update\`)`);
    } else if (tcBehind) {
      warnings.push(`tinycloud ${tcVer?.join(".")} is older than the recommended ${RECOMMENDED_TINYCLOUD} — run \`tinycloud update\` to pick up the latest face validation and reliability behavior`);
    }
    if (!checks.find((c) => c.name === "cloudglue")?.ok) {
      warnings.push("no Cloudglue key — the default sense backend and the Cloudglue brain are unavailable");
    }
    if (qmdConfigured && !checks.find((c) => c.name === "qmd")?.ok) {
      warnings.push("qmd memory is configured but qmd is not available — install with `npm install -g @tobilu/qmd` or update OVERCAST_QMD_CMD");
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
