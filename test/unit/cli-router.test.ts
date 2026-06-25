// Truth table for the CLI-vs-TUI router. Each row is a case Bugbot found (or could
// find) one at a time — locking the whole `--tui`/`-p`/`--json`/`--format`/`-h`/`-v`
// precedence matrix so a routing edge can't regress silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeArgv, effectiveCmd } from "../../src/cli-router.ts";

// [argv, expected mode, expected effective command (optional)]
const TABLE: Array<[string[], "cli" | "tui", string | undefined]> = [
  // bare / TUI launches
  [[], "tui", undefined],
  [["--tui"], "tui", undefined],
  [["-p", "hello"], "tui", "-p"], // pi headless prompt
  [["-p", "hi", "--version"], "tui", "-p"], // version NOT the effective cmd → pi
  [["-p", "hi", "-h"], "tui", "-p"],
  [["--case", "/dir"], "tui", undefined], // globals-only → launch TUI in that case

  // version / help (ours)
  [["--version"], "cli", "--version"],
  [["-v"], "cli", "-v"],
  [["--help"], "cli", "--help"],
  [["-h"], "cli", "-h"],
  [["--tui", "--version"], "cli", "--version"], // wins over --tui
  [["--tui", "--help"], "cli", "--help"],

  // known top + verbs
  [["commands"], "cli", "commands"],
  [["version"], "cli", "version"],
  [["watch", "clip.mp4"], "cli", "watch"],
  [["watch", "clip.mp4", "--tui"], "cli", "watch"], // explicit verb wins over --tui
  [["--tui", "watch", "clip.mp4"], "cli", "watch"],
  [["bogusverb"], "cli", "bogusverb"], // mistyped → CLI ("unknown command")

  // output flags before the verb
  [["--json", "commands"], "cli", "commands"],
  [["--json", "watch", "x"], "cli", "watch"],
  [["--json"], "cli", undefined], // output-flag-only → CLI (reports error)
  [["--format", "md", "commands"], "cli", "commands"],
  [["--format", "md"], "cli", undefined],
  [["--format", "watch", "clip.mp4"], "cli", "watch"], // bad fmt value → next token is the verb
  [["--format=md", "commands"], "cli", "commands"], // attached
  [["--format=md", "watch", "x"], "cli", "watch"],

  // leading globals
  [["--case", "/dir", "watch", "y"], "cli", "watch"],
  [["--profile", "p", "watch", "x"], "cli", "watch"],
  [["--case=/dir", "watch", "x"], "cli", "watch"],
  [["--case"], "cli", undefined], // malformed (value-less) global → CLI error
  [["--case="], "cli", undefined], // malformed attached global → CLI error
];

test("CLI-vs-TUI routing truth table", () => {
  for (const [argv, mode, cmd] of TABLE) {
    const r = routeArgv(argv);
    assert.equal(r.mode, mode, `route ${JSON.stringify(argv)} → expected ${mode}, got ${r.mode}`);
    if (cmd !== undefined) {
      assert.equal(
        effectiveCmd(r.cliArgv),
        cmd,
        `effectiveCmd ${JSON.stringify(argv)} → expected '${cmd}'`,
      );
    }
    // --tui is always stripped from what the CLI sees
    assert.ok(!r.cliArgv.includes("--tui"), `cliArgv should not contain --tui for ${JSON.stringify(argv)}`);
  }
});
