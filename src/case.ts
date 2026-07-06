// Case = a folder (CLAUDE.md invariant #4). No bespoke case object — a case is
// just a directory with a `.overcast/` store. pi's per-directory sessions are
// the case history. Switch cases by `cd` / `--case <dir>`.

import {
  existsSync,
  lstatSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
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

export interface CaseStoreEntrySummary {
  files: number;
  bytes: number;
}

export interface CaseClearSummary {
  dir: string;
  initialized: boolean;
  info: CaseInfo | null;
  records: number;
  counts: Record<string, number>;
  media: CaseStoreEntrySummary;
  index: CaseStoreEntrySummary;
  artifacts: string[];
  stateFiles: string[];
}

/** A case is a directory; this wraps its `.overcast/` store paths + I/O. */
export class Case {
  readonly dir: string;
  readonly storeDir: string;

  // Record cache: caching the parsed store avoids re-reading + re-JSON.parsing
  // every *.jsonl on each records()/recordById() call (the persist seam runs
  // triggers after every write; scan --pull / monitor --every otherwise go
  // ~O(hits × senses × N)). Kept COHERENT WITH DISK via a cheap max-mtime stamp:
  // an external write (another process, or an in-place edit that qmd staleness
  // detection looks for) changes a *.jsonl mtime → the cache reloads. This
  // instance's own writeRecord() appends + re-stamps, so no reload on self-write.
  private _recordsCache?: OvercastRecord[];
  private _idIndex?: Map<string, OvercastRecord>;
  private _cacheStamp?: string;

  /** A `maxMtime:totalSize` fingerprint of the store's *.jsonl files — changes on
   *  any append (size grows), in-place edit (mtime and usually size), or new verb
   *  file. Combining size with mtime is robust to coarse mtime granularity. */
  private storeStamp(): string {
    let maxMtime = 0;
    let totalSize = 0;
    try {
      for (const name of readdirSync(this.recordsDir)) {
        if (!name.endsWith(".jsonl")) continue;
        const st = statSync(join(this.recordsDir, name));
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        totalSize += st.size;
      }
    } catch {
      /* no records dir yet */
    }
    return `${maxMtime}:${totalSize}`;
  }

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
  get indexesFile(): string {
    return join(this.storeDir, "indexes.json");
  }
  get setupFile(): string {
    return join(this.storeDir, "setup.json");
  }
  get legacyCollectionsFile(): string {
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
    // Did another process / another Case on this dir write since our cache was
    // built? Check BEFORE our own append changes the stamp. If so, the cache is
    // missing their rows and must NOT be re-blessed as current (else records()/
    // ask/triggers/recordById would silently omit that evidence).
    const externallyChanged = this._recordsCache !== undefined && this.storeStamp() !== this._cacheStamp;
    appendRecordJSONL(file, rec);
    if (this._recordsCache) {
      if (externallyChanged) {
        // drop the cache — the next read reloads the external rows + our append.
        this._recordsCache = undefined;
        this._idIndex = undefined;
        this._cacheStamp = undefined;
      } else {
        // no external writer → safe to keep the cache live incrementally.
        this._recordsCache.push(rec);
        if (!this._idIndex!.has(rec.id)) this._idIndex!.set(rec.id, rec);
        this._cacheStamp = this.storeStamp(); // now reflects only our own append
      }
    }
    return file;
  }

  /** Load (once) + memoize the owned records for this instance, with an id index. */
  private loadRecords(): OvercastRecord[] {
    const stamp = this.storeStamp();
    if (!this._recordsCache || this._cacheStamp !== stamp) {
      this._recordsCache = readAllRecords(this.recordsDir).filter((rec) => {
        const owner = rec.meta?.case;
        return typeof owner !== "string" || resolve(owner) === this.dir;
      });
      const idx = new Map<string, OvercastRecord>();
      for (const r of this._recordsCache) if (!idx.has(r.id)) idx.set(r.id, r); // first-match, like the old find()
      this._idIndex = idx;
      this._cacheStamp = stamp;
    }
    return this._recordsCache;
  }

  /** All records across the store (input to ask/brief/recall). Returns a fresh
   *  array each call (callers may sort/filter in place) over the cached parse. */
  records(): OvercastRecord[] {
    return [...this.loadRecords()];
  }

  recordById(id: string): OvercastRecord | undefined {
    this.loadRecords();
    return this._idIndex!.get(id);
  }

  /** Summarize resettable case contents without mutating the store. */
  clearSummary(): CaseClearSummary {
    const recs = this.records();
    const counts: Record<string, number> = {};
    for (const r of recs) counts[r.verb] = (counts[r.verb] ?? 0) + 1;
    return {
      dir: this.dir,
      initialized: this.exists(),
      info: this.exists() ? this.info() : null,
      records: recs.length,
      counts,
      media: summarizeTree(this.mediaDir),
      index: summarizeTree(this.indexDir),
      artifacts: caseArtifacts(this.dir),
      stateFiles: [
        this.targetFile,
        this.sourcesFile,
        this.indexesFile,
        this.setupFile,
        this.legacyCollectionsFile,
        this.seenFile,
      ].filter(existsSync).map((f) => basename(f)),
    };
  }

  /** Clear records/media/index/state while preserving case.json and the case id. */
  clear(): CaseClearSummary {
    const summary = this.clearSummary();
    rmSync(this.recordsDir, { recursive: true, force: true });
    rmSync(this.mediaDir, { recursive: true, force: true });
    rmSync(this.indexDir, { recursive: true, force: true });
    rmSync(this.targetFile, { force: true });
    rmSync(this.sourcesFile, { force: true });
    rmSync(this.indexesFile, { force: true });
    rmSync(this.setupFile, { force: true });
    rmSync(this.legacyCollectionsFile, { force: true });
    rmSync(this.seenFile, { force: true });
    for (const artifact of summary.artifacts) rmSync(join(this.dir, artifact), { force: true });
    mkdirSync(this.recordsDir, { recursive: true });
    mkdirSync(this.mediaDir, { recursive: true });
    this._recordsCache = undefined; // the store was wiped — drop the cache
    this._idIndex = undefined;
    this._cacheStamp = undefined;
    return summary;
  }
}

function caseArtifacts(dir: string): string[] {
  return ["brief.html", "brief.md"].filter((name) => existsSync(join(dir, name)));
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

function summarizeTree(path: string): CaseStoreEntrySummary {
  let files = 0;
  let bytes = 0;
  const visit = (p: string) => {
    if (!existsSync(p)) return;
    const st = lstatSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) visit(join(p, name));
      return;
    }
    if (st.isFile()) {
      files++;
      bytes += st.size;
    }
  };
  visit(path);
  return { files, bytes };
}
