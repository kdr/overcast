import { test } from "node:test";
import assert from "node:assert/strict";
import { colorizeBanner, statusLine, headerText, OvercastFooter } from "../../src/extension/branding.ts";
import { renderTopHelp, runCli, type CliIO } from "../../src/cli.ts";
import { VERBS } from "../../src/registry/verbs.ts";

test("colorizeBanner: two-tone green wordmark, amber play box with red triangle", () => {
  const banner = [
    "        ╔═══════════╗",
    "        ║    ▶ ▮▮   ║",
    " ██████╗ ██╗",
    "        v i d e o · u n d e r s t a n d i n g   o s i n t",
  ].join("\n");
  const out = colorizeBanner(banner);
  assert.ok(out.includes("\x1b[38;2;0;255;127m"), "bright green (block face) present");
  assert.ok(out.includes("\x1b[38;2;31;157;87m"), "dim green (extrusion) present");
  assert.ok(out.includes("\x1b[38;2;255;196;0m"), "amber (play box) present");
  assert.ok(out.includes("\x1b[38;2;255;85;85m"), "red play triangle present");
  assert.ok(!out.includes("pi //"), "no pi // cloudglue branding");
});

test("statusLine joins parts (skipping empties) with a leading marker", () => {
  const s = statusLine(["CLAUDE.md loaded", "", "17 verbs", "model: x"]);
  assert.match(s, /▶/);
  assert.match(s, /CLAUDE\.md loaded/);
  assert.match(s, /17 verbs/);
  assert.equal(statusLine([]), "");
});

test("headerText appends the status line under the banner", () => {
  assert.equal(headerText("BANNER", ""), "BANNER");
  assert.equal(headerText("BANNER", "STATUS"), "BANNER\nSTATUS");
});

test("OvercastFooter renders a justified case · tok · ctx% · model · think line", () => {
  const f = new OvercastFooter(() => ({ caseName: "shadowport", tokens: 12400, ctxPercent: 6, model: "tinycloud:advanced", thinking: "medium" }));
  const [line] = f.render(100);
  assert.match(line, /case:\/\/.*shadowport/);
  assert.match(line, /12\.4k tok/);
  assert.match(line, /ctx 6%/);
  assert.match(line, /think:medium/);
  // null tokens render as an em-dash, not NaN
  const g = new OvercastFooter(() => ({ caseName: "c", tokens: null, ctxPercent: null, model: "m", thinking: "off" }));
  assert.match(g.render(80)[0], /— tok/);
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

import { renderEnvHelp } from "../../src/cli.ts";

test("renderEnvHelp lists BYO brain keys + overcast/perception + pi runtime vars", () => {
  const env = renderEnvHelp();
  // overcast/perception + sources
  for (const v of ["CLOUDGLUE_API_KEY", "APIFY_TOKEN", "OVERCAST_HOME", "OVERCAST_SOURCE_<TYPE>_CMD"]) assert.ok(env.includes(v), `env help missing ${v}`);
  // BYO brain keys (a representative sample)
  for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"]) assert.ok(env.includes(v), `env help missing ${v}`);
  // pi runtime
  assert.ok(env.includes("PI_CODING_AGENT_DIR"));
  assert.match(env, /providers also inherit the full environment/);
});
