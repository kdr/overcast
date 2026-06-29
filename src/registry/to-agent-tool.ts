// Generate a pi AgentTool (ToolDefinition) from a VerbSpec (one spec → tool
// surface). The tool returns a SPLIT result: a compact text summary to the LLM
// (content) + the full records in `details` for the UI/session.
//
// This is the ONLY pi touch-point for verbs besides the extension, so a pi bump
// has a small blast radius (CLAUDE.md "verifying changes").

import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { VerbSpec, VerbContext, FlagSpec } from "./types.js";
import { makeRecord, type OvercastRecord, type JsonMap } from "../record.js";
import { expandHome, expandHomeArg } from "../fs-path.js";
import { renderRecord, pageCommand } from "../render.js";
import { isHtmlExportPath } from "../report/html.js";
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

function applyAgentHtmlDefaults(spec: VerbSpec, opts: VerbContext["opts"]): void {
  const hasThemeFlag = spec.flags.some((f) => f.name === "theme");
  if (!hasThemeFlag || opts.theme != null) return;
  const exportPath = opts.export;
  if (typeof exportPath === "string" && isHtmlExportPath(exportPath.trim())) {
    opts.theme = "csi";
  }
}

// --- verb HUD call tag ------------------------------------------------------
// A cyberpunk "recording-deck" tag for the tool-call line, colored by verb class
// (a semantic split: you read what kind of op is running by its hue). Raw
// truecolor (the theme has no neon-magenta/cyan), mirroring src/extension styling.
const HUD_RESET = "\x1b[0m";
const HUD_PALE = "\x1b[38;2;198;247;213m"; // arg text
const HUD_DIM = "\x1b[38;2;31;157;87m"; // ▸ separator
const ACCENT: Record<string, string> = {
  sense: "\x1b[38;2;0;255;127m", // senses → neon green
  osint: "\x1b[38;2;255;46;151m", // OSINT → magenta
  read: "\x1b[38;2;0;229;255m", // memory/read → cyan
  config: "\x1b[38;2;255;196;0m", // config/dist → amber
};
const SENSE = new Set(["watch", "listen", "see", "face", "enhance", "view", "crop"]);
const OSINT = new Set(["scan", "capture", "monitor", "index", "target", "source", "prebrief"]);
const READ = new Set(["ask", "brief", "case"]);

function verbAccent(name: string): string {
  if (SENSE.has(name)) return ACCENT.sense;
  if (OSINT.has(name)) return ACCENT.osint;
  if (READ.has(name)) return ACCENT.read;
  return ACCENT.config;
}

/** A HUD-tag call line: `⟦ WATCH ⟧ ▸ <primary arg>`. The tag is class-colored;
 *  the primary positional arg (if any) trails after a dim ▸. Never throws. */
export function verbCallLine(spec: VerbSpec, args: Record<string, unknown>): string {
  const tag = `${verbAccent(spec.name)}⟦ ${spec.name.toUpperCase()} ⟧${HUD_RESET}`;
  const primaryName = spec.args[0]?.name;
  const raw = primaryName ? args?.[primaryName] : undefined;
  if (raw === undefined || raw === null || raw === "") return tag;
  let v = String(raw);
  if (v.length > 80) v = v.slice(0, 79) + "…";
  return `${tag} ${HUD_DIM}▸${HUD_RESET} ${HUD_PALE}${v}${HUD_RESET}`;
}

// How many lines of a tool's record output to show before collapsing (mirrors
// pi's built-in tools, e.g. bash=5/read=10). ctrl+o expands. Tunable.
const COLLAPSED_RESULT_LINES = 6;

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
    // Cyberpunk call line (keeps pi's default themed shell, like the bash tool):
    // ⟦ VERB ⟧ ▸ <arg>, colored by verb class.
    renderCall: (args, _theme, context): Text => {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      try {
        text.setText(verbCallLine(spec, (args ?? {}) as Record<string, unknown>));
      } catch {
        text.setText(`⟦ ${spec.name} ⟧`);
      }
      return text;
    },
    // Collapse verbose record output by default, like pi's built-in read/bash
    // tools. (overcast tools otherwise render the full `content` via pi's
    // fallback, which never truncates — that's the "wall of JSON" dump.) Shows a
    // short preview + a "ctrl+o to expand" hint, and respects the global ctrl+o
    // toggle via options.expanded. UI-only: the agent still gets the full
    // `content` text; this just declutters the screen.
    renderResult: (result, options, theme): Text => {
      let text = "";
      try {
        const parts = (result?.content ?? []) as Array<{ type?: string; text?: string }>;
        text = parts
          .filter((c) => c?.type === "text")
          .map((c) => c.text ?? "")
          .join("\n")
          .replace(/\n+$/, "");
      } catch {
        text = "";
      }
      if (!text) return new Text("", 0, 0);
      const lines = text.split("\n");
      if (options.expanded || lines.length <= COLLAPSED_RESULT_LINES) {
        return new Text(theme.fg("toolOutput", text), 0, 0);
      }
      const head = theme.fg("toolOutput", lines.slice(0, COLLAPSED_RESULT_LINES).join("\n"));
      const hint = theme.fg("muted", `… (${lines.length - COLLAPSED_RESULT_LINES} more lines, ctrl+o to expand)`);
      return new Text(`${head}\n${hint}`, 0, 0);
    },
    execute: async (_toolCallId, params: Record<string, unknown>, signal) => {
      const c = deps.getCase();
      c.ensure();
      // expand a leading `~`/`~/` in path-bearing values — the agent passes args
      // literally (no shell), so `~/clip.mov` would otherwise be a missing file.
      const opts: VerbContext["opts"] = {};
      for (const f of spec.flags) {
        if (params[f.name] !== undefined)
          opts[f.name] = expandHomeArg(params[f.name]) as string | number | boolean;
      }
      applyAgentHtmlDefaults(spec, opts);
      // reconstruct positional input + rest from the declared args
      const positionals: string[] = [];
      for (const arg of spec.args) {
        if (params[arg.name] !== undefined) positionals.push(expandHome(String(params[arg.name])));
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
      // there) — e.g. `case init <other-dir>`. Transient records are user-facing
      // control results, not case history.
      for (const rec of records) {
        if (rec.meta?.transient === true || rec.meta?.persisted === true) continue;
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
