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
import { FFMPEG_PATH, FFPROBE_PATH } from "../media/ffmpeg.js";
import { execCapture } from "../providers/exec.js";
import { tokenizeCommand } from "../providers/sources/index.js";
import { PI_VERSION } from "../version.js";
import { existsSync, readdirSync } from "node:fs";
import type { VerbSpec, VerbContext } from "../registry/types.js";

function err(verb: string, message: string): OvercastRecord {
  return makeRecord({ verb, format: "json", payload: { error: message }, error: message, state: "error" });
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
  // the verb op is invoked as `<base> {{input}}`; init/describe are `<base> init`
  // / `<base> describe` — strip a trailing {{input}} to get the base command.
  const base = run.replace(/\s*\{\{\s*input\s*\}\}\s*$/, "").trim();
  return {
    type: "exec",
    run,
    init: { command: `${base} init` },
    describe: `${base} describe`,
  };
}

// ---- setup -----------------------------------------------------------------

export const setupVerb: VerbSpec = {
  name: "setup",
  group: "config",
  summary: "Bind the brain LLM + per-verb providers and manage profiles (setup provider|llm|show).",
  description:
    "Configure and persist profiles under ~/.overcast/profiles/. `setup provider <verb> <spec>` binds a " +
    "verb to a provider (exec:<cmd> | http(s)://… | inproc:<module>). `setup llm <provider> <model>` sets " +
    "the brain. `setup show` prints the active profile.",
  args: [
    { name: "action", summary: "provider | llm | show", required: true },
    { name: "a", summary: "verb (for provider) or provider id (for llm)" },
    { name: "b", summary: "spec (for provider) or model (for llm)" },
  ],
  flags: [
    { name: "profile", summary: "Profile name to write (default: default)", type: "string" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "setup",
  providerKey: "setup",
  run: async (ctx) => {
    const action = ctx.input;
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
    // a typo like `setup provder` must not read as a successful `show`
    if (action && action !== "show") {
      return [err("setup", `unknown setup action '${action}' (expected provider | llm | show)`)];
    }
    // show
    return [makeRecord({ verb: "setup", format: "json", payload: { profile: profile }, state: "ready" })];
  },
};

// ---- provider (init/list/describe) -----------------------------------------

export const providerVerb: VerbSpec = {
  name: "provider",
  group: "config",
  summary: "Run a provider's init hook, or list/describe bound providers (provider init|list|describe).",
  description:
    "`provider init <verb>` runs the bound provider's init step — a command, or guidance for a skill-based " +
    "init (skill loading lands in Phase 7). `provider list` shows the active bindings.",
  args: [
    { name: "action", summary: "init | list | describe", required: true },
    { name: "verb", summary: "verb whose provider to init/describe" },
  ],
  flags: [
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "provider",
  providerKey: "provider",
  run: async (ctx) => {
    const action = ctx.input;
    const providers = ctx.profile.providers ?? {};
    if (action === "list") {
      return [makeRecord({ verb: "provider", format: "json", payload: { providers }, state: "ready" })];
    }
    if (action !== "describe" && action !== "init") {
      return [err("provider", `unknown provider action '${action}' (expected init | list | describe)`)];
    }
    const verb = ctx.rest[0];
    if (!verb) return [err("provider", `usage: provider ${action} <verb>`)];
    const desc = providers[verb];
    if (!desc) return [err("provider", `no provider bound for '${verb}' (try \`setup provider ${verb} <spec>\`)`)];

    if (action === "describe") {
      if (desc.describe) {
        const parts = tokenizeCommand(desc.describe);
        const res = await execCapture(parts[0], parts.slice(1), { signal: ctx.signal, timeoutMs: 60_000 }).catch((e) => ({ code: 1, stdout: "", stderr: (e as Error).message }));
        return [makeRecord({ verb: "provider", format: "json", payload: { verb, describe: res.stdout || res.stderr }, state: res.code === 0 ? "ready" : "error" })];
      }
      return [makeRecord({ verb: "provider", format: "json", payload: { verb, descriptor: desc }, state: "ready" })];
    }

    // init
    const init = desc.init;
    if (!init) return [makeRecord({ verb: "provider", format: "json", payload: { verb, note: "no init step" }, state: "ready" })];
    if (typeof init === "object" && init.skill) {
      return [makeRecord({ verb: "provider", format: "json", payload: { verb, skill: init.skill, guidance: `init uses the '${init.skill}' skill; install/run it (skill auto-load lands in Phase 7)` }, state: "needs_credentials" })];
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
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "doctor",
  providerKey: "doctor",
  run: async (ctx) => {
    const checks: Check[] = [];

    // pinned pi (report the build's pinned version; not hardcoded to one release)
    checks.push({ name: "pi", ok: /^\d+\.\d+\.\d+$/.test(PI_VERSION), detail: `pinned ${PI_VERSION}` });

    // ffmpeg + ffprobe run
    for (const [label, bin] of [["ffmpeg", FFMPEG_PATH], ["ffprobe", FFPROBE_PATH]] as const) {
      const res = await execCapture(bin, ["-version"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      const first = (res.stdout.split("\n")[0] || "").slice(0, 60);
      checks.push({ name: label, ok: res.code === 0, detail: res.code === 0 ? first : "not runnable" });
    }

    // Cloudglue creds (brain provider)
    const cg = resolveCloudglue();
    checks.push({ name: "cloudglue", ok: Boolean(cg.apiKey), detail: cg.apiKey ? `key present, baseUrl ${cg.baseUrl}` : "no CLOUDGLUE_API_KEY / tinycloud config" });

    // tinycloud CLI (default sense backend)
    const tc = await execCapture("tinycloud", ["--version"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    checks.push({ name: "tinycloud", ok: tc.code === 0, detail: tc.code === 0 ? "CLI available" : "tinycloud CLI not on PATH" });

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
    if (!checks.find((c) => c.name === "tinycloud")?.ok && !hasCustomSense) {
      warnings.push("tinycloud CLI missing and no custom watch/listen provider bound — the default senses will fail");
    }
    if (!checks.find((c) => c.name === "cloudglue")?.ok) {
      warnings.push("no Cloudglue key — the default sense backend and the Cloudglue brain are unavailable");
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
