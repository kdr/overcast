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
  assert.match(prompt, /run `overcast finding create <text> --ref <record-id> --at <span> --target <target>` right away/);
  assert.match(prompt, /Do not substitute `note` for confirmed evidence/);
  assert.match(prompt, /If direct TikTok sensing fails/);
});

test("agent system prompt hides setup hint after completed setup", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-prompt-"));
  const prev = process.env.OVERCAST_CASE;
  try {
    const c = openCase(dir);
    c.ensure();
    process.env.OVERCAST_CASE = dir;
    assert.match(buildSystemPrompt(), /overcast case setup/);
    assert.match(buildSystemPrompt(), /This case has not been set up yet/);
    assert.match(buildSystemPrompt(), /Do not ask all setup questions at once/);
    assert.match(buildSystemPrompt(), /Ask exactly one setup question at a time/);
    assert.match(buildSystemPrompt(), /source type options/);
    assert.match(buildSystemPrompt(), /choose exactly one\s+local case-search backend/);
    assert.match(buildSystemPrompt(), /not optional/);
    assert.match(buildSystemPrompt(), /`local-grep` by default/);
    assert.match(buildSystemPrompt(), /`qmd` when the user wants configured local semantic memory/);
    assert.match(buildSystemPrompt(), /`note`, `watch`, `listen`, `see`, and `scan`/);
    assert.match(buildSystemPrompt(), /remote tinycloud-backed collections/);
    assert.match(buildSystemPrompt(), /Do not offer `rich-transcripts`/);
    assert.match(buildSystemPrompt(), /indexing has started\/queued/);
    assert.match(buildSystemPrompt(), /run `overcast case setup plan/);

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
