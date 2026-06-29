#!/usr/bin/env node
// overcast CLI entry. Dispatches the verb registry (version / commands / verbs)
// directly, and otherwise launches the pi TUI with the overcast extension
// attached (CLAUDE.md invariant #1: reuse pi's loop/TUI, don't fork).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runCli } from "../src/cli.js";
import { routeArgv } from "../src/cli-router.js";
import { loadDotEnv } from "../src/env.js";
import { resolveCloudglue } from "../src/profile.js";

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
  loadDotEnv(process.env.OVERCAST_CASE || process.cwd());
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
  prepareTuiEnv();
  ensureQuietStartup();
  clearScreen();
  // Dynamic import keeps pi out of the hot path for plain verb calls.
  const { main } = await import("@earendil-works/pi-coding-agent");
  const { default: overcastExtension } = await import("../src/extension/overcast.js");
  await main(piArgs, { extensionFactories: [overcastExtension] });
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  loadDotEnv(process.cwd());
  // The CLI-vs-TUI decision is a pure function (src/cli-router.ts, unit-tested as a
  // truth table). "cli" runs the verb registry; "tui" launches the pi agent (a bare
  // launch, `overcast --tui`, or a pi-flag invocation like `overcast -p "…"`).
  const { mode, cliArgv } = routeArgv(argv);
  if (mode === "cli") return runCli(cliArgv);
  await launchTui(argv);
  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`overcast: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
