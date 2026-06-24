#!/usr/bin/env node
// overcast CLI entry. Phase 0: --version. Later phases dispatch the verb
// registry (see src/registry) and otherwise launch the pi TUI.

import { versionInfo, OVERCAST_VERSION, PI_VERSION } from "../src/version.js";

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main(argv: string[]): Promise<number> {
  const json = hasFlag(argv, "--json");

  // The leading non-flag token (if any) is the subcommand. Version flags only
  // apply when there is no subcommand, so `overcast notacommand -v` still
  // reports the unknown command rather than printing the version.
  const command = argv.find((a) => !a.startsWith("-"));

  // --version / version
  if (
    command === "version" ||
    (command === undefined && (hasFlag(argv, "--version") || hasFlag(argv, "-v")))
  ) {
    if (json) {
      process.stdout.write(JSON.stringify(versionInfo()) + "\n");
    } else {
      process.stdout.write(`overcast ${OVERCAST_VERSION} (pi ${PI_VERSION})\n`);
    }
    return 0;
  }

  if (argv[0] === "--help" || argv[0] === "-h" || argv.length === 0) {
    process.stdout.write(
      [
        `overcast ${OVERCAST_VERSION} — senses + OSINT for any agent, built on pi`,
        "",
        "Usage: overcast <verb> [args] [--json]",
        "       overcast --version [--json]",
        "",
        "(verb registry wired in Phase 1+)",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // report the actual subcommand token (the leading non-flag arg), not argv[0]
  // which could be a leading flag like `--json`.
  process.stderr.write(`overcast: unknown command '${command ?? argv[0]}'\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`overcast: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
