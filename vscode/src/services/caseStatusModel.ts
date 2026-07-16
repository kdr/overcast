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
  RecordRow,
} from "../types.ts";
import type { CaseLocator } from "./caseLocator.ts";
import type { CliBridge } from "./cliBridge.ts";

const DEBOUNCE_MS = 500;

export interface FindingSummary {
  text: string;
  status: string;
}

export class CaseStatusModel implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  status: CaseStatusPayload | undefined;
  records: RecordRow[] = [];
  recordsPayload: CaseRecordsPayload | undefined;
  /** finding root id → {text, effective status} (from finding list --state all) */
  findings = new Map<string, FindingSummary>();

  private watcher: vscode.FileSystemWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private refreshQueued = false;
  // Our own refresh reads (case status/records, finding list) PERSIST a `case`
  // audit record to records/case.jsonl. Watching that file would loop forever
  // (write → watcher → refresh → write). We ignore case.jsonl outright AND drop
  // any watcher event within a short window after our reads finish, so no file
  // our reads happen to touch can re-trigger us.
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
      // never react to case.jsonl — our own status/records reads append there
      if (uri.path.endsWith("/case.jsonl")) return;
      // drop side effects of our own reads (any other file they touched)
      if (Date.now() < this.suppressUntil) return;
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
    if (!caseDir) {
      this.status = undefined;
      this.records = [];
      this.recordsPayload = undefined;
      this.findings = new Map();
      this.emitter.fire();
      return;
    }
    let statusRes, recordsRes, findingsRes;
    try {
      // A view-scoped progress bar shows the trees are (re)loading.
      [statusRes, recordsRes, findingsRes] = await vscode.window.withProgress(
        { location: { viewId: "overcast.investigation" } },
        () =>
          Promise.all([
            this.bridge.run(["case", "status"], { caseDir }),
            this.bridge.run(["case", "records", "--limit", "500"], { caseDir }),
            this.bridge.run(["finding", "list", "--state", "all"], { caseDir }),
          ]),
      );
    } finally {
      // the reads above just appended to case.jsonl — ignore the watcher fallout
      this.suppressUntil = Date.now() + 1500;
    }

    const statusRec = statusRes.records.find((r) => r.verb === "case");
    this.status =
      !statusRes.failure && statusRec ? (statusRec.payload as CaseStatusPayload) : undefined;

    const recordsRec = recordsRes.records.find((r) => r.verb === "case");
    if (!recordsRes.failure && recordsRec) {
      this.recordsPayload = recordsRec.payload as unknown as CaseRecordsPayload;
      this.records = this.recordsPayload.records ?? [];
    } else {
      this.recordsPayload = undefined;
      this.records = [];
    }

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

    this.emitter.fire();
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
