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
  generateLineupSkill,
  generateStakeoutSkill,
  generateSceneLocateSkill,
  generateEnhanceAndResolveSkill,
  generateWiretapSkill,
  generateProvenanceSkill,
  generateTimelineSkill,
  generateCrimeBoardSkill,
  generatePinpointSkill,
  generateFrameGridSkill,
  generateEventBisectSkill,
  generateWhereSkill,
  generatePresenceWindowSkill,
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
  {
    name: "overcast-lineup",
    body: generateLineupSkill,
    verbs: ["doctor", "case init", "index", "cluster", "finding", "note", "brief"],
  },
  {
    name: "overcast-stakeout",
    body: generateStakeoutSkill,
    verbs: ["doctor", "case init", "case setup", "monitor", "finding", "wall", "brief"],
  },
  {
    name: "overcast-scene-locate",
    body: generateSceneLocateSkill,
    verbs: ["doctor", "case init", "exif", "watch", "see", "crop", "scan", "note", "finding", "brief"],
  },
  {
    name: "overcast-enhance-and-resolve",
    body: generateEnhanceAndResolveSkill,
    verbs: ["doctor", "case init", "watch", "note", "enhance", "see", "crop", "finding", "brief"],
  },
  {
    name: "overcast-wiretap",
    body: generateWiretapSkill,
    verbs: ["doctor", "case init", "listen", "view", "enhance", "note", "ask", "finding", "brief"],
  },
  {
    name: "overcast-provenance",
    body: generateProvenanceSkill,
    verbs: ["doctor", "case init", "verify", "exif", "watch", "index", "image", "scan", "capture", "listen", "finding", "note", "brief"],
  },
  {
    name: "overcast-timeline",
    body: generateTimelineSkill,
    verbs: ["doctor", "case init", "watch", "listen", "note", "ask", "finding", "brief"],
  },
  {
    name: "overcast-crime-board",
    body: generateCrimeBoardSkill,
    verbs: ["doctor", "face", "crop", "see", "index", "cluster", "similar", "note", "brief", "wall"],
  },
  {
    name: "overcast-pinpoint",
    body: generatePinpointSkill,
    verbs: ["doctor", "case init", "watch", "grid", "see", "similar", "ask", "note", "view", "brief"],
  },
  {
    name: "overcast-frame-grid",
    body: generateFrameGridSkill,
    verbs: ["doctor", "case init", "grid", "see", "note", "brief"],
  },
  {
    name: "overcast-event-bisect",
    body: generateEventBisectSkill,
    verbs: ["doctor", "case init", "watch", "see", "note", "view", "brief"],
  },
  {
    name: "overcast-where",
    body: generateWhereSkill,
    verbs: ["see", "crop", "enhance", "finding", "face", "brief"],
  },
  {
    name: "overcast-presence-window",
    body: generatePresenceWindowSkill,
    verbs: ["doctor", "case init", "watch", "face", "grid", "see", "note", "view", "brief"],
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

test("verb reference does not duplicate long verb descriptions inside help blocks", () => {
  const ref = generateVerbReference();
  const skills = VERBS.find((v) => v.name === "skills");
  assert.ok(skills?.description);
  const occurrences = ref.split(skills.description).length - 1;
  assert.equal(occurrences, 1);
});

import { skillsVerb } from "../../src/verbs/skills.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

test("skills verb: --dest installs shipped skills into an explicit directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-sk-case-"));
  const dest = mkdtempSync(join(tmpdir(), "oc-sk-dest-"));
  const otherDest = mkdtempSync(join(tmpdir(), "oc-sk-dest-harness-"));
  const emptyHarnessDest = mkdtempSync(join(tmpdir(), "oc-sk-dest-empty-harness-"));
  try {
    const c = openCase(dir); c.ensure();
    const mk = (input: string, opts = {}) => ({ input, rest: [], opts, case: c, profile: defaultProfile() });
    const [rec] = await skillsVerb.run(mk("install", { dest }));
    assert.equal(rec.state, "ready");
    const payload = rec.payload as { dest?: string; harness?: string; installed?: string[] };
    assert.equal(payload.dest, dest);
    assert.equal(payload.harness, undefined);
    assert.ok((payload.installed?.length ?? 0) >= 20);
    assert.ok(existsSync(join(dest, "overcast", "SKILL.md")));
    assert.ok(existsSync(join(dest, "overcast-init", "SKILL.md")));
    assert.equal(readdirSync(dest).filter((name) => name.startsWith("overcast")).length, payload.installed?.length);

    const [withHarness] = await skillsVerb.run(mk("install", { dest: otherDest, harness: "unknown-agent" }));
    assert.equal(withHarness.state, "ready");
    assert.equal((withHarness.payload as { harness?: string }).harness, "unknown-agent");

    const [emptyHarness] = await skillsVerb.run(mk("install", { dest: emptyHarnessDest, harness: "" }));
    assert.equal(emptyHarness.state, "ready");
    const emptyHarnessPayload = emptyHarness.payload as { dest?: string; harness?: string; installed?: string[] };
    assert.equal(emptyHarnessPayload.dest, emptyHarnessDest);
    assert.equal(emptyHarnessPayload.harness, undefined);
    assert.ok((emptyHarnessPayload.installed?.length ?? 0) >= 20);

    const [badHarness] = await skillsVerb.run(mk("install", { harness: "unknown-agent" }));
    assert.equal(badHarness.state, "error");
    assert.match(badHarness.error ?? "", /unknown harness/);

    for (const emptyDest of ["", "   "]) {
      const [badDest] = await skillsVerb.run(mk("install", { dest: emptyDest }));
      assert.equal(badDest.state, "error");
      assert.match(badDest.error ?? "", /--dest requires a non-empty directory/);
      assert.doesNotMatch(badDest.error ?? "", /unknown harness/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    rmSync(otherDest, { recursive: true, force: true });
    rmSync(emptyHarnessDest, { recursive: true, force: true });
  }
});
