// Generate a pi AgentTool (ToolDefinition) from a VerbSpec (one spec → tool
// surface). The tool returns a SPLIT result: a compact text summary to the LLM
// (content) + the full records in `details` for the UI/session.
//
// This is the ONLY pi touch-point for verbs besides the extension, so a pi bump
// has a small blast radius (CLAUDE.md "verifying changes").

import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { VerbSpec, VerbContext, FlagSpec } from "./types.js";
import { makeRecord, type OvercastRecord } from "../record.js";
import type { Case } from "../case.js";
import type { Profile } from "../profile.js";

export interface ToolDeps {
  /** resolve the active case (cwd-based) at call time */
  getCase: () => Case;
  /** resolve the active profile at call time */
  getProfile: () => Profile;
  /** resolve the active overcast home (for config-writing verbs) */
  getHome?: () => string | undefined;
  /** the active profile name */
  getProfileName?: () => string | undefined;
}

function flagSchema(f: FlagSpec): TSchema {
  const desc = { description: f.summary };
  if (f.type === "boolean") return Type.Optional(Type.Boolean(desc));
  if (f.type === "number") return Type.Optional(Type.Number(desc));
  if (f.choices && f.choices.length) {
    return Type.Optional(
      Type.Union(
        f.choices.map((c) => Type.Literal(c)),
        desc,
      ),
    );
  }
  return Type.Optional(Type.String(desc));
}

/** Build the TypeBox params object for a verb (all positional args + flags). */
export function verbParams(spec: VerbSpec): TSchema {
  const props: Record<string, TSchema> = {};
  for (const arg of spec.args) {
    const s = Type.String({ description: arg.summary });
    props[arg.name] = arg.required ? s : Type.Optional(s);
  }
  for (const f of spec.flags) props[f.name] = flagSchema(f);
  return Type.Object(props);
}

/** A short, LLM-facing summary line for a record. */
function summarizeRecord(rec: OvercastRecord): string {
  const head = `${rec.id} [${rec.verb}] state=${rec.state ?? "ready"}`;
  if (rec.error) return `${head} error=${rec.error}`;
  if (typeof rec.payload === "string") {
    const oneLine = rec.payload.replace(/\s+/g, " ").slice(0, 200);
    return `${head} :: ${oneLine}`;
  }
  const keys = Object.keys(rec.payload);
  return `${head} payload{${keys.join(",")}}`;
}

/**
 * Convert a VerbSpec into a pi ToolDefinition. The execute() persists every
 * emitted record to the case store and returns a split result.
 */
export function toAgentTool(spec: VerbSpec, deps: ToolDeps): ToolDefinition {
  return {
    name: spec.name,
    label: spec.name,
    description: `${spec.summary}${spec.description ? "\n\n" + spec.description : ""}`,
    parameters: verbParams(spec),
    execute: async (_toolCallId, params: Record<string, unknown>, signal) => {
      const c = deps.getCase();
      c.ensure();
      const opts: VerbContext["opts"] = {};
      for (const f of spec.flags) {
        if (params[f.name] !== undefined)
          opts[f.name] = params[f.name] as string | number | boolean;
      }
      // reconstruct positional input + rest from the declared args
      const positionals: string[] = [];
      for (const arg of spec.args) {
        if (params[arg.name] !== undefined) positionals.push(String(params[arg.name]));
      }
      const input = positionals[0];

      const ctx: VerbContext = {
        input,
        rest: positionals.slice(1),
        opts,
        case: c,
        profile: deps.getProfile(),
        home: deps.getHome?.(),
        profileName: deps.getProfileName?.(),
        signal,
      };

      let records: OvercastRecord[];
      try {
        records = await spec.run(ctx);
      } catch (err) {
        // persist an error record like the CLI does, so agent-driven failures
        // don't diverge from CLI case history.
        c.writeRecord(
          makeRecord({
            verb: spec.name,
            format: "json",
            payload: {},
            error: (err as Error).message,
            state: "error",
          }),
        );
        const text = `overcast ${spec.name} failed: ${(err as Error).message}`;
        return {
          content: [{ type: "text", text }],
          details: { error: true, message: (err as Error).message },
        };
      }

      // skip a record explicitly tagged for a different case (already persisted
      // there) — e.g. `case init <other-dir>`.
      for (const rec of records) {
        if (rec.meta?.case && rec.meta.case !== c.dir) continue;
        c.writeRecord(rec);
      }

      const summary = records.map(summarizeRecord).join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              records.length === 0
                ? `overcast ${spec.name}: no records emitted`
                : `overcast ${spec.name} emitted ${records.length} record(s):\n${summary}`,
          },
        ],
        details: { records },
      };
    },
  };
}
