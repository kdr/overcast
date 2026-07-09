import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../fs-atomic.js";
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

/** Score-trigger fire floors (face/similar/cluster: 0–100 percent similarity;
 *  image_inliers: RANSAC inlier count). Missing keys use the built-in defaults
 *  in signals/triggers.ts. */
export interface SetupFindingsThresholds {
  face?: number;
  similar?: number;
  cluster?: number;
  image_inliers?: number;
  audio_margin?: number;
}

export interface SetupFindingsPolicy {
  /** "suggest" (default): all triggers emit quarantined suggested findings;
   *  "review": legacy text-target-only open findings; "off": no automation. */
  mode: "off" | "review" | "suggest" | string;
  thresholds?: SetupFindingsThresholds;
  /** Forensic flag triggers (exif editing-software / verify invalid-provenance).
   *  Absent = on (opt-out), matching the "suggestions on unless opted out"
   *  default. Set false to silence just the forensic leads. */
  forensics?: boolean;
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
    /** OPT-IN (off by default — the field is absent unless the operator opts in):
     *  fan `ask --deep` out to a case-linked Cloudglue **media-descriptions**
     *  collection at cloud scale. Uploading/querying that collection costs money,
     *  so it is never auto-enabled (invariant #2 BYO spirit). `index` optionally
     *  pins a media-descriptions index id/name; otherwise the case's first
     *  attached media-descriptions index is used. Toggle via
     *  `overcast setup memory cloudglue [index|off]`. */
    cloudglue?: { index?: string };
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
    findings: { mode: "suggest" },
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
      parsed.memory.signals = Array.isArray(parsed.memory.signals) ? parsed.memory.signals : ["note", "watch", "listen", "see", "scan"];
      parsed.automation ??= { auto_sense: [], auto_index_new: false };
      parsed.findings ??= { mode: "suggest" };
      parsed.providers ??= {};
      return parsed;
    }
  } catch {
    // fall through to missing/corrupt as no saved setup
  }
  return undefined;
}

export function saveSetup(c: Case, setup: CaseSetup): void {
  writeFileAtomic(c.setupFile, JSON.stringify(setup, null, 2) + "\n");
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
