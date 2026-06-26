// Case = a folder (CLAUDE.md invariant #4). No bespoke case object — a case is
// just a directory with a `.overcast/` store. pi's per-directory sessions are
// the case history. Switch cases by `cd` / `--case <dir>`.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  type OvercastRecord,
  appendRecordJSONL,
  readAllRecords,
} from "./record.js";

export const STORE_DIR = ".overcast";

export interface CaseInfo {
  id: string;
  name: string;
  created: string;
  /** optional profile pin (profile name) */
  profile?: string;
}

/** A case is a directory; this wraps its `.overcast/` store paths + I/O. */
export class Case {
  readonly dir: string;
  readonly storeDir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.storeDir = join(this.dir, STORE_DIR);
  }

  // --- store layout ---------------------------------------------------------
  get caseFile(): string {
    return join(this.storeDir, "case.json");
  }
  get recordsDir(): string {
    return join(this.storeDir, "records");
  }
  get mediaDir(): string {
    return join(this.storeDir, "media");
  }
  get indexDir(): string {
    return join(this.storeDir, "index");
  }
  get targetFile(): string {
    return join(this.storeDir, "target.json");
  }
  get sourcesFile(): string {
    return join(this.storeDir, "sources.json");
  }
  get collectionsFile(): string {
    return join(this.storeDir, "collections.json");
  }
  get seenFile(): string {
    return join(this.storeDir, "seen.json");
  }

  /** Whether this directory has been initialized as a case. */
  exists(): boolean {
    return existsSync(this.caseFile);
  }

  /** Create `.overcast/` and case.json if missing; returns the CaseInfo. */
  ensure(): CaseInfo {
    mkdirSync(this.recordsDir, { recursive: true });
    mkdirSync(this.mediaDir, { recursive: true });
    if (!this.exists()) {
      const info: CaseInfo = {
        id: "case_" + randomBytes(4).toString("hex"),
        name: basename(this.dir),
        created: new Date().toISOString(),
      };
      writeFileSync(this.caseFile, JSON.stringify(info, null, 2) + "\n", "utf8");
      return info;
    }
    return this.info();
  }

  info(): CaseInfo {
    return JSON.parse(readFileSync(this.caseFile, "utf8")) as CaseInfo;
  }

  /** Set the case name, persisting it to case.json (creates the store first). */
  setName(name: string): CaseInfo {
    const info = this.ensure();
    if (!name || name === info.name) return info;
    const updated: CaseInfo = { ...info, name };
    writeFileSync(this.caseFile, JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  }

  // --- records --------------------------------------------------------------

  /**
   * Persist a record into the case store. One JSONL file per verb keeps the
   * store browsable; records are the case memory.
   */
  writeRecord(rec: OvercastRecord): string {
    mkdirSync(this.recordsDir, { recursive: true });
    // stamp the owning case dir on every persisted record (mutating in place, so
    // the same object — rendered right after — carries it). This lets the "page it"
    // hint embed `--case <dir>`, so re-reading a record works from ANY cwd (the
    // common agent footgun: cd elsewhere, then `case memory get` finds nothing).
    rec.meta = { ...rec.meta, case: this.dir };
    const file = join(this.recordsDir, `${rec.verb}.jsonl`);
    appendRecordJSONL(file, rec);
    return file;
  }

  /** All records across the store (input to ask/brief/recall). */
  records(): OvercastRecord[] {
    return readAllRecords(this.recordsDir);
  }

  recordById(id: string): OvercastRecord | undefined {
    return this.records().find((r) => r.id === id);
  }
}

/** Open the case rooted at `dir` (default cwd). Does not create the store. */
export function openCase(dir: string = process.cwd()): Case {
  return new Case(dir);
}

/** List record JSONL files present in a case store (for diagnostics). */
export function recordFiles(c: Case): string[] {
  if (!existsSync(c.recordsDir)) return [];
  return readdirSync(c.recordsDir).filter((f) => f.endsWith(".jsonl"));
}
