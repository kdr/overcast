#!/usr/bin/env node
// overcast CLI entry. Dispatches the verb registry (version / commands / verbs)
// directly, and otherwise launches the pi TUI with the overcast extension
// attached (CLAUDE.md invariant #1: reuse pi's loop/TUI, don't fork).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runCli } from "../src/cli.js";
import { findVerb } from "../src/registry/verbs.js";
import { resolveCloudglue } from "../src/profile.js";

const KNOWN_TOP = new Set(["version", "commands", "help"]);
const GLOBAL_FLAGS = new Set(["--case", "--home", "--profile"]);
// overcast's own value-taking leading flags (skipped to find the verb) and the
// boolean output flag — so `overcast --json watch …` / `--format md watch …`
// dispatch the verb instead of treating --json/--format as the command.
const LEADING_VALUE_FLAGS = new Set(["--case", "--home", "--profile", "--format"]);
const LEADING_BOOL_FLAGS = new Set(["--json"]);

/** The effective command token — the first arg after any leading global/output flags. */
function effectiveCmd(argv: string[]): string | undefined {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (LEADING_BOOL_FLAGS.has(name)) { i += 1; continue; } // boolean flag: skip just it
    if (!LEADING_VALUE_FLAGS.has(name)) break;
    if (t.includes("=")) {
      i += 1; // attached form: flag only
    } else {
      // space form: consume the value only if it isn't itself a flag — a
      // value-less global is malformed and must surface (reach the CLI), not be
      // swallowed so the command token disappears and the TUI launches.
      const v = argv[i + 1];
      i += v !== undefined && !v.startsWith("-") ? 2 : 1;
    }
  }
  return argv[i];
}

/** True if a leading global flag is present but missing its value — a malformed
 *  CLI invocation that should reach runCli to report the error, not the TUI. */
function hasMalformedGlobal(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.includes("=");
    const name = eq ? t.slice(0, t.indexOf("=")) : t;
    if (!GLOBAL_FLAGS.has(name)) return false; // stop at the first non-global
    if (eq) {
      if (t.slice(t.indexOf("=") + 1) === "") return true; // `--case=`
    } else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) return true; // value-less
      i++; // skip the consumed value
    }
  }
  return false;
}

function isCliDispatch(argv: string[]): boolean {
  // Global flags may lead the invocation (`overcast --case /dir watch …`).
  // Skip them (and their values) to find the effective command token.
  const cmd = effectiveCmd(argv);
  // No command after the leading flags. Route to the CLI (to report the error) for
  // a value-less global (`overcast --case`) OR an output-flag-only invocation
  // (`overcast --json` / `--format md`) — those are meaningless without a verb.
  // A globals-only invocation (`overcast --case /dir`) falls through to launch the
  // TUI in that case.
  if (!cmd) {
    if (hasMalformedGlobal(argv)) return true;
    return argv.some((a) => {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      return LEADING_BOOL_FLAGS.has(name) || name === "--format";
    });
  }
  // A version request is CLI only when it is the command itself, so headless
  // pi usage like `overcast -p "…" -v` still launches the agent.
  if (cmd === "--version" || cmd === "-v") return true;
  // `overcast --help`/`-h` is OUR help, not pi's (only as the effective command).
  if (cmd === "--help" || cmd === "-h") return true;
  if (KNOWN_TOP.has(cmd)) return true;
  if (findVerb(cmd)) return true;
  // A leading non-flag token is a command — route mistyped verbs to the CLI so
  // it reports "unknown command" instead of silently launching the TUI.
  if (!cmd.startsWith("-")) return true;
  return false; // leading pi flag (e.g. -p) → TUI
}

/** Pull a global flag's value (`--name v` or `--name=v`) out of argv. A missing
 *  or flag-like value is left untouched (not swallowed). */
function takeGlobal(argv: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === name) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("-")) {
        value = v;
        i++;
      }
    } else if (t.startsWith(`${name}=`)) {
      value = t.slice(name.length + 1);
    } else {
      rest.push(t);
    }
  }
  return { value, rest };
}

