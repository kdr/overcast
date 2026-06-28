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
import { PI_VERSION } from "../version.js";
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
    { name: "action", summary: "provider | llm | memory | show", required: true },
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
    return [makeRecord({ verb: "setup", format: "json", payload: { profile: profile }, state: "ready" })];
  },
};

// ---- provider (init/list/describe) -----------------------------------------

export const providerVerb: VerbSpec = {
  name: "provider",
  group: "config",
  summary: "Run a provider's init hook, or list/describe bound providers (provider init|list|describe).",
  description:
    "`provider init <verb>` runs the bound provider's init step — a command, or guidance for a " +
    "skill-based init (not wired yet). `provider list` shows the active bindings.",
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
