import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateVerbReference,
  generateFlagshipSkill,
  generateInitSkill,
  generateSkillCreatorSkill,
  generateMediaBugTriageSkill,
  generateReconBriefSkill,
  generateVisualTargetSearchSkill,
  generateCopycatSweepSkill,
} from "../../src/skill-gen.ts";
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

const generatedSkills = [
  {
    name: "overcast-skill-creator",
    body: generateSkillCreatorSkill,
    verbs: ["case setup", "watch", "listen", "see", "face", "scan", "capture", "monitor", "note", "finding", "ask", "brief"],
  },
  {
    name: "overcast-media-bug-triage",
    body: generateMediaBugTriageSkill,
    verbs: ["doctor", "case init", "case setup", "watch", "listen", "see", "note", "ask", "brief"],
  },
  {
    name: "overcast-recon-brief",
    body: generateReconBriefSkill,
    verbs: ["doctor", "case init", "case setup", "scan", "monitor", "finding", "ask", "brief"],
  },
  {
    name: "overcast-visual-target-search",
    body: generateVisualTargetSearchSkill,
    verbs: ["doctor", "case init", "face", "crop", "see", "index", "image", "ask", "brief"],
  },
  {
    name: "overcast-copycat-sweep",
    body: generateCopycatSweepSkill,
    verbs: ["doctor", "case init", "case setup", "watch", "index", "image", "scan", "capture", "face", "listen", "finding", "note", "ask", "brief", "monitor"],
  },
];

test("new shipped skills have valid front-matter and reference focused verbs", () => {
  for (const skill of generatedSkills) {
    const body = skill.body();
    assert.match(body, new RegExp(`^---\\nname: ${skill.name}\\ndescription: >-`), `${skill.name} frontmatter`);
    assert.match(body, /\n---\n\n# /, `${skill.name} closes frontmatter`);
    assert.match(body, /overcast\/reference\/verbs\.md/, `${skill.name} links reference`);
    for (const verb of skill.verbs) {
      assert.ok(body.includes(verb), `${skill.name} missing ${verb}`);
    }
  }
});

test("overcast-skill-creator teaches cases, citations, and progressive disclosure", () => {
  const skill = generateSkillCreatorSkill();
  assert.match(skill, /case lifecycle/);
  assert.match(skill, /record\.id/);
  assert.match(skill, /media\.at/);
  assert.match(skill, /case memory get/);
  assert.match(skill, /Do not duplicate the\s+full verb reference/);
  assert.match(skill, /overcast\/reference\/verbs\.md/);
});

test("generated workflow setup examples confirm persisted case setup", () => {
  for (const skill of generatedSkills) {
    const body = skill.body();
    const setupLines = body.match(/^overcast case setup(?! (?:plan|edit|status|show)\b).*$/gm) ?? [];
    for (const line of setupLines) {
      assert.match(line, / --yes\b/, `${skill.name} setup example must persist with --yes: ${line}`);
    }
  }
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
