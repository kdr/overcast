// Single source of case-board data for ALL sidebar trees + the triage badge.
// One refresh = three fast local CLI calls:
//   case status --json   → threads/coverage/triage/freshness/targets/sources
//   case records --json  → compact record rows (returned OLDEST-first; trees
//                          reverse for the newest-first trail)
//   finding list --state all --json → finding text/status by id (thread
//                          children label their linked findings from this)
// Refresh triggers: a debounced FileSystemWatcher over the case's .overcast
// store, locator case changes, and router.refresh() after mutating runs.
import * as vscode from "vscode";
import type {
  CaseRecordsPayload,
  CaseStatusPayload,
  FindingListPayload,
  IndexInfo,
  RecordRow,
} from "../types.ts";
import type { CaseLocator } from "./caseLocator.ts";
import type { CliBridge } from "./cliBridge.ts";

const DEBOUNCE_MS = 500;
// How many recent notes the Investigation "Notes & leads" section surfaces (and
// the cap on note-body fetches per refresh). The full trail lives in Records.
const NOTE_LIMIT = 30;

export interface FindingSummary {
  text: string;
  status: string;
}

/** A recent note surfaced in the Investigation "Notes & leads" section. `text`
 *  is filled in asynchronously (compact `case records` rows carry no body), so
 *  it may be undefined on the first render pass. */
export interface NoteEntry {
  id: string;
  text?: string;
}

