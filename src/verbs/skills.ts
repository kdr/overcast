// `skills` verb: generate the flagship skill + reference from the registry, and
// install skills into a harness (Claude Code). Keeps the skill docs in sync with
// the verb surface (invariant #5).

import { writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { makeRecord } from "../record.js";
import {
  generateVerbReference,
  generateFlagshipSkill,
  generateInitSkill,
} from "../skill-gen.js";
import type { VerbSpec } from "../registry/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/verbs/skills.js → package root two up; skills/ ships at the root.
const PKG_ROOT = resolve(HERE, "..", "..");
const SKILLS_DIR = join(PKG_ROOT, "skills");

/** Write the generated skill files into the repo's skills/ tree. */
function generateSkills(): string[] {
  const written: string[] = [];
  const flagshipDir = join(SKILLS_DIR, "overcast");
  const refDir = join(flagshipDir, "reference");
  mkdirSync(refDir, { recursive: true });
  const flagship = join(flagshipDir, "SKILL.md");
  writeFileSync(flagship, generateFlagshipSkill(), "utf8");
  written.push(flagship);
  const ref = join(refDir, "verbs.md");
  writeFileSync(ref, generateVerbReference(), "utf8");
  written.push(ref);

  const initDir = join(SKILLS_DIR, "overcast-init");
  mkdirSync(initDir, { recursive: true });
  const initSkill = join(initDir, "SKILL.md");
  writeFileSync(initSkill, generateInitSkill(), "utf8");
  written.push(initSkill);
  return written;
}

/** Install the skills into a harness's skills directory. */
function installSkills(harness: string): { dest: string; copied: string[] } {
  // Claude Code project skills live in ./.claude/skills; user skills in
  // ~/.claude/skills. Default to the user dir (works outside a project).
  const dest =
    harness === "claude-code"
      ? join(homedir(), ".claude", "skills")
      : join(homedir(), ".overcast", "skills");
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const name of ["overcast", "overcast-init"]) {
    const src = join(SKILLS_DIR, name);
    if (existsSync(src)) {
      cpSync(src, join(dest, name), { recursive: true });
      copied.push(name);
    }
  }
  return { dest, copied };
}

export const skillsVerb: VerbSpec = {
  name: "skills",
  group: "config",
  summary: "Generate the flagship overcast skill + reference from the registry, or install into a harness.",
  description:
    "`skills generate` (re)writes skills/overcast/{SKILL.md,reference/verbs.md} and skills/overcast-init " +
    "from the verb registry. `skills install [--harness claude-code]` copies them into the harness skills dir.",
  args: [{ name: "action", summary: "generate | install", required: true }],
  flags: [
    { name: "harness", summary: "Target harness for install (claude-code)", type: "string" },
    { name: "json", summary: "JSON output", type: "boolean" },
    { name: "format", summary: "json | md | txt", type: "string", choices: ["json", "md", "txt"] },
  ],
  outputKind: "skills",
  providerKey: "skills",
  run: async (ctx) => {
    const action = ctx.input;
    if (action === "generate") {
      const written = generateSkills();
      return [makeRecord({ verb: "skills", format: "json", payload: { generated: written }, state: "ready" })];
    }
    if (action === "install") {
      // ensure the skills exist (generate if missing), then copy
      if (!existsSync(join(SKILLS_DIR, "overcast", "SKILL.md"))) generateSkills();
      const harness = ctx.opts.harness ? String(ctx.opts.harness) : "claude-code";
      const { dest, copied } = installSkills(harness);
      return [makeRecord({ verb: "skills", format: "json", payload: { harness, dest, installed: copied }, state: "ready" })];
    }
    return [makeRecord({ verb: "skills", format: "json", payload: { error: "usage: skills generate|install" }, error: "unknown action", state: "error" })];
  },
};
