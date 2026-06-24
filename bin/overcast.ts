#!/usr/bin/env node
// overcast CLI entry. Dispatches the verb registry (version / commands / verbs)
// directly, and otherwise launches the pi TUI with the overcast extension
// attached (CLAUDE.md invariant #1: reuse pi's loop/TUI, don't fork).

import { runCli } from "../src/cli.js";
import { findVerb } from "../src/registry/verbs.js";

const KNOWN_TOP = new Set(["version", "commands"]);
const GLOBAL_FLAGS = new Set(["--case", "--home", "--profile"]);

function isCliDispatch(argv: string[]): boolean {
  // Global flags may lead the invocation (`overcast --case /dir watch …`).
  // Skip them (and their values) to find the effective command token.
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (!GLOBAL_FLAGS.has(name)) break;
    i += t.includes("=") ? 1 : 2; // attached form: flag only; space form: flag + value
  }
  const cmd = argv[i];
  if (!cmd) return false; // only globals / no args → launch the TUI
  // A version request is CLI only when it is the command itself, so headless
  // pi usage like `overcast -p "…" -v` still launches the agent.
  if (cmd === "--version" || cmd === "-v") return true;
  if (KNOWN_TOP.has(cmd)) return true;
  if (findVerb(cmd)) return true;
  // A leading non-flag token is a command — route mistyped verbs to the CLI so
  // it reports "unknown command" instead of silently launching the TUI.
  if (!cmd.startsWith("-")) return true;
  return false; // leading pi flag (e.g. -p) → TUI
}

async function launchTui(argv: string[]): Promise<void> {
  // Dynamic import keeps pi out of the hot path for plain verb calls.
  const { main } = await import("@earendil-works/pi-coding-agent");
  const { default: overcastExtension } = await import("../src/extension/overcast.js");
  const piArgs = argv.filter((a) => a !== "--tui");
  await main(piArgs, { extensionFactories: [overcastExtension] });
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);

  if (isCliDispatch(argv) && !argv.includes("--tui")) {
    return runCli(argv);
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
