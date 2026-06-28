import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../../src/extension/system-prompt.ts";
import { openCase } from "../../src/case.ts";
import { emptySetup, saveSetup } from "../../src/state/setup.ts";

test("agent system prompt teaches the index/search lifecycle", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /overcast ask "\.\.\."/);
  assert.match(prompt, /overcast ask "\.\.\." --deep/);
  assert.match(prompt, /case memory index rebuild --memory qmd/);
  assert.match(prompt, /overcast index attach <id-or-name>/);
  assert.match(prompt, /do not create a note just\s+to track an index binding/);
  assert.match(prompt, /index add <video> --to <id>/);
  assert.match(prompt, /create missing `watch` evidence/);
  assert.match(prompt, /Do not run face detection just\s+to populate local-grep or qmd case search/);
});

test("agent system prompt hides setup hint after completed setup", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-prompt-"));
  const prev = process.env.OVERCAST_CASE;
  try {
    const c = openCase(dir);
    c.ensure();
    process.env.OVERCAST_CASE = dir;
    assert.match(buildSystemPrompt(), /overcast case setup/);

    const setup = emptySetup(c.info().name);
    setup.completed = true;
    saveSetup(c, setup);
    assert.doesNotMatch(buildSystemPrompt(), /First-run case setup/);
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
