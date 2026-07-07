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
  // ~O(hits × senses × N)). Kept COHERENT WITH DISK via a cheap per-file
  // mtime/ctime/size fingerprint (storeStamp): any external write (another
  // process/Case, or an in-place edit that qmd staleness detection looks for)
  // changes a *.jsonl → the cache reloads on the next read. writeRecord()
  // INVALIDATES the cache (rather than racily patching it), so repeated reads
  // with no writes are cached but every write reloads fresh.
  private _recordsCache?: OvercastRecord[];
  private _idIndex?: Map<string, OvercastRecord>;
  private _cacheStamp?: string;

  /** A PER-FILE fingerprint of the store's *.jsonl files (one `name:mtime:ctime:size`
   *  entry each). Changes on any append (size), write/touch (mtime), same-size
   *  in-place edit (ctime — the kernel bumps it on any inode change, and a `utimes`
   *  mtime-forge can't reset it), or a new/removed file. Per-file rather than a
   *  global maxMtime+totalSize so an edit to a non-newest file (or one that keeps
   *  the summed size) can't leave the fingerprint unchanged. */
  private storeStamp(): string {
    const parts: string[] = [];
    try {
      for (const name of readdirSync(this.recordsDir).sort()) {
        if (!name.endsWith(".jsonl")) continue;
        const st = statSync(join(this.recordsDir, name));
        parts.push(`${name}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`);
      }
    } catch {
      /* no records dir yet */
    }
    return parts.join("|");
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
    appendRecordJSONL(file, rec);
    // INVALIDATE rather than patch the cache. An incremental push + re-stamp is
    // unavoidably racy without a lock: a concurrent external append (another
    // process / Case on this dir) landing between the stamp check and our own
    // append would be "blessed away" (we'd re-stamp to disk while missing its
    // row). Dropping the cache is race-free — the next read reloads disk truth
    // (mtime-validated), so read-after-write stays correct, and read-heavy paths
    // with no intervening writes (recordById loops, brief/ask) are still cached.
    this._recordsCache = undefined;
    this._idIndex = undefined;
    this._cacheStamp = undefined;
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
