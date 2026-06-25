import { test } from "node:test";
import assert from "node:assert/strict";
import { generateVerbReference, generateFlagshipSkill, generateInitSkill } from "../../src/skill-gen.ts";
import { VERBS } from "../../src/registry/verbs.ts";

test("verb reference is generated from the registry — every verb appears", () => {
  const ref = generateVerbReference();
  for (const v of VERBS) {
    assert.ok(ref.includes(`### \`overcast ${v.name}\``), `reference missing ${v.name}`);
    assert.ok(ref.includes(`Emits \`${v.outputKind}\``), `reference missing ${v.name} outputKind`);
  }
  // grouped sections present
  assert.match(ref, /## Senses/);
  assert.match(ref, /## OSINT/);
  assert.match(ref, /## Read/);
});

test("flagship SKILL.md has valid front-matter + lists the verbs", () => {
  const skill = generateFlagshipSkill();
  assert.match(skill, /^---\nname: overcast\ndescription:/);
  assert.match(skill, /reference\/verbs\.md/);
  // a few representative verbs in the cheatsheet
  for (const name of ["watch", "scan", "ask"]) {
    assert.ok(skill.includes(`\`${name}\``), `skill cheatsheet missing ${name}`);
  }
});

test("overcast-init skill covers install + doctor + Cloudglue key", () => {
  const init = generateInitSkill();
  assert.match(init, /name: overcast-init/);
  assert.match(init, /doctor/);
  assert.match(init, /CLOUDGLUE_API_KEY/);
});

test("reference stays in sync with commands --json (same verb set)", () => {
  const ref = generateVerbReference();
  const names = VERBS.map((v) => v.name);
  // the count of generated man pages equals the registry size
  const headings = ref.match(/^### `overcast /gm) ?? [];
  assert.equal(headings.length, names.length);
});

import { skillsVerb } from "../../src/verbs/skills.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("skills verb: generate/install succeed in the source repo, unknown action errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-sk-"));
  try {
    const c = openCase(dir); c.ensure();
    const mk = (input: string, opts = {}) => ({ input, rest: [], opts, case: c, profile: defaultProfile() });
    const [gen] = await skillsVerb.run(mk("generate"));
    assert.equal(gen.state, "ready"); // package skills/ is writable from source
    const [bad] = await skillsVerb.run(mk("frobnicate"));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /usage: skills/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
