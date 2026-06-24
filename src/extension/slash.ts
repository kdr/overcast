// Register overcast state verbs as TUI slash commands (/target /source /case
// /prebrief /view /setup). Each runs the verb against the cwd case and shows the
// emitted record. (/ask /brief are prompt templates loaded from prompts/.)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { findVerb } from "../registry/verbs.js";
import { parseVerbArgs } from "../registry/to-cli.js";
import { openCase } from "../case.js";
import { loadProfile, resolveHome } from "../profile.js";
import type { OvercastRecord } from "../record.js";
import type { VerbContext } from "../registry/types.js";

const SLASH_VERBS = ["target", "source", "case", "prebrief", "view", "setup"];
const RESULT_TYPE = "overcast-result";

function summarize(rec: OvercastRecord): string {
  const head = `▶ ${rec.verb} · ${rec.state ?? "ready"}${rec.id ? ` · ${rec.id}` : ""}`;
  if (rec.error) return `${head}\n  error: ${rec.error}`;
  if (typeof rec.payload === "string") return `${head}\n  ${rec.payload.slice(0, 600)}`;
  const p = rec.payload as Record<string, unknown>;
  const body = Object.entries(p)
    .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v.slice(0, 160) : JSON.stringify(v).slice(0, 160)}`)
    .join("\n");
  return `${head}\n${body}`;
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
        const argv = args.trim() ? args.trim().split(/\s+/) : [];
        const parsed = parseVerbArgs(spec, argv);
        if (parsed.errors.length) {
          pi.appendEntry(RESULT_TYPE, { text: `▶ ${name}: ${parsed.errors.join("; ")}` });
          return;
        }
        const c = openCase(process.cwd());
        c.ensure();
        const ctx: VerbContext = {
          input: parsed.input,
          rest: parsed.rest,
          opts: parsed.opts,
          case: c,
          profile: loadProfile(),
          home: resolveHome(),
          profileName: "default",
        };
        try {
          const recs = await spec.run(ctx);
          for (const r of recs) c.writeRecord(r);
          pi.appendEntry(RESULT_TYPE, { text: recs.map(summarize).join("\n\n") || `▶ ${name}: (no records)` });
        } catch (e) {
          pi.appendEntry(RESULT_TYPE, { text: `▶ ${name} failed: ${(e as Error).message}` });
        }
      },
    });
  }
}
