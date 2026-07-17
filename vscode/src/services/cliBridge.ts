// Spawns the overcast CLI and maps its output/exit codes to results the UI can
// use. Never a shell; always --json; always an explicit --case. Maintains the
// `overcast.cliFound` context key.
//
// Resolution: `overcast.path` setting wins — a `.js` path (e.g. a repo
// dist/bin/overcast.js) is run with the extension host's own Node
// (ELECTRON_RUN_AS_NODE=1); anything else is treated as an executable.
// Empty setting = discover `overcast` on PATH.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { failureFor, parseRecords, type CliFailure } from "../lib/cliOutput.ts";
import { jobLabel, jobRecordId, jobVerbTarget, shouldTrackJob, type Job } from "../lib/jobs.ts";
import type { OvercastRecord } from "../types.ts";
import type { CaseLocator } from "./caseLocator.ts";

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const KILL_ESCALATE_MS = 3000;
// How many finished jobs the Runs view keeps (newest-first ring).
const JOB_HISTORY = 20;

export interface ResolvedCli {
  /** executable to spawn */
  cmd: string;
  /** args always prepended (the script path in node-runner mode) */
  argsPrefix: string[];
  /** extra env required by the runner mode */
  env: Record<string, string>;
  /** human-readable description for logs */
  display: string;
}

export interface RunOptions {
  /** override the case dir (default: locator's current case) */
  caseDir?: string;
  /** skip appending --case entirely (pre-init commands like `case init`) */
  noCaseFlag?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  token?: vscode.CancellationToken;
  /** don't append --json (rare; e.g. commands that take no format flag) */
  rawOutput?: boolean;
}

export interface CliResult {
  code: number;
  records: OvercastRecord[];
  stdout: string;
  stderr: string;
  failure?: CliFailure;
  /** true when the run was killed via a caller token OR the Runs-view cancel —
   *  callers must treat this as "user said stop", never as a failure. */
  cancelled?: boolean;
}