/**
 * Make the overcast TUI turnkey before handing off to pi:
 *  - resolve the Cloudglue key (env or ~/.tinycloud/config.json) into
 *    CLOUDGLUE_API_KEY so the registered Cloudglue provider has models (no
 *    /login dance, fixes "No models available" / "no default model").
 *  - suppress pi's startup update-check; overcast pins pi (invariant), so a
 *    "pi update available" notice is noise. We set the TARGETED skip flag (not
 *    full PI_OFFLINE) so model availability / runtime network is untouched.
 *    Opt back in with OVERCAST_PI_ONLINE=1.
 */
function prepareTuiEnv(): void {
  if (!process.env.CLOUDGLUE_API_KEY) {
    const { apiKey } = resolveCloudglue();
    if (apiKey) process.env.CLOUDGLUE_API_KEY = apiKey;
  }
  if (!process.env.PI_SKIP_VERSION_CHECK && process.env.OVERCAST_PI_ONLINE !== "1") {
    process.env.PI_SKIP_VERSION_CHECK = "1";
  }
}

/** Default pi's `quietStartup` on (hide the [Context]/[Prompts]/[Extensions]/
 *  [Themes] resource listing on every launch). pi exposes no flag/option/extension
 *  API for this — only a settings.json key — so we seed it ONCE in the agent
 *  settings, and never override an explicit user choice (set it false to opt back in). */
function ensureQuietStartup(): void {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const file = join(agentDir, "settings.json");
    const settings: Record<string, unknown> = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
      : {};
    if (settings.quietStartup === undefined) {
      settings.quietStartup = true;
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
    }
  } catch {
    /* best-effort; the listing just stays visible */
  }
}

/** Clear the terminal (and scrollback) so the overcast banner starts at the top,
 *  free of shell prompt / `npm run dev` output above it. */
function clearScreen(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

async function launchTui(argv: string[]): Promise<void> {
  prepareTuiEnv();
  ensureQuietStartup();
  clearScreen();
  // Dynamic import keeps pi out of the hot path for plain verb calls.
  const { main } = await import("@earendil-works/pi-coding-agent");
  const { default: overcastExtension } = await import("../src/extension/overcast.js");
  // Surface --case/--profile/--home to the extension (via env) so agent-driven
  // verbs use the session's case/profile, then drop them from pi's args.
  let piArgs = argv.filter((a) => a !== "--tui");
  for (const [flag, envVar] of [
    ["--case", "OVERCAST_CASE"],
    ["--profile", "OVERCAST_PROFILE"],
    ["--home", "OVERCAST_HOME"],
  ] as const) {
    const { value, rest } = takeGlobal(piArgs, flag);
    if (value) process.env[envVar] = value;
    piArgs = rest;
  }
  await main(piArgs, { extensionFactories: [overcastExtension] });
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  // --tui is a TUI-only routing flag; the CLI never needs to see it.
  const cliArgv = argv.filter((a) => a !== "--tui");

  // Route to the CLI iff the EFFECTIVE command (first token after leading globals)
  // is a registered verb, a known top command, or a help/version token — computed
  // on the --tui-stripped argv. This single rule covers every case correctly:
  //   overcast --version / --help / -h / -v / commands   → CLI
  //   overcast --tui --version / --tui watch …           → CLI (verb/flag wins over --tui)
  //   overcast watch clip.mp4 --tui                       → CLI (explicit verb wins)
  //   overcast -p "…" --version / -p "…" -h               → TUI (a pi-flag invocation;
  //                                                          --help/--version aren't the
  //                                                          effective command, so they
  //                                                          DON'T hijack pi)
  if (isCliDispatch(cliArgv)) {
    return runCli(cliArgv);
  }

  // no command to dispatch (a bare launch, `overcast --tui`, or a pi-flag
  // invocation like `overcast -p "…"`): launch the interactive overcast agent.
  await launchTui(argv);
  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`overcast: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
