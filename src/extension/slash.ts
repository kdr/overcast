// Register common overcast verbs as TUI slash commands (/target /source /index /case
// /prebrief /view /setup /provider /finding). Each runs the verb against the cwd case and shows the
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
import { renderForFormat, renderRecord } from "../render.js";
import type { VerbContext } from "../registry/types.js";
import { maybeScheduleCaseClearReset } from "./case-clear-reset.js";

const SLASH_VERBS = ["target", "source", "index", "case", "prebrief", "view", "wall", "setup", "provider", "finding"];
const RESULT_TYPE = "overcast-result";

function summarize(rec: OvercastRecord, format?: string): string {
  // same format-aware renderer as the CLI, so /case memory get … --format txt
  // shows a paged chunk in full instead of a truncated preview
  if (!format && rec.meta?.transient === true) {
    return `▶ ${renderRecord(rec, { mode: "full", force: true })}`;
  }
  return `▶ ${renderForFormat(rec, format)}`;
}

function emitResult(pi: ExtensionAPI, text: string): void {
  pi.sendMessage(
    {
      customType: RESULT_TYPE,
      content: text,
      display: true,
      details: { text },
    },
    { triggerTurn: false },
  );
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
          emitResult(pi, `▶ ${name}: ${parsed.errors.join("; ")}`);
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
            if (r.meta?.transient === true) continue;
            if (r.meta?.persisted === true) continue;
            if (r.meta?.case && r.meta.case !== c.dir) continue;
            c.writeRecord(r);
          }
          // honor --json/--format like the CLI (so a paged chunk isn't truncated)
          const fmt = parsed.opts.json ? "json" : (parsed.opts.format as string | undefined);
          emitResult(pi, recs.map((r) => summarize(r, fmt)).join("\n\n") || `▶ ${name}: (no records)`);
          if (name === "case") maybeScheduleCaseClearReset(recs);
        } catch (e) {
          emitResult(pi, `▶ ${name} failed: ${(e as Error).message}`);
        }
      },
    });
  }
}
