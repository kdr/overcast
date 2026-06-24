#!/usr/bin/env node
// overcast CLI entry. Dispatches the verb registry (version / commands / verbs)
// directly, and otherwise launches the pi TUI with the overcast extension
// attached (CLAUDE.md invariant #1: reuse pi's loop/TUI, don't fork).

import { runCli } from "../src/cli.js";
import { findVerb } from "../src/registry/verbs.js";
import { resolveCloudglue } from "../src/profile.js";

const KNOWN_TOP = new Set(["version", "commands", "help"]);
const GLOBAL_FLAGS = new Set(["--case", "--home", "--profile"]);

/** The effective command token — the first arg after any leading global flags. */
function effectiveCmd(argv: string[]): string | undefined {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (!GLOBAL_FLAGS.has(name)) break;
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

/** overcast's own help/version — these win even over --tui. */
function isHelpOrVersionCmd(argv: string[]): boolean {
  const cmd = effectiveCmd(argv);
  return (
    cmd === "--help" || cmd === "-h" || cmd === "help" ||
    cmd === "--version" || cmd === "-v" || cmd === "version"
  );
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
  // a value-less leading global (`overcast --case`) is a CLI error, not a TUI launch
  if (!cmd) return hasMalformedGlobal(argv);
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

async function launchTui(argv: string[]): Promise<void> {
  prepareTuiEnv();
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

  // overcast's own long-form --help/--version win everywhere — even mixed with
  // --tui (`overcast --tui --help`, `overcast --tui --version`) or pi flags — and
  // pi never sees them. The SHORT -h/-v are ambiguous (they're also pi flags), so
  // they only count as ours via isCliDispatch when they are the effective command
  // token (`overcast -h`), NOT when buried among pi flags (`overcast -p "…" -h`).
  if (argv.includes("--help") || argv.includes("--version")) {
    return runCli(cliArgv);
  }

  // --tui forces the agent, EXCEPT overcast's own --version, which wins.
  if (isCliDispatch(argv) && (!argv.includes("--tui") || isHelpOrVersionCmd(argv))) {
    return runCli(cliArgv);
  }

  // no verb (or --tui): launch the interactive overcast agent.
  await launchTui(argv);
  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`overcast: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
