// `skills` verb: generate the flagship skill + reference from the registry, and
// install skills into a harness (Claude Code). Keeps the skill docs in sync with
// the verb surface (invariant #5).

import { writeFileSync, mkdirSync, existsSync, cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { makeRecord } from "../record.js";
import {
  generateVerbReference,
  generateFlagshipSkill,
  generateInitSkill,
  generateSkillCreatorSkill,
  generateMediaBugTriageSkill,
  generateReconBriefSkill,
  generateVisualTargetSearchSkill,
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
  // Walk up looking for the package root (package.json), rather than assuming a
  // fixed depth — the bundle may live at dist/bin/, dist/, src/verbs/, etc.
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, "package.json");
    // Skip the minimal `dist/bin/package.json` sidecar that `build:bun` drops
    // next to the compiled binary for pi branding — it has no `dependencies`,
    // so it would otherwise shadow the real package root for skills/shippedPath.
    if (existsSync(pj) && isRealPackage(pj)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** A real overcast package.json declares dependencies; the bun branding sidecar
 *  ({ name, version, piConfig }) does not. */
function isRealPackage(pkgJsonPath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      dependencies?: unknown;
      files?: unknown;
    };
    return pkg.dependencies != null || pkg.files != null;
  } catch {
    return false;
  }
}

const PKG_ROOT = resolvePackageRoot();
const SKILLS_DIR = PKG_ROOT ? join(PKG_ROOT, "skills") : undefined;
const SHIPPED_SKILLS = [
  "overcast",
  "overcast-init",
  "overcast-skill-creator",
  "overcast-media-bug-triage",
  "overcast-recon-brief",
  "overcast-visual-target-search",
] as const;

/** Harnesses `skills install` knows how to target. */
const HARNESS_DESTS: Record<string, string> = {
  "claude-code": join(homedir(), ".claude", "skills"),
};

/** Is `root` a checked-out source tree (vs an installed/`node_modules` copy)?
 *  `skills generate` must only rewrite the committed skills/, never a package. */
function isSourceTree(root: string | undefined): boolean {
  if (!root) return false;
  if (root.split(/[\\/]/).includes("node_modules")) return false;
  return existsSync(join(root, "src")) && existsSync(join(root, "tsconfig.json"));
}

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

  const focusedSkills: Array<[string, () => string]> = [
    ["overcast-skill-creator", generateSkillCreatorSkill],
    ["overcast-media-bug-triage", generateMediaBugTriageSkill],
    ["overcast-recon-brief", generateReconBriefSkill],
    ["overcast-visual-target-search", generateVisualTargetSearchSkill],
  ];
  for (const [name, generate] of focusedSkills) {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    const skill = join(dir, "SKILL.md");
    writeFileSync(skill, generate(), "utf8");
    written.push(skill);
  }
  return written;
}

/** Install the SHIPPED skills into a harness's skills directory. Returns the
 *  destination, what was copied, and any expected skills that were missing. */
function installSkills(
  skillsDir: string,
  dest: string,
): { dest: string; copied: string[]; missing: string[] } {
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  const missing: string[] = [];
  for (const name of SHIPPED_SKILLS) {
    const src = join(skillsDir, name);
    if (existsSync(src)) {
      cpSync(src, join(dest, name), { recursive: true });
      copied.push(name);
    } else {
      missing.push(name);
    }
  }
  return { dest, copied, missing };
}

export const skillsVerb: VerbSpec = {
  name: "skills",
  group: "config",
  summary: "Generate shipped overcast skills + reference from the registry, or install into a harness.",
  description:
    "`skills generate` (re)writes shipped skills including skills/overcast/{SKILL.md,reference/verbs.md}, skills/overcast-init, and focused workflow examples " +
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
      // registry. Not meaningful from a bun binary or an installed package
      // (which would rewrite the shipped skills/ inside node_modules).
      if (!SKILLS_DIR || !isSourceTree(PKG_ROOT)) {
        return fail("skills generate is a source-repo command (run it from a checked-out overcast tree, not an installed package or the compiled binary)");
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
      const harnessDest = HARNESS_DESTS[harness];
      // an unknown harness must not be silently redirected to a default dir
      if (!harnessDest) {
        return fail(`unknown harness '${harness}' (supported: ${Object.keys(HARNESS_DESTS).join(", ")})`);
      }
      try {
        const { dest, copied, missing } = installSkills(SKILLS_DIR, harnessDest);
        // a partial install (e.g. overcast-init missing) is not a success
        if (missing.length) {
          return [makeRecord({ verb: "skills", format: "json", payload: { harness, dest, installed: copied, missing }, error: `partial install — missing skill(s): ${missing.join(", ")}`, state: "error" })];
        }
        return [makeRecord({ verb: "skills", format: "json", payload: { harness, dest, installed: copied }, state: "ready" })];
      } catch (e) {
        return fail(`skills install failed: ${(e as Error).message}`);
      }
    }

    return fail("usage: skills generate|install");
  },
};
