// One verb spec → three surfaces (CLAUDE.md invariant #5). Each verb is declared
// once here; the CLI subcommand, the pi AgentTool, and the skill reference are
// all generated from this spec. `overcast commands --json` dumps the registry —
// it is the source of truth for the verb surface.

import type { Case } from "../case.js";
import type { Profile } from "../profile.js";
import type { OvercastRecord } from "../record.js";

export type ArgType = "string" | "number" | "boolean";

export interface ArgSpec {
  name: string;
  summary: string;
  required?: boolean;
  variadic?: boolean;
}

export interface FlagSpec {
  name: string; // long flag without leading dashes, e.g. "format"
  summary: string;
  type: ArgType;
  default?: string | number | boolean;
  /** allowed values (for enum-like flags) */
  choices?: string[];
}

/** Execution context handed to a verb handler (CLI and tool share it). */
export interface VerbContext {
  /** primary positional input (media ref / path / query), if any */
  input?: string;
  /** remaining positional args (variadic) */
  rest: string[];
  /** parsed flags */
  opts: Record<string, string | number | boolean | undefined>;
  case: Case;
  profile: Profile;
  /** resolved overcast home + active profile name (for verbs that WRITE config) */
  home?: string;
  profileName?: string;
  /** abort signal (from the agent tool path) */
  signal?: AbortSignal;
}

export interface VerbSpec {
  name: string;
  /** one-line summary (CLI --help + tool description head) */
  summary: string;
  /** longer description for tool + reference */
  description?: string;
  args: ArgSpec[];
  flags: FlagSpec[];
  /** the record `verb` field + reference output kind, e.g. "video.analysis" */
  outputKind: string;
  /** profile binding key (verb→provider). Defaults to name. */
  providerKey?: string;
  /** category for grouping in reference / commands --json */
  group: "sense" | "inspect" | "osint" | "read" | "state" | "config";
  /** the implementation; returns one or more records (already persisted by caller). */
  run: (ctx: VerbContext) => Promise<OvercastRecord[]>;
}

/** JSON-serializable view of a verb (for `commands --json`). */
export interface VerbSpecJSON {
  name: string;
  summary: string;
  description?: string;
  args: ArgSpec[];
  flags: FlagSpec[];
  outputKind: string;
  providerKey: string;
  group: VerbSpec["group"];
}

export function toJSON(spec: VerbSpec): VerbSpecJSON {
  return {
    name: spec.name,
    summary: spec.summary,
    description: spec.description,
    args: spec.args,
    flags: spec.flags,
    outputKind: spec.outputKind,
    providerKey: spec.providerKey ?? spec.name,
    group: spec.group,
  };
}
