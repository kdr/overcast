// CLI dispatch (one verb spec → CLI surface). Handles --version, commands --json,
// and direct verb execution (persist + print). Launching the pi TUI lives in
// bin/overcast.ts (dynamic import) so pure verb calls stay fast and pi-free.

import { versionInfo, OVERCAST_VERSION } from "./version.js";
import { VERBS, findVerb } from "./registry/verbs.js";
import { toJSON, type VerbContext, type VerbSpec } from "./registry/types.js";
import { parseVerbArgs, renderVerbHelp } from "./registry/to-cli.js";
import { openCase } from "./case.js";
import { loadProfile, type HomeOptions } from "./profile.js";
import { makeRecord, type OvercastRecord } from "./record.js";
import { renderForFormat } from "./render.js";
import { loadDotEnv } from "./env.js";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/** Extract global flags (--case/--home/--profile) and return the remainder. */
function extractGlobals(argv: string[]): {
  rest: string[];
  caseDir?: string;
  home?: string;
  profile?: string;
  errors: string[];
} {
  const rest: string[] = [];
  const errors: string[] = [];
  const values: Record<string, string> = {};
  const GLOBALS = ["--case", "--home", "--profile"];
  // Each global REQUIRES a value, supplied either as `--case /path` or the
  // attached `--case=/path` form. A missing value (end of argv or a following
  // flag) is an error — and we must NOT swallow that following flag.
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.indexOf("=");
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (!GLOBALS.includes(name)) {
      rest.push(t);
      continue;
    }
    if (eq >= 0) {
      const v = t.slice(eq + 1);
      if (v === "") errors.push(`${name} requires a value`);
      else values[name] = v;
    } else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        // leave the following token for normal parsing — don't advance i.
        errors.push(`${name} requires a value`);
      } else {
        values[name] = v;
        i++; // consume the value
      }
    }
  }
  return {
    rest,
    caseDir: values["--case"],
    home: values["--home"],
    profile: values["--profile"],
    errors,
  };
}

const GROUP_TITLES: Record<VerbSpec["group"], string> = {
  sense: "Senses",
  inspect: "Inspect",
  osint: "OSINT",
  read: "Read",
  state: "State",
  config: "Config",
};

