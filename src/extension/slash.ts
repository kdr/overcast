// Register overcast state verbs as TUI slash commands (/target /source /case
// /prebrief /view /setup). Each runs the verb against the cwd case and shows the
// emitted record. (/ask /brief are prompt templates loaded from prompts/.)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { findVerb } from "../registry/verbs.js";
import { parseVerbArgs } from "../registry/to-cli.js";
import { tokenizeCommand } from "../providers/sources/index.js";
import { openCase } from "../case.js";
import { loadProfile, resolveHome } from "../profile.js";
import type { OvercastRecord } from "../record.js";
import { renderRecord } from "../render.js";
import type { VerbContext } from "../registry/types.js";

const SLASH_VERBS = ["target", "source", "case", "prebrief", "view", "setup"];
const RESULT_TYPE = "overcast-result";

function summarize(rec: OvercastRecord): string {
  // shared magnitude-aware preview (same renderer as the agent tool + CLI)
  return `▶ ${renderRecord(rec, { mode: "preview" })}`;
}

/** Register the state slash-commands + the custom result renderer. */
export function registerSlashCommands(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<{ text: string }>(RESULT_TYPE, (message, _opts, _theme): Component | undefined => {
    const text = (message.details?.text as string) ?? "";
    return new Text(text);
  });

  for (const name of SLASH_VERBS) {
    const spec = findVerb(name);
    if (!spec) continue;
    pi.registerCommand(name, {
      description: spec.summary,
      handler: async (args: string): Promise<void> => {
        // tokenize like the shell CLI so quoted multi-word values survive
        // (e.g. /case memory search "white van") instead of splitting on spaces.
        const argv = args.trim() ? tokenizeCommand(args.trim()) : [];
        const parsed = parseVerbArgs(spec, argv);
        if (parsed.errors.length) {
          pi.appendEntry(RESULT_TYPE, { text: `▶ ${name}: ${parsed.errors.join("; ")}` });
          return;
        }
        // honor the session case + profile (--case/--profile, surfaced via env)
        // so slash-driven verbs use the same .overcast/ store and profile as the
        // agent tools in this session.
        const c = openCase(process.env.OVERCAST_CASE || process.cwd());
        c.ensure();
        const profileName = process.env.OVERCAST_PROFILE || "default";
        const ctx: VerbContext = {
          input: parsed.input,
          rest: parsed.rest,
          opts: parsed.opts,
          case: c,
          profile: loadProfile({ profile: profileName }),
          home: resolveHome(),
          profileName,
        };
        try {
          const recs = await spec.run(ctx);
          // skip a record tagged for a different case (already persisted there),
          // matching the CLI / agent-tool persist guards.
          for (const r of recs) {
            if (r.meta?.case && r.meta.case !== c.dir) continue;
            c.writeRecord(r);
          }
          pi.appendEntry(RESULT_TYPE, { text: recs.map(summarize).join("\n\n") || `▶ ${name}: (no records)` });
        } catch (e) {
          pi.appendEntry(RESULT_TYPE, { text: `▶ ${name} failed: ${(e as Error).message}` });
        }
      },
    });
  }
}
