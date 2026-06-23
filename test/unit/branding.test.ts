import { test } from "node:test";
import assert from "node:assert/strict";
import { colorizeBanner } from "../../src/extension/branding.ts";
import { renderTopHelp, runCli, type CliIO } from "../../src/cli.ts";
import { VERBS } from "../../src/registry/verbs.ts";

test("colorizeBanner applies theme ANSI and drops the pi // cloudglue tag", () => {
  const banner = [
    "        ╔═══════════╗",
    " ██████╗ ██╗",
    "        v i d e o · u n d e r s t a n d i n g   o s i n t",
    "              [ REC ● ]   v0.1.0",
  ].join("\n");
  const out = colorizeBanner(banner);
  assert.ok(out.includes("\x1b[38;2;0;255;127m"), "green present");
  assert.ok(out.includes("\x1b[38;2;255;196;0m"), "amber present (REC line)");
  assert.ok(out.includes("\x1b[38;2;255;85;85m"), "red dot present");
  assert.ok(!out.includes("pi //"), "no pi // cloudglue branding");
});

test("renderTopHelp is overcast's own help (not pi's) and lists every verb", () => {
  const help = renderTopHelp();
  assert.match(help, /^overcast .* built on pi/);
  assert.ok(!/AI coding assistant/.test(help), "must not be pi's help text");
  for (const v of VERBS) assert.ok(help.includes(v.name), `help missing verb ${v.name}`);
  assert.match(help, /Launch the interactive overcast agent/);
});

test("runCli handles --help / -h / help as overcast top-level help (exit 0)", async () => {
  for (const arg of ["--help", "-h", "help"]) {
    let out = "";
    const io: CliIO = { out: (s) => (out += s), err: () => {} };
    const code = await runCli([arg], io);
    assert.equal(code, 0, `${arg} exit`);
    assert.match(out, /senses .* OSINT reach/);
  }
});