// Environment variables overcast and its providers honor. The brain LLM is BYO
// via pi-ai, so EVERY pi-ai provider key works; exec/source/memory providers
// also inherit the full process environment (in addition to their own config
// files), so these reach provider scripts too.
const ENV_GROUPS: Array<{ title: string; vars: Array<[string, string]> }> = [
  {
    title: "overcast — default perception backend (tinycloud / Cloudglue)",
    vars: [
      ["CLOUDGLUE_API_KEY", "Cloudglue key for the default watch/listen/face/index backend + turnkey brain (else ~/.tinycloud/config.json)"],
      ["CLOUDGLUE_BASE_URL", "Cloudglue endpoint (default https://api.cloudglue.dev)"],
      ["OVERCAST_TINYCLOUD_CMD", "Override the tinycloud invocation for face/index/ask-index (a path or wrapper, e.g. a pinned binary)"],
      ["TINYCLOUD_HTTP_RETRIES / TINYCLOUD_UPLOAD_IDLE_TIMEOUT_MS / TINYCLOUD_JOB_WAIT_TIMEOUT_MS", "tinycloud 0.3.6 Cloudglue reliability knobs inherited by default providers"],
    ],
  },
  {
    title: "overcast — opt-in sense providers (bind via `setup provider <verb> <spec>`)",
    vars: [
      ["HF_TOKEN / HUGGING_FACE_HUB_TOKEN", "Hugging Face token — turnkey `see` (vision-LLM caption/OCR) + `enhance` (image upscale)"],
      ["HF_SEE_MODEL", "HF see model (default google/gemma-3-27b-it)"],
      ["HF_ENHANCE_IMAGE_MODEL / HF_ENHANCE_AUDIO_MODEL / HF_ENHANCE_ENDPOINT", "HF enhance model + router endpoint overrides"],
      ["FAL_KEY / FAL_API_KEY", "fal.ai key — see (florence-2), enhance image (esrgan) + audio (deepfilternet3)"],
      ["FAL_SEE_MODEL / FAL_ENHANCE_IMAGE_MODEL / FAL_ENHANCE_AUDIO_MODEL", "fal model overrides"],
      ["ELEVENLABS_API_KEY / XI_API_KEY", "ElevenLabs key — listen (Scribe STT) + enhance audio (voice isolation)"],
      ["ELEVENLABS_STT_MODEL", "ElevenLabs speech-to-text model (default scribe_v1)"],
    ],
  },
  {
    title: "overcast — case search backends",
    vars: [
      ["OVERCAST_QMD_CMD", "qmd command/wrapper for optional case-search backend (default qmd)"],
      ["OVERCAST_QMD_MODEL", "qmd embedding model for case-search backend (default embeddinggemma-300M-Q8_0)"],
    ],
  },
  {
    title: "overcast — OSINT source providers",
    vars: [
      ["TAVILY_API_KEY", "Tavily key for the `web` search source (preferred)"],
      ["BRAVE_API_KEY", "Brave Search key for the `web` source (fallback)"],
      ["APIFY_TOKEN", "Apify token for the `tiktok` source (enumerate); fetch uses yt-dlp"],
      ["OVERCAST_SOURCE_<TYPE>_CMD", "Override/add a source provider command (e.g. OVERCAST_SOURCE_YOUTUBE_CMD)"],
      ["(youtube source)", "needs yt-dlp on PATH — no API key"],
    ],
  },
  {
    title: "overcast — runtime / session",
    vars: [
      ["OVERCAST_HOME", "overcast home for profiles (default ~/.overcast)"],
      ["OVERCAST_CASE", "case directory for the session (set by the launcher from --case)"],
      ["OVERCAST_PROFILE", "active profile for the session (set by the launcher from --profile)"],
      ["OVERCAST_MEDIA_DIR", "(set by overcast) the media output dir passed to exec providers"],
      ["OVERCAST_NO_DOTENV", "Set 1 to disable automatic .env loading for isolated tests/runs"],
      ["OVERCAST_PI_ONLINE", "Set 1 to re-enable pi's startup update-check"],
      ["OVERCAST_MONITOR_MAX_PASSES", "cap on monitor --every passes (testing/scheduling)"],
      ["OVERCAST_E2E_LIVE", "Set 1 to run the gated live-Cloudglue e2e cases"],
    ],
  },
  {
    title: "brain LLM (BYO via pi-ai — any provider key works)",
    vars: [
      ["ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN", "Anthropic Claude"],
      ["OPENAI_API_KEY", "OpenAI"],
      ["GEMINI_API_KEY", "Google Gemini"],
      ["GROQ_API_KEY", "Groq"],
      ["XAI_API_KEY", "xAI Grok"],
      ["OPENROUTER_API_KEY", "OpenRouter"],
      ["DEEPSEEK_API_KEY", "DeepSeek"],
      ["MISTRAL_API_KEY", "Mistral"],
      ["TOGETHER_API_KEY / FIREWORKS_API_KEY / CEREBRAS_API_KEY", "hosted OSS"],
      ["AZURE_OPENAI_API_KEY (+ _BASE_URL/_RESOURCE_NAME/_API_VERSION)", "Azure OpenAI"],
      ["AWS_PROFILE / AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY / AWS_BEARER_TOKEN_BEDROCK (+ AWS_REGION)", "Amazon Bedrock"],
      ["CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID (+ _GATEWAY_ID)", "Cloudflare Workers AI / Gateway"],
      ["NVIDIA_API_KEY / MINIMAX_API_KEY / MOONSHOT_API_KEY / KIMI_API_KEY / ZAI_API_KEY / XIAOMI_API_KEY / AI_GATEWAY_API_KEY / OPENCODE_API_KEY / ANT_LING_API_KEY", "others"],
    ],
  },
  {
    title: "pi runtime",
    vars: [
      ["PI_CODING_AGENT_DIR", "pi agent config dir (default ~/.pi/agent)"],
      ["PI_CODING_AGENT_SESSION_DIR", "session storage dir"],
      ["PI_OFFLINE", "disable startup network ops"],
      ["PI_SKIP_VERSION_CHECK", "suppress the update notice (overcast sets this by default)"],
      ["PI_TELEMETRY", "override install telemetry"],
    ],
  },
];

