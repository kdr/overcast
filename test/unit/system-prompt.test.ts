import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../src/extension/system-prompt.ts";

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
