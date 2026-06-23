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

/**
 * Resolve the package root (where `skills/` ships). The built bundle lives at
 * dist/bin/overcast.js, so the repo/package root is two levels up. In a
 * `bun --compile` binary `import.meta.url` is a virtual `/$bunfs/...` path that
 * doesn't map to a real dir — detect that and report no package context so the
 * verb fails cleanly instead of trying to mkdir `/skills`.
 */
function resolvePackageRoot(): string | undefined {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  // bun compiled binaries expose a virtual filesystem mount
  if (here.includes("$bunfs") || here.startsWith("/$") || here === "/") return undefined;
  const root = resolve(here, "..", "..");
  // a real package root has a package.json
  return existsSync(join(root, "package.json")) ? root : undefined;
}

const PKG_ROOT = resolvePackageRoot();
const SKILLS_DIR = PKG_ROOT ? join(PKG_ROOT, "skills") : undefined;

/** Write the generated skill files into the repo's skills/ tree (source-repo only). */
function generateSkills(skillsDir: string): string[] {
  const written: string[] = [];
  const flagshipDir = join(skillsDir, "overcast");
  const refDir = join(flagshipDir, "reference");
  mkdirSync(refDir, { recursive: true });
  const flagship = join(flagshipDir, "SKILL.md");
  writeFileSync(flagship, generateFlagshipSkill(), "utf8");
  written.push(flagship);
  const ref = join(refDir, "verbs.md");
  writeFileSync(ref, generateVerbReference(), "utf8");
  written.push(ref);

  const initDir = join(skillsDir, "overcast-init");
  mkdirSync(initDir, { recursive: true });
  const initSkill = join(initDir, "SKILL.md");
  writeFileSync(initSkill, generateInitSkill(), "utf8");
  written.push(initSkill);
  return written;
}

/** Install the SHIPPED skills into a harness's skills directory. */
function installSkills(skillsDir: string, harness: string): { dest: string; copied: string[] } {
  // Claude Code project skills live in ./.claude/skills; user skills in
  // ~/.claude/skills. Default to the user dir (works outside a project).
  const dest =
    harness === "claude-code"
      ? join(homedir(), ".claude", "skills")
      : join(homedir(), ".overcast", "skills");
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const name of ["overcast", "overcast-init"]) {
    const src = join(skillsDir, name);
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
    const fail = (msg: string) =>
      [makeRecord({ verb: "skills", format: "json", payload: { error: msg }, error: msg, state: "error" })];

    if (action === "generate") {
      // a source-repo command: it rewrites the committed skills/ from the
      // registry. Not meaningful from a bun binary or an installed package.
      if (!SKILLS_DIR) {
        return fail("skills generate is a source-repo command (no writable package skills/ dir in this distribution)");
      }
      try {
        const written = generateSkills(SKILLS_DIR);
        return [makeRecord({ verb: "skills", format: "json", payload: { generated: written }, state: "ready" })];
      } catch (e) {
        return fail(`skills generate failed (is the package writable?): ${(e as Error).message}`);
      }
    }

    if (action === "install") {
      // copy the SHIPPED skills/ into the harness dir. The npm package ships a
      // generated skills/ tree; the bun binary does not embed it.
      if (!SKILLS_DIR || !existsSync(join(SKILLS_DIR, "overcast", "SKILL.md"))) {
        return fail("no shipped skills/ in this distribution (install the npm package, or run from source)");
      }
      const harness = ctx.opts.harness ? String(ctx.opts.harness) : "claude-code";
      try {
        const { dest, copied } = installSkills(SKILLS_DIR, harness);
        return [makeRecord({ verb: "skills", format: "json", payload: { harness, dest, installed: copied }, state: "ready" })];
      } catch (e) {
        return fail(`skills install failed: ${(e as Error).message}`);
      }
    }

    return fail("usage: skills generate|install");
  },
};