export class CaseStatusModel implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  status: CaseStatusPayload | undefined;
  records: RecordRow[] = [];
  recordsPayload: CaseRecordsPayload | undefined;
  /** finding root id → {text, effective status} (from finding list --state all) */
  findings = new Map<string, FindingSummary>();
  /** newest-first recent notes (≤ NOTE_LIMIT), bodies lazily enriched below. */
  notes: NoteEntry[] = [];
  /** case indexes (`index list` mirror rows) — the Sources view's Indexes folder. */
  indexes: IndexInfo[] = [];
  // note id → body. Notes are immutable, so a fetched body is cached for the
  // life of the case and never re-read (cleared on case switch).
  private noteText = new Map<string, string>();
  private lastCaseDir: string | undefined;
  /** one records-truncation warning per case (reset on case switch). */
  private warnedTruncated = false;

  private watcher: vscode.FileSystemWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private refreshQueued = false;
  // Current CLIs mark every poll read (case status/records, finding list,
  // index list, memory get) transient — nothing is written. This guard is
  // defense-in-depth for OLDER CLIs whose reads DID append a `case` audit
  // record to records/case.jsonl (write → watcher → refresh → write = runaway):
  // ignore case.jsonl outright AND drop any watcher event within a short
  // window after our reads finish.
  private suppressUntil = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly bridge: CliBridge,
    private readonly locator: CaseLocator,
  ) {}

  startWatching(context: vscode.ExtensionContext): void {
    this.armWatcher();
    this.disposables.push(this.locator.onDidChangeCase(() => this.armWatcher()));
    context.subscriptions.push(this);
  }

  private armWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const caseDir = this.locator.caseDir;
    if (!caseDir) return;
    // records/*.jsonl (appends) + target/sources/setup.json (state writes)
    const pattern = new vscode.RelativePattern(caseDir, ".overcast/**/*.{json,jsonl}");
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    const onEvt = (uri: vscode.Uri) => {
      // never react to case.jsonl — an OLD CLI's status/records reads append there
      if (uri.path.endsWith("/case.jsonl")) return;
      // The suppress window only mutes the files an old CLI's poll reads could
      // write (finding/index list audit rows) — evidence writes (watch/scan/
      // note/… jsonl) from an agent terminal or external CLI must ALWAYS
      // refresh, even mid-poll. Current CLIs mark every poll read transient,
      // so this is pure defense-in-depth.
      if (Date.now() < this.suppressUntil && /\/(finding|index)\.jsonl$/.test(uri.path)) return;
      this.scheduleRefresh();
    };
    this.watcher = w;
    this.disposables.push(w, w.onDidCreate(onEvt), w.onDidChange(onEvt), w.onDidDelete(onEvt));
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  /** Coalescing refresh: if one is in flight, queue exactly one more. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.doRefresh();
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async doRefresh(): Promise<void> {
    const caseDir = this.locator.caseDir;
    if (caseDir !== this.lastCaseDir) {
      this.noteText.clear(); // ids are per-case; don't carry a body across a switch
      this.warnedTruncated = false;
      this.lastCaseDir = caseDir;
    }
    if (!caseDir) {
      this.status = undefined;
      this.records = [];
      this.recordsPayload = undefined;
      this.findings = new Map();
      this.notes = [];
      this.indexes = [];
      this.emitter.fire();
      return;
    }
    let statusRes, recordsRes, findingsRes, indexRes;
    try {
      // A view-scoped progress bar shows the trees are (re)loading.
      [statusRes, recordsRes, findingsRes, indexRes] = await vscode.window.withProgress(
        { location: { viewId: "overcast.investigation" } },
        () =>
          Promise.all([
            this.bridge.run(["case", "status"], { caseDir }),
            // Effectively-unbounded limit: the CLI's --limit keeps the OLDEST N
            // (ascending sort + slice; default 50), which would hide new notes/
            // records in big cases. Compact rows are tiny; trees cap what they
            // render client-side.
            this.bridge.run(["case", "records", "--limit", "1000000"], { caseDir }),
            this.bridge.run(["finding", "list", "--state", "all"], { caseDir }),
            // local mirror read (no --remote): never reaches tinycloud
            this.bridge.run(["index", "list"], { caseDir }),
          ]),
      );
    } finally {
      // arm the old-CLI echo guard (see onEvt — scoped to finding/index.jsonl)
      this.suppressUntil = Date.now() + 1500;
    }

    const statusRec = statusRes.records.find((r) => r.verb === "case");
    this.status =
      !statusRes.failure && statusRec ? (statusRec.payload as CaseStatusPayload) : undefined;

    const recordsRec = recordsRes.records.find((r) => r.verb === "case");
    if (!recordsRes.failure && recordsRec) {
      this.recordsPayload = recordsRec.payload as unknown as CaseRecordsPayload;
      this.records = this.recordsPayload.records ?? [];
      // The CLI keeps the OLDEST N when a case outgrows even our huge --limit —
      // the trees would silently drop the NEWEST evidence. Say so once per case.
      if (this.recordsPayload.truncated && !this.warnedTruncated) {
        this.warnedTruncated = true;
        void vscode.window.showWarningMessage(
          `Overcast: this case has ${this.recordsPayload.count} records — the sidebar shows the oldest ${this.recordsPayload.shown} and NEWER records are missing from the trees. Use the CLI (case records --since …) for the full trail.`,
        );
      }
    } else {
      this.recordsPayload = undefined;
      this.records = [];
    }

    const indexRec = indexRes.records.find((r) => r.verb === "index");
    this.indexes =
      !indexRes.failure && indexRec
        ? (((indexRec.payload as Record<string, unknown> | null)?.indexes ?? []) as IndexInfo[])
        : [];

    this.findings = new Map();
    const findingRec = findingsRes.records.find((r) => r.verb === "finding");
    if (!findingsRes.failure && findingRec) {
      const payload = findingRec.payload as unknown as FindingListPayload;
      for (const f of payload.findings ?? []) {
        const body = (f.payload ?? {}) as { text?: string; status?: string };
        this.findings.set(f.id, {
          text: typeof body.text === "string" ? body.text : f.id,
          status: f.review_status ?? (typeof body.status === "string" ? body.status : "open"),
        });
      }
    }

    // Render the main sidebar immediately with whatever note bodies are already
    // cached, then fill the rest in and fire again — threads never wait on notes.
    this.rebuildNotes();
    this.emitter.fire();
    await this.enrichNotes(caseDir);
  }

  /** Newest-first recent note ids, capped — the compact record trail is oldest-first. */
  private recentNoteIds(): string[] {
    const out: string[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < NOTE_LIMIT; i--) {
      if (this.records[i].verb === "note") out.push(this.records[i].id);
    }
    return out;
  }

  private rebuildNotes(): void {
    this.notes = this.recentNoteIds().map((id) => ({ id, text: this.noteText.get(id) }));
  }

  /** Fetch bodies for surfaced notes not yet cached (`case memory get --field text`
   *  — the sanctioned full read; compact `case records` rows carry no body). */
  private async enrichNotes(caseDir: string): Promise<void> {
    const missing = this.recentNoteIds().filter((id) => !this.noteText.has(id));
    if (missing.length === 0) return;
    try {
      const fetched = await Promise.all(
        missing.map(async (id) => {
          const res = await this.bridge.run(["case", "memory", "get", id, "--field", "text"], { caseDir });
          // Cache only a real body — caching "" on a transient failure would
          // poison the note for the life of the case (the cache is never re-read).
          if (res.failure) return undefined;
          const chunk = (res.records[0]?.payload as { chunk?: unknown } | undefined)?.chunk;
          return typeof chunk === "string" ? ([id, chunk] as const) : undefined;
        }),
      );
      for (const entry of fetched) if (entry) this.noteText.set(entry[0], entry[1]);
    } finally {
      // arm the old-CLI echo guard for these reads too (see onEvt)
      this.suppressUntil = Date.now() + 1500;
    }
    // stale if the case changed mid-fetch; the newer refresh already owns state
    if (this.locator.caseDir !== caseDir) return;
    this.rebuildNotes();
    this.emitter.fire();
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
