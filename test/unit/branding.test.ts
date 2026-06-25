import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OvercastHeader, workingIndicator, OvercastFooter, opLabel, idleLabel } from "../../src/extension/branding.ts";
import { renderTopHelp, runCli, type CliIO } from "../../src/cli.ts";
import { VERBS } from "../../src/registry/verbs.ts";

const BANNER = readFileSync(fileURLToPath(new URL("../../assets/banner.txt", import.meta.url)), "utf8");
const headerOpts = { banner: BANNER, version: "0.0.1", contextFile: "CLAUDE.md", tools: 18, model: "tinycloud:advanced" };
const setStart = (h: OvercastHeader, msAgo: number) => {
  (h as unknown as { start: number }).start = Date.now() - msAgo;
};

test("OvercastHeader: settled frame paints the synthwave gradient + recording-deck HUD", () => {
  const h = new OvercastHeader(null, headerOpts);
  setStart(h, 4000); // well past the boot reveal
  const out = h.render(140).join("\n");
  h.dispose();
  assert.ok(out.includes("\x1b[38;2;0;255;127m"), "gradient top = neon green");
  assert.ok(out.includes("\x1b[38;2;0;229;255m"), "gradient bottom = cyan");
  assert.ok(out.includes("\x1b[38;2;255;46;151m"), "magenta REC/accent present");
  assert.match(out, /REC .*v0\.0\.1/, "deck shows REC + version");
  assert.match(out, /\[[^\]]*OK[^\]]*\][^\n]*CLAUDE\.md/, "bracket OK tag for context file");
  assert.match(out, /\[[^\]]*18[^\]]*\][^\n]*tools/, "bracket tools tag");
  assert.ok(out.includes("tinycloud:advanced"), "model in status");
  // tagline centered under the wordmark (indented well past the source's 8)
  const tagLine = out.split("\n").find((l) => l.includes("o s i n t")) ?? "";
  const lead = (tagLine.match(/^ */) ?? [""])[0].length;
  assert.ok(lead >= 10, `tagline centered under the wordmark (lead=${lead})`);
});

test("OvercastHeader: boot frame hides the status until the decrypt reveal finishes", () => {
  const h = new OvercastHeader(null, headerOpts);
  setStart(h, 40); // first moments of the reveal
  const out = h.render(140).join("\n");
  h.dispose();
  assert.ok(!out.includes("tinycloud:advanced"), "status fades in only after the reveal");
  assert.ok(out.includes("REC"), "deck readout is shown immediately");
});

test("opLabel: rotates a verb's hacker-movie variations, with a fallback", () => {
  const seen = new Set([opLabel("scan"), opLabel("scan"), opLabel("scan"), opLabel("scan")]);
  assert.ok(seen.size >= 2, "scan rotates through variations");
  for (const s of seen) assert.ok(s.endsWith("…"), "labels end with …");
  assert.equal(opLabel("weird-unmapped"), "weird-unmapped…"); // graceful fallback
});

test("idleLabel: cycles iconic phrases, never pi's default 'Working'", () => {
  const a = idleLabel();
  const b = idleLabel();
  assert.ok(a.length > 0 && !/Working/.test(a), "themed, not the default");
  assert.notEqual(a, b, "rotates between calls");
});

test("workingIndicator: animated ASCII table-flip frames (verbatim, colored)", () => {
  const wi = workingIndicator();
  assert.ok(wi.frames.length >= 2, "animated");
  assert.ok(wi.intervalMs > 0, "has an interval");
  const joined = wi.frames.join("");
  assert.ok(joined.includes("┻━┻"), "the flipped table appears");
  assert.ok(joined.includes("╯°□°"), "the rage face appears");
  assert.ok(joined.includes("\x1b[38;2;255;85;85m"), "red rage frame");
});

test("OvercastFooter renders a justified case · tok · ctx% · model · think line", () => {
  const f = new OvercastFooter(() => ({ caseName: "shadowport", tokens: 12400, ctxPercent: 6, model: "tinycloud:advanced", thinking: "medium" }));
  const [line] = f.render(100);
  assert.match(line, /case:\/\/.*shadowport/);
  assert.match(line, /12\.4k tok/);
  assert.match(line, /ctx .*6%/);
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
