// Class-D guard: catch doc-vs-impl REFERENCE drift — a command/subcommand named in
// the docs that the registry doesn't actually have (e.g. the removed `setup use`).
// Only inspects backtick'd code spans (not prose), so it's low-false-positive. It
// can't catch behavior claims (a flag's documented effect) — those still need
// review — but it locks the mechanizable half.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERBS, findVerb } from "../../src/registry/verbs.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { setupVerb, providerVerb } from "../../src/verbs/setup.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import type { VerbContext, OvercastRecord } from "../../src/registry/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_FILES = [
  "README.md",
  "CLAUDE.md",
  "docs/providers.md",
  "prompts/ask.md",
  "prompts/brief.md",
  "examples/profiles/install-profiles.sh",
].map((f) => join(ROOT, f));

const KNOWN_TOP = new Set(["version", "commands", "help"]);
const validVerb = (v: string) => KNOWN_TOP.has(v) || findVerb(v) !== undefined;

// Only the multi-action verbs check their subcommand; derive the valid actions
// from the impl (run with a bogus action and parse the error) so the lint can't
// drift from the code.
function ctx(dir: string, input: string): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest: [], opts: {}, case: c, profile: defaultProfile(), home: dir, profileName: "default" };
}
async function actionsOf(dir: string, run: (c: VerbContext) => Promise<OvercastRecord[]>): Promise<Set<string>> {
  const [rec] = await run(ctx(dir, "__bogus__"));
  const e = String(rec?.error ?? "");
  const m = e.match(/expected ([a-z |]+)\)/) ?? e.match(/<([a-z|]+)>/);
  return new Set((m ? m[1] : "").split(/[|,]/).map((s) => s.trim()).filter(Boolean));
}

// concatenate only the inline-code + fenced-code spans (skip prose)
function codeOnly(md: string): string {
  return [...(md.match(/`[^`\n]+`/g) ?? []), ...(md.match(/```[\s\S]*?```/g) ?? [])].join("\n");
}

test("every `overcast <verb> [<subcommand>]` in the docs exists in the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-docref-"));
  try {
    const actions: Record<string, Set<string>> = {
      setup: await actionsOf(dir, (c) => setupVerb.run(c)),
      provider: await actionsOf(dir, (c) => providerVerb.run(c)),
      case: await actionsOf(dir, (c) => caseVerb.run(c)),
    };
    // sanity: the derivation worked
    assert.ok(actions.setup.has("provider"), "could not derive setup actions");

    const problems: string[] = [];
    for (const file of DOC_FILES) {
      if (!existsSync(file)) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      // "overcast" as a COMMAND, not a path tail (`dist/bin/overcast`) — exclude a
      // preceding path/word char.
      for (const m of code.matchAll(/(?<![\w/.-])overcast\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
        const [, verb, sub] = m;
        if (!validVerb(verb)) {
          problems.push(`${file}: \`overcast ${verb}\` — not a registered verb`);
          continue;
        }
        if (sub && actions[verb] && actions[verb].size && !actions[verb].has(sub)) {
          problems.push(`${file}: \`overcast ${verb} ${sub}\` — '${sub}' is not a ${verb} action (${[...actions[verb]].join("|")})`);
        }
      }
    }
    assert.deepEqual(problems, [], `doc references drifted from the implementation:\n${problems.join("\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
