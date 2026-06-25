// Generate a pi AgentTool (ToolDefinition) from a VerbSpec (one spec → tool
// surface). The tool returns a SPLIT result: a compact text summary to the LLM
// (content) + the full records in `details` for the UI/session.
//
// This is the ONLY pi touch-point for verbs besides the extension, so a pi bump
// has a small blast radius (CLAUDE.md "verifying changes").

import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { VerbSpec, VerbContext, FlagSpec } from "./types.js";
import { makeRecord, type OvercastRecord, type JsonMap } from "../record.js";
import { renderRecord, pageCommand } from "../render.js";
import type { Case } from "../case.js";
import type { Profile } from "../profile.js";

// How many payload bytes to inline into the LLM-facing tool result before
// falling back to a preview + a "page it" pointer. Small results (ask answers,
// scan hits, doctor checks) inline whole; only big fields (a watch `content`
// timeline) preview — which is the whole point: the agent never again sees only
// `payload{content,transcript,detailed}` and has to bash its own output back.
const AGENT_BUDGET = 8000;

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

/** A `case memory get --field` page slice — always shown in full (the agent
 *  asked for exactly that slice). Matched on the page record's signature, not a
 *  bare `chunk` key, so a verb payload that merely has a `chunk` field isn't
 *  forced inline. */
function isPageChunk(rec: OvercastRecord): boolean {
  if (rec.verb !== "case" || typeof rec.payload !== "object" || rec.payload == null) return false;
  const p = rec.payload as JsonMap;
  return "chunk" in p && "field" in p && "next_offset" in p;
}

// Beyond this many over-budget records, stop emitting per-record locators and
// summarize the rest — so a flood of records stays bounded either way.
const MAX_LOCATORS = 50;

/**
 * Render the emitted records into the LLM-facing tool text. One fold over the
 * records, picking the largest representation that fits the remaining budget and
 * NEVER dropping a record silently:
 *   fit in full → inline · else fit as preview → preview · else → a one-line
 *   locator (id + how to page it).
 * Budgeting is on the ACTUAL rendered bytes (header + formatting). Locators are
 * capped so even thousands of records stay bounded.
 */
function renderRecords(records: OvercastRecord[]): string {
  let spent = 0;
  let locators = 0;
  let omitted = 0;
  const parts: string[] = [];
  for (const rec of records) {
    // an explicitly-requested page slice is always shown in full and doesn't
    // compete for the budget (the agent asked for exactly that record).
    if (isPageChunk(rec)) {
      parts.push(renderRecord(rec, { mode: "full", budget: AGENT_BUDGET, force: true }));
      continue;
    }
    // try full, then preview, budgeting on the rendered string each time
    for (const mode of ["full", "preview"] as const) {
      const rendered = renderRecord(rec, { mode, budget: AGENT_BUDGET });
      const cost = Buffer.byteLength(rendered, "utf8");
      if (spent + cost <= AGENT_BUDGET) {
        spent += cost;
        parts.push(rendered);
        break;
      }
      if (mode === "preview") {
        // even the preview won't fit — emit a compact locator so the agent still
        // has the id + how to read it (never a silent drop), up to a cap.
        if (locators < MAX_LOCATORS) {
          locators++;
          const loc = `${rec.id} [${rec.verb}] state=${rec.state ?? "ready"} — not shown (budget); read it with \`${pageCommand(rec)}\``;
          spent += Buffer.byteLength(loc, "utf8");
          parts.push(loc);
        } else {
          omitted++;
        }
      }
    }
  }
  if (omitted > 0) {
    parts.push(`… ${omitted} more record(s) not shown; list them with \`overcast case records\`.`);
  }
  return parts.join("\n\n");
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

      const summary = renderRecords(records);
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
