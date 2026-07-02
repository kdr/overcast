import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Case } from "../case.js";
import type { IndexType } from "./index.js";

/** Optional per-index config carried in the saved setup (basic-clip only today:
 *  pooling/granularity/sampling/window/maxFrames/fps). Written to the index's
 *  config.json at create time; other index types leave it unset. */
export interface SetupIndexConfig {
  pooling?: string;
  granularity?: string;
  sampling?: string;
  window?: number;
  maxFrames?: number;
  fps?: number;
}

export interface SetupIndex {
  id?: string;
  name: string;
  type: IndexType | string;
  default_signals: string[];
  mode?: "create" | "attach";
  config?: SetupIndexConfig;
}

export interface SetupVideoRoute {
  ref: string;
  signals: string[];
  indexes: string[];
}

export interface SetupProviderPolicy {
  verb: string;
  choice: string;
  profile?: string;
  indexable?: boolean;
  descriptor?: unknown;
  env?: string[];
  missing_env?: string[];
  updated_at?: string;
}

export interface SetupAutomationPolicy {
  auto_sense: string[];
  auto_index_new: boolean;
}

export interface SetupFindingsPolicy {
  mode: "off" | "review" | string;
}

export interface CaseSetup {
  version: 1;
  completed: boolean;
  case_name: string;
  targets: string[];
  notes: string[];
  sources: string[];
  memory: {
    backend: "local-grep" | "qmd" | string;
    signals: string[];
  };
  indexes: SetupIndex[];
  default_signals: Record<string, string[]>;
  media: {
    folders: string[];
    videos: string[];
    routes: SetupVideoRoute[];
  };
  providers?: Record<string, SetupProviderPolicy>;
  automation?: SetupAutomationPolicy;
  findings?: SetupFindingsPolicy;
  created_at: string;
  updated_at: string;
  last_update_record_id?: string;
}

export function emptySetup(caseName: string, now = new Date().toISOString()): CaseSetup {
  return {
    version: 1,
    completed: false,
    case_name: caseName,
    targets: [],
    notes: [],
    sources: [],
    memory: { backend: "local-grep", signals: ["note", "watch", "listen", "see", "scan"] },
    indexes: [],
    default_signals: {},
    media: { folders: [], videos: [], routes: [] },
    providers: {},
    automation: { auto_sense: [], auto_index_new: false },
    findings: { mode: "off" },
    created_at: now,
    updated_at: now,
  };
}

export function loadSetup(c: Case): CaseSetup | undefined {
  if (!existsSync(c.setupFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(c.setupFile, "utf8")) as CaseSetup;
    if (parsed && parsed.version === 1) {
      parsed.memory ??= { backend: "local-grep", signals: ["note", "watch", "listen", "see", "scan"] };
      parsed.automation ??= { auto_sense: [], auto_index_new: false };
      parsed.findings ??= { mode: "off" };
      parsed.providers ??= {};
      return parsed;
    }
  } catch {
    // fall through to missing/corrupt as no saved setup
  }
  return undefined;
}

export function saveSetup(c: Case, setup: CaseSetup): void {
  mkdirSync(dirname(c.setupFile), { recursive: true });
  writeFileSync(c.setupFile, JSON.stringify(setup, null, 2) + "\n", "utf8");
}

export function setupSummary(setup: CaseSetup | undefined): Record<string, unknown> {
  if (!setup) return { completed: false };
  return {
    completed: setup.completed,
    case_name: setup.case_name,
    targets: setup.targets.length,
    notes: setup.notes.length,
    sources: setup.sources.length,
    memory: setup.memory,
    indexes: setup.indexes.length,
    videos: setup.media.videos.length,
    folders: setup.media.folders.length,
    providers: Object.keys(setup.providers ?? {}).length,
    automation: setup.automation ?? { auto_sense: [], auto_index_new: false },
    findings: setup.findings ?? { mode: "off" },
    updated_at: setup.updated_at,
    last_update_record_id: setup.last_update_record_id ?? null,
  };
}