/** Render the Environment Variables help section. */
export function renderEnvHelp(): string {
  const lines: string[] = ["Environment Variables:"];
  lines.push("  (the brain LLM is BYO — any pi-ai provider key works; exec/source/memory");
  lines.push("   providers also inherit the full environment, alongside their config files)");
  for (const g of ENV_GROUPS) {
    lines.push("", `  # ${g.title}`);
    for (const [name, desc] of g.vars) lines.push(`  ${name}`, `      ${desc}`);
  }
  return lines.join("\n");
}

/** Top-level `overcast --help`: the overcast surface (NOT pi's help). */
export function renderTopHelp(): string {
  const lines: string[] = [];
  lines.push(`overcast ${OVERCAST_VERSION} — senses (video/audio/image) + OSINT reach for any agent, built on pi`);
  lines.push("");
  lines.push("Usage:");
  lines.push("  overcast                      Launch the interactive overcast agent (TUI)");
  lines.push("  overcast <verb> [args] [--json]   Run a verb and emit record(s)");
  lines.push("  overcast -p \"<task>\" [--mode json]  Headless agent (one task, then exit)");
  lines.push("  overcast commands --json      Dump the verb registry (source of truth)");
  lines.push("  overcast --version [--json]   Version + pinned pi");
  lines.push("");
  const groups = new Map<VerbSpec["group"], VerbSpec[]>();
  for (const v of VERBS) {
    const a = groups.get(v.group) ?? [];
    a.push(v);
    groups.set(v.group, a);
  }
  for (const [group, title] of Object.entries(GROUP_TITLES) as [VerbSpec["group"], string][]) {
    const verbs = groups.get(group);
    if (!verbs || verbs.length === 0) continue;
    lines.push(`${title}:`);
    for (const v of verbs) lines.push(`  ${v.name.padEnd(12)} ${v.summary}`);
    lines.push("");
  }
  lines.push("Global flags:");
  lines.push("  --case <dir>     Operate on the case rooted at <dir> (default: cwd)");
  lines.push("  --home <dir>     overcast home for profiles (default: ~/.overcast)");
  lines.push("  --profile <name> Active profile (default: default)");
  lines.push("  --json           JSON output  ·  --format json|md|txt");
  lines.push("");
  lines.push(renderEnvHelp());
  lines.push("");
  lines.push("Run `overcast <verb> --help` for a verb's man page.");
  return lines.join("\n");
}