function findOnPath(name: string): string | undefined {
  const pathVar = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

export class CliBridge implements vscode.Disposable {
  private resolved: ResolvedCli | null | undefined; // undefined = not yet tried
  private mutateQueue: Promise<unknown> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  // ---- run tracking (Runs view + status-bar spinner) ----
  private readonly jobEmitter = new vscode.EventEmitter<void>();
  /** Fires on any job state change (start / finish / cancel / clear). */
  readonly onDidChangeJobs = this.jobEmitter.event;
  private runningJobs: Job[] = []; // newest-first
  private finishedJobs: Job[] = []; // newest-first ring (≤ JOB_HISTORY)
  private readonly jobCts = new Map<string, vscode.CancellationTokenSource>();
  private jobSeq = 0;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly locator: CaseLocator,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("overcast.path")) {
          this.resolved = undefined;
          void this.resolve();
        }
      }),
      // Finished-run rows deep-link record ids, which are per-case — drop them
      // on a case switch so a stale row can't open a record in the wrong case.
      locator.onDidChangeCase(() => this.clearFinishedJobs()),
    );
  }

  /** True once the CLI has resolved successfully (mirrors the overcast.cliFound
   *  context key; false while unresolved or missing). Cheap synchronous read for
   *  UI that can't await, e.g. the command deck's status dot. */
  get cliFound(): boolean {
    return !!this.resolved;
  }

  /** Drop the cached resolution and re-resolve (the "Restart CLI" command). */
  async restart(): Promise<ResolvedCli | undefined> {
    this.resolved = undefined;
    this.output.appendLine("overcast cli: re-resolving (restart requested)");
    return this.resolve();
  }

  /** Resolve (and smoke-test) the CLI; caches; maintains overcast.cliFound. */
  async resolve(): Promise<ResolvedCli | undefined> {
    if (this.resolved !== undefined) return this.resolved ?? undefined;
    const setting = vscode.workspace.getConfiguration("overcast").get<string>("path", "").trim();
    let candidate: ResolvedCli | undefined;
    if (setting) {
      if (setting.endsWith(".js") || setting.endsWith(".mjs")) {
        candidate = {
          cmd: process.execPath,
          argsPrefix: [setting],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          display: `${setting} (via extension-host node)`,
        };
      } else {
        candidate = { cmd: setting, argsPrefix: [], env: {}, display: setting };
      }
    } else {
      const onPath = findOnPath("overcast");
      if (onPath) candidate = { cmd: onPath, argsPrefix: [], env: {}, display: onPath };
    }
    if (candidate) {
      const ok = await this.smokeTest(candidate);
      this.resolved = ok ? candidate : null;
    } else {
      this.resolved = null;
    }
    await vscode.commands.executeCommand("setContext", "overcast.cliFound", !!this.resolved);
    if (this.resolved) this.output.appendLine(`overcast cli: ${this.resolved.display}`);
    else this.output.appendLine("overcast cli: NOT FOUND (set overcast.path or install on PATH)");
    return this.resolved ?? undefined;
  }

  private smokeTest(cli: ResolvedCli): Promise<boolean> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolvePromise(ok);
        }
      };
      try {
        const child = spawn(cli.cmd, [...cli.argsPrefix, "--version", "--json"], {
          env: { ...process.env, ...cli.env },
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          done(false);
        }, 10_000);
        child.on("error", () => {
          clearTimeout(timer);
          done(false);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done(code === 0);
        });
      } catch {
        done(false);
      }
    });
  }

  /** Resolve or walk the user through fixing the setup. Returns undefined if missing. */
  async ensureCli(): Promise<ResolvedCli | undefined> {
    const cli = await this.resolve();
    if (cli) return cli;
    const pick = await vscode.window.showErrorMessage(
      "The overcast CLI was not found. Install it (npm install -g @kdrrr/overcast) or point overcast.path at a binary or a built dist/bin/overcast.js.",
      "Open Settings",
      "Retry",
    );
    if (pick === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "overcast.path");
    } else if (pick === "Retry") {
      this.resolved = undefined;
      return this.ensureCli();
    }
    return undefined;
  }

  /** Low-level run. No UI; callers surface `result.failure` themselves or use runWithProgress. */
  async run(args: string[], opts: RunOptions = {}): Promise<CliResult> {
    const cli = await this.resolve();
    if (!cli) {
      return {
        code: -1,
        records: [],
        stdout: "",
        stderr: "overcast CLI not found",
        failure: { kind: "unknown", message: "overcast CLI not found" },
      };
    }
    const finalArgs = [...cli.argsPrefix, ...args];
    const caseDir = opts.caseDir ?? this.locator.caseDir;
    if (!opts.noCaseFlag && caseDir && !args.includes("--case")) {
      finalArgs.push("--case", caseDir);
    }
    const profile = vscode.workspace.getConfiguration("overcast").get<string>("profile", "");
    if (profile && !args.includes("--profile")) finalArgs.push("--profile", profile);
    const home = this.homeDir();
    if (home && !args.includes("--home")) finalArgs.push("--home", home);
    if (!opts.rawOutput && !args.includes("--json")) finalArgs.push("--json");

    this.output.appendLine(`$ overcast ${finalArgs.slice(cli.argsPrefix.length).join(" ")}`);

    // Track this run as a job (unless it's a noisy poll read) for the Runs view
    // + status bar. The handle owns a tracker CancellationTokenSource that MERGES
    // with any caller token — cancelling either kills the child (see below).
    const jobHandle = this.startJob(args, caseDir);

    return new Promise((resolvePromise) => {
      const child = spawn(cli.cmd, finalArgs, {
        cwd: opts.cwd ?? caseDir ?? undefined,
        env: { ...process.env, ...cli.env, ...opts.env },
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_STDOUT_BYTES) stdout += d.toString("utf8");
        else truncated = true;
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        for (const line of d.toString("utf8").split(/\r?\n/)) {
          if (line.trim()) this.output.appendLine(`  ${line}`);
        }
      });
      let killTimer: NodeJS.Timeout | undefined;
      // Single kill path (SIGTERM → SIGKILL), driven by EITHER the caller token
      // or the tracker's own token — so the Runs view's cancel works even when
      // the caller passed no token.
      const killChild = () => {
        this.output.appendLine("  (cancelled — SIGTERM)");
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATE_MS);
      };
      const cancelSubs: vscode.Disposable[] = [];
      if (opts.token) cancelSubs.push(opts.token.onCancellationRequested(killChild));
      if (jobHandle) cancelSubs.push(jobHandle.cts.token.onCancellationRequested(killChild));
      // A spawn failure emits BOTH 'error' and 'close' — settle exactly once or
      // the job double-finishes (duplicate run:job-N tree ids break the Runs view).
      let settled = false;
      const finish = (code: number, spawnErr?: Error) => {
        if (settled) return;
        settled = true;
        for (const s of cancelSubs) s.dispose();
        if (killTimer) clearTimeout(killTimer);
        if (truncated) this.output.appendLine("  (stdout truncated at 64MB)");
        const records = parseRecords(stdout);
        const failure = spawnErr
          ? { kind: "unknown" as const, message: spawnErr.message }
          : failureFor(code, records, stderr);
        const cancelled = !!(
          opts.token?.isCancellationRequested || jobHandle?.cts.token.isCancellationRequested
        );
        if (jobHandle) this.finishJob(jobHandle, { cancelled, failure, records });
        resolvePromise({ code, records, stdout, stderr, failure, cancelled });
      };
      child.on("error", (err) => finish(-1, err));
      child.on("close", (code) => finish(code ?? -1));
    });
  }

  /**
   * Run under a cancellable progress notification and surface failures with
   * actionable buttons. Returns undefined when the run failed or was cancelled
   * (already reported to the user).
   *
   * `keepPartialFailure`: fan-out verbs like scan exit non-zero when ANY single
   * source fails (e.g. one credential-gapped source) even though healthy sources
   * emitted real records in the same stream — with this set, a failed OR
   * CANCELLED run that still produced records is RETURNED (failure/cancelled
   * attached, nothing surfaced) so the caller can show the partial results;
   * use surfaceFailure for the rest.
   */
  async runWithProgress(
    title: string,
    args: string[],
    opts: RunOptions & { keepPartialFailure?: boolean } = {},
  ): Promise<CliResult | undefined> {
    const cli = await this.ensureCli();
    if (!cli) return undefined;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_progress, token) => {
        const r = await this.run(args, { ...opts, token });
        // r.cancelled also covers the Runs-view inline cancel (tracker token).
        if (token.isCancellationRequested || r.cancelled) {
          // A cancelled fan-out run may have already streamed real records —
          // hand them back (marked cancelled) instead of discarding the work.
          // NOTE: today the CLI prints all records only after the verb
          // completes (scan checkpoints hits to the STORE mid-run, not to
          // stdout), so a killed scan yields zero parseable records and this
          // branch stays dormant until the CLI ever streams; the hits still
          // land in the Records tree via the store watcher.
          return opts.keepPartialFailure && r.records.length > 0 ? { ...r, cancelled: true } : undefined;
        }
        return r;
      },
    );
    if (!result) return undefined;
    if (result.cancelled) return result; // caller shows the partial results
    if (result.failure) {
      if (opts.keepPartialFailure && result.records.length > 0) return result;
      // Outside the withProgress scope — awaiting the failure dialog inside it
      // keeps the spinner toast open, stacked under the error.
      await this.surfaceFailure(result);
      return undefined;
    }
    return result;
  }

  /** Report a failed CliResult to the user with actionable buttons. */
  async surfaceFailure(result: CliResult): Promise<void> {
    const failure = result.failure;
    if (!failure) return;
    if (failure.kind === "needs_credentials") {
      const pick = await vscode.window.showWarningMessage(
        `Overcast needs credentials/setup: ${failure.message}`,
        "Run overcast setup",
        "Show Log",
      );
      if (pick === "Run overcast setup") {
        // Launch via the RESOLVED cli (node-runner aware) + settings flags — a
        // bare `overcast` may not be on the terminal's PATH at all.
        const cli = await this.resolve();
        const term = vscode.window.createTerminal({
          name: "overcast setup",
          env: cli ? this.terminalEnv(cli) : undefined,
        });
        term.show();
        term.sendText(cli ? this.terminalLaunch(cli, "setup") : "overcast setup");
      } else if (pick === "Show Log") {
        this.output.show(true);
      }
      return;
    }
    const label = failure.kind === "usage" ? "Overcast (internal argv error)" : "Overcast";
    const pick = await vscode.window.showErrorMessage(`${label}: ${failure.message}`, "Show Log");
    if (pick === "Show Log") this.output.show(true);
  }

  /**
   * Shell command line launching the overcast CLI in an interactive terminal
   * (agent TUI, setup wizard): node-runner aware, quoted, and carrying the
   * same `--profile`/`--home` settings every spawned run gets — a terminal
   * session must see the same profiles/archive as sidebar and chat runs.
   * `extra` tokens are appended verbatim (caller handles their quoting).
   * Create the terminal with `terminalEnv(cli)` — the node-runner head relies
   * on it. Quoting is POSIX-double-quote semantics (macOS/Linux shells);
   * exotic paths under Windows cmd/PowerShell are best-effort.
   */
  terminalLaunch(cli: ResolvedCli, ...extra: string[]): string {
    // quote anything outside a conservative safe set — a $/backtick-bearing
    // path without spaces still expands/executes if left bare
    const q = (s: string) =>
      /^[A-Za-z0-9_\-./:@=+,]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
    // Node-runner mode: reuse the SAME resolved runner every spawned run uses
    // (the extension host's executable, run-as-node via terminalEnv) — a bare
    // `node` may not exist on the terminal's PATH at all.
    const head = [q(cli.cmd), ...cli.argsPrefix.map(q)].join(" ");
    const settings: string[] = [];
    const profile = vscode.workspace.getConfiguration("overcast").get<string>("profile", "");
    if (profile) settings.push("--profile", profile);
    const home = this.homeDir();
    if (home) settings.push("--home", home);
    return [head, ...settings.map(q), ...extra].join(" ");
  }

  /** Terminal env for a `terminalLaunch` command line — the node-runner head
   *  (extension-host executable) only behaves as node with ELECTRON_RUN_AS_NODE
   *  set. Undefined when the resolved CLI needs no env. */
  terminalEnv(cli: ResolvedCli): Record<string, string> | undefined {
    return Object.keys(cli.env).length ? { ...cli.env } : undefined;
  }

  /** `overcast.home` setting → `--home` (profiles, archive buckets). Absolute
   *  or workspace-relative, mirroring `overcast.caseDir`. */
  private homeDir(): string | undefined {
    const raw = vscode.workspace.getConfiguration("overcast").get<string>("home", "").trim();
    if (!raw) return undefined;
    if (path.isAbsolute(raw)) return raw;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return ws ? path.join(ws, raw) : raw;
  }

  /** Serialized mutation lane (finding accept/dismiss etc. — no double-fires). */
  mutate(args: string[], opts: RunOptions = {}): Promise<CliResult> {
    const next = this.mutateQueue.then(() => this.run(args, opts));
    this.mutateQueue = next.catch(() => undefined);
    return next;
  }

  /** Snapshot of tracked jobs, newest-first: running rows then the finished ring. */
  get jobs(): readonly Job[] {
    return [...this.runningJobs, ...this.finishedJobs];
  }

  /** Cancel a running job by id — kills its child via the tracker-owned token. */
  cancelJob(id: string): void {
    this.jobCts.get(id)?.cancel();
  }

  /** Drop finished jobs (the Runs view's "Clear" title action). */
  clearFinishedJobs(): void {
    if (this.finishedJobs.length === 0) return;
    this.finishedJobs = [];
    this.jobEmitter.fire();
  }

  private startJob(
    args: string[],
    caseDir: string | undefined,
  ): { job: Job; cts: vscode.CancellationTokenSource } | undefined {
    if (!shouldTrackJob(args)) return undefined;
    const { verb, target } = jobVerbTarget(args);
    const id = `job-${++this.jobSeq}`;
    const cts = new vscode.CancellationTokenSource();
    const job: Job = {
      id,
      verb,
      target,
      label: jobLabel(verb, target),
      startedAt: Date.now(),
      state: "running",
      caseDir,
    };
    this.runningJobs.unshift(job);
    this.jobCts.set(id, cts);
    this.jobEmitter.fire();
    return { job, cts };
  }

  private finishJob(
    handle: { job: Job; cts: vscode.CancellationTokenSource },
    outcome: { cancelled: boolean; failure?: CliFailure; records: OvercastRecord[] },
  ): void {
    const { job, cts } = handle;
    const i = this.runningJobs.indexOf(job);
    if (i >= 0) this.runningJobs.splice(i, 1);
    cts.dispose();
    this.jobCts.delete(job.id);
    job.endedAt = Date.now();
    job.state = outcome.cancelled ? "cancelled" : outcome.failure ? "failed" : "ok";
    if (outcome.failure && !outcome.cancelled) job.failure = outcome.failure.message;
    const recId = jobRecordId(outcome.records);
    if (recId) job.recordId = recId;
    // A run that was in flight when the user switched cases must not land in
    // the finished ring: clearFinishedJobs already wiped the OLD case's rows,
    // and this row's deep-link would resolve its record id against the NEW
    // case. Fire anyway so the Runs view drops the running row.
    if (job.caseDir !== this.locator.caseDir) {
      this.jobEmitter.fire();
      return;
    }
    this.finishedJobs.unshift(job);
    if (this.finishedJobs.length > JOB_HISTORY) this.finishedJobs.length = JOB_HISTORY;
    this.jobEmitter.fire();
  }

  /** Spawn a long-lived child (situation serve). Caller owns the lifecycle. */
  async spawnLongLived(
    args: string[],
    opts: { caseDir?: string; env?: Record<string, string> } = {},
  ): Promise<ChildProcessWithoutNullStreams | undefined> {
    const cli = await this.resolve();
    if (!cli) return undefined;
    const finalArgs = [...cli.argsPrefix, ...args];
    const caseDir = opts.caseDir ?? this.locator.caseDir;
    if (caseDir && !args.includes("--case")) finalArgs.push("--case", caseDir);
    const profile = vscode.workspace.getConfiguration("overcast").get<string>("profile", "");
    if (profile && !args.includes("--profile")) finalArgs.push("--profile", profile);
    const home = this.homeDir();
    if (home && !args.includes("--home")) finalArgs.push("--home", home);
    this.output.appendLine(
      `$ overcast ${finalArgs.slice(cli.argsPrefix.length).join(" ")} (long-lived)`,
    );
    return spawn(cli.cmd, finalArgs, {
      cwd: caseDir ?? undefined,
      env: { ...process.env, ...cli.env, ...opts.env },
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const cts of this.jobCts.values()) cts.dispose();
    this.jobCts.clear();
    this.jobEmitter.dispose();
  }
}
