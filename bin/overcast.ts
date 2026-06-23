#!/usr/bin/env node
// overcast CLI entry. Dispatches the verb registry (version / commands / verbs)
// directly, and otherwise launches the pi TUI with the overcast extension
// attached (CLAUDE.md invariant #1: reuse pi's loop/TUI, don't fork).

import { runCli } from "../src/cli.js";
import { findVerb } from "../src/registry/verbs.js";

const KNOWN_TOP = new Set(["version", "commands"]);

function isCliDispatch(argv: string[]): boolean {
  const cmd = argv[0];
  if (!cmd) return false;
  if (argv.includes("--version") || argv.includes("-v")) return true;
  if (KNOWN_TOP.has(cmd)) return true;
  if (findVerb(cmd)) return true;
  return false;
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