/** Run the CLI. Returns a process exit code. */
export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  // Global flags may appear anywhere — including before the verb
  // (`overcast --case /dir watch v.mp4`). Strip them up front, then treat the
  // first remaining token as the command.
  const { rest: tokens, caseDir, home, profile, errors: globalErrors } =
    extractGlobals(argv);
  loadDotEnv(caseDir ?? process.cwd(), { override: true });
  // A leading output flag before the verb (`overcast --json watch v.mp4`,
  // `overcast --format md commands`) is moved to AFTER the command, so tokens[0]
  // is the command and every handler (top-level commands/version + verb dispatch)
  // sees the flag via tokens.slice(1).
  const VALID_FORMATS = new Set(["json", "md", "txt"]);
  const leadFlags: string[] = [];
  while (
    tokens.length > 1 &&
    (tokens[0] === "--json" || tokens[0] === "--format" || tokens[0].startsWith("--format="))
  ) {
    const f = tokens.shift() as string;
    leadFlags.push(f);
    // space form: only pull --format's value when it's a REAL format; otherwise
    // the next token is the verb (`--format watch clip.mp4`), not the value. The
    // attached form (`--format=md`) already carries its value in the token.
    if (f === "--format" && tokens.length > 1 && VALID_FORMATS.has(tokens[0])) {
      leadFlags.push(tokens.shift() as string);
    }
  }
  if (leadFlags.length) tokens.push(...leadFlags);
  const cmd = tokens[0];

  // a malformed global with no command (e.g. `overcast --case`) is a global-flag
  // error (exit 2), not an `unknown command ''`.
  if (cmd === undefined && globalErrors.length) {
    for (const e of globalErrors) io.err(`overcast: ${e}\n`);
    return 2;
  }

  // top-level help (overcast's own — never pi's). Validate globals first so a
  // bad `--case`/`--home`/`--profile` is reported, consistent with verb dispatch.
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    if (globalErrors.length) {
      for (const e of globalErrors) io.err(`overcast: ${e}\n`);
      return 2;
    }
    io.out(renderTopHelp() + "\n");
    return 0;
  }

  // version — only when it's the command itself, so `overcast watch x -v` runs
  // the verb (and an unknown command with a stray -v still errors) rather than
  // printing the version for a `-v` anywhere in argv.
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const json = tokens.includes("--json");
    io.out(
      json
        ? JSON.stringify(versionInfo()) + "\n"
        : `overcast ${versionInfo().overcast} (pi ${versionInfo().pi})\n`,
    );
    return 0;
  }

  // commands --json: dump the registry (source of truth)
  if (cmd === "commands") {
    const json = tokens.includes("--json");
    const specs = VERBS.map(toJSON);
    if (json) {
      io.out(JSON.stringify({ verbs: specs }, null, 2) + "\n");
    } else {
      for (const s of specs) io.out(`${s.name.padEnd(12)} ${s.summary}\n`);
    }
    return 0;
  }

  // verb dispatch
  const spec = cmd ? findVerb(cmd) : undefined;
  if (spec) {
    // Validate globals before anything else (including --help): an invalid
    // global like a value-less `--case` is an error regardless.
    if (globalErrors.length) {
      for (const e of globalErrors) io.err(`overcast ${spec.name}: ${e}\n`);
      return 2;
    }
    const parsed = parseVerbArgs(spec, tokens.slice(1));
    if (parsed.help) {
      io.out(renderVerbHelp(spec));
      return 0;
    }
    if (parsed.errors.length) {
      for (const e of parsed.errors) io.err(`overcast ${spec.name}: ${e}\n`);
      return 2;
    }
    const homeOpts: HomeOptions = { home, profile };
    const c = openCase(caseDir ?? process.cwd());
    c.ensure();
    const ctx: VerbContext = {
      input: parsed.input,
      rest: parsed.rest,
      opts: parsed.opts,
      case: c,
      profile: loadProfile(homeOpts),
      home,
      profileName: profile,
    };

    let records: OvercastRecord[];
    try {
      records = await spec.run(ctx);
    } catch (e) {
      // Spawn failure / timeout / abort: persist an error record like provider
      // non-zero exits do, so the case store reflects the attempt.
      const rec = makeRecord({
        verb: spec.name,
        format: "json",
        payload: {},
        error: (e as Error).message,
        state: "error",
      });
      c.writeRecord(rec);
      io.err(`overcast ${spec.name}: ${(e as Error).message}\n`);
      return 1;
    }

    // persist into the active case, but skip a record explicitly tagged for a
    // different case (e.g. `case init <other-dir>` already wrote it there).
    // Transient records are user-facing control results, not case history.
    for (const rec of records) {
      if (rec.meta?.transient === true || rec.meta?.persisted === true) continue;
      if (rec.meta?.case && rec.meta.case !== c.dir) continue;
      c.writeRecord(rec);
    }

    const wantJson = parsed.opts.json === true || parsed.opts.format === "json";
    const format = wantJson ? "json" : (parsed.opts.format as string) ?? "human";
    for (const rec of records) io.out(renderForFormat(rec, format) + "\n");

    // state is the authoritative hint for the exit code: a hard error → 1, a
    // setup gap (needs_credentials) → 3 (distinct, so automation can tell "broke"
    // from "needs setup"); pending/ready → 0.
    if (records.some((r) => r.state === "error")) return 1;
    if (records.some((r) => r.state === "needs_credentials")) return 3;
    return 0;
  }

  // unknown command
  io.err(`overcast: unknown command '${cmd ?? ""}'\n`);
  return 1;
}
