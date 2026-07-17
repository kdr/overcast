// Type contracts for the extension host. Everything importable from the root
// repo is imported TYPE-ONLY (single source of truth; esbuild/tsx erase these,
// so there is zero runtime coupling — root refactors surface as typecheck
// failures in CI, which is intended). Shapes assembled inline by CLI verbs
// (no exported interface upstream) are mirrored here with their producer noted.
//
// IMPORTANT: keep every import in this file `import type` — lib/ modules import
// from here and must stay loadable under plain `node --test` (no vscode, no
// root-repo runtime).
import type * as vscode from "vscode";
import type { OvercastRecord } from "../../src/record.ts";
import type { VerbSpecJSON } from "../../src/registry/types.ts";
import type { SituationRuntime } from "../../src/situation/state.ts";
import type { TargetThread } from "../../src/signals/threads.ts";
import type { SourceCoverage, ScanFreshness } from "../../src/signals/pulse.ts";
import type { TriageRow } from "../../src/report/mission.ts";
import type { CliBridge } from "./services/cliBridge.ts";
import type { CaseLocator } from "./services/caseLocator.ts";
import type { CaseStatusModel } from "./services/caseStatusModel.ts";
import type { VerbRegistry } from "./services/verbRegistry.ts";

export type {
  OvercastRecord,
  VerbSpecJSON,
  SituationRuntime,
  TargetThread,
  SourceCoverage,
  ScanFreshness,
  TriageRow,
};

// ---- CLI --json payload mirrors (producer noted per type) -------------------

/** `case status --json` payload — producer: buildCaseStatus (src/verbs/case.ts). */
export interface CaseStatusPayload {
  dir?: string;
  initialized?: boolean;
  info?: { id?: string; name?: string; created?: string };
  mission?: { headline?: string; progress?: Record<string, number> };
  threads?: TargetThread[];
  coverage?: SourceCoverage[];
  triage?: (TriageRow & { review?: string })[];
  gaps?: string[];
  freshness?: {
    lastScans?: ScanFreshness[];
    lastScanAgeSeconds?: number | null;
    monitor?: { time?: string; ageSeconds?: number; newItems?: number } | null;
    briefAgeSeconds?: number | null;
  };
  next_actions?: string[];
  tldr?: unknown;
  targets?: TargetInfo[];
  sources?: SourceInfo[];
  store?: { records?: number; counts?: Record<string, number>; [k: string]: unknown };
  report?: string;
  [k: string]: unknown;
}

/** `case status --json` payload.targets rows. */
export interface TargetInfo {
  id: string;
  kind: string;
  value: string;
  description?: string;
  image?: string;
  created?: string;
}

/** `case status --json` payload.sources rows. */
export interface SourceInfo {
  id: string;
  type: string;
  ref: string;
  name?: string;
  enabled?: boolean;
  description?: string;
  created?: string;
}

/** `case records --json` payload — producer: src/verbs/case.ts (records action). */
export interface CaseRecordsPayload {
  count: number;
  shown: number;
  limit: number;
  truncated: boolean;
  records: RecordRow[];
}

/** Compact record row from `case records --json`. */
export interface RecordRow {
  id: string;
  verb: string;
  state?: string | null;
  media?: string | null;
  at?: string | number | null;
}

/** `index list --json` payload row — producer: src/verbs/index.ts (list action:
 *  {op:"list", indexes:[{id,type,backend,name,members}], count}). */
export interface IndexInfo {
  id: string;
  type: string;
  backend?: string;
  name?: string;
  members?: number;
}

/** `finding list --json` payload — producer: src/verbs/finding.ts (list). */
export interface FindingListPayload {
  state?: string;
  findings: Array<
    OvercastRecord & {
      review_status?: "suggested" | "open" | "accepted" | "dismissed";
      source_url?: string;
      source_excerpt?: string;
    }
  >;
}

/** `commands --json` top-level shape — producer: src/cli.ts. */
export interface CommandsPayload {
  verbs: VerbSpecJSON[];
}

// ---- extension wiring --------------------------------------------------------

/** Cross-workstream panel routing (implemented in extension.ts). */
export interface PanelRouter {
  /** Open a generated HTML artifact (view/grid/map/graph/wall/brief) in a tab. */
  openArtifact(absPath: string, title?: string): Promise<void>;
  /** Open a record-detail tab for a case record id. */
  openRecord(recordId: string): Promise<void>;
  /** Nudge the case model to refetch (after any mutating CLI run). */
  refresh(): void;
}

/** The shared dependency bag handed to every register*() entry point. */
export interface ExtDeps {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  bridge: CliBridge;
  locator: CaseLocator;
  model: CaseStatusModel;
  registry: VerbRegistry;
  router: PanelRouter;
}
