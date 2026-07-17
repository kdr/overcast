// Spawns the overcast CLI and maps its output/exit codes to results the UI can
// use. Never a shell; always --json; always an explicit --case. Maintains the
// `overcast.cliFound` context key.
//
// Resolution: `overcast.path` setting wins — a `.js` path (e.g. a repo
// dist/bin/overcast.js) is run with the extension host's own Node
// (ELECTRON_RUN_AS_NODE=1); anything else is treated as an executable.
// Empty setting = discover `overcast` on PATH, then in well-known install
// locations (nvm/volta/bun/homebrew) — a Dock-launched extension host often
// carries the bare GUI PATH, hiding installs every terminal can see.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

// Fallback install locations probed when PATH discovery misses. GUI-launched
// VS Code can skip the shell init that puts version-manager bins on PATH, so
// an `npm install -g` via nvm is invisible here while working in every
// terminal. nvm keeps no stable `current` symlink — probe every installed
// node's bin, newest first.
function wellKnownBinDirs(): string[] {
  if (process.platform === "win32") return [];
  const home = os.homedir();
  const dirs = [
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const nvmNode = path.join(process.env.NVM_DIR ?? path.join(home, ".nvm"), "versions", "node");
  try {
    const versions = fs
      .readdirSync(nvmNode)
      .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const pa = a.slice(1).split(".").map(Number);
        const pb = b.slice(1).split(".").map(Number);
        return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
      });
    for (const v of versions) dirs.push(path.join(nvmNode, v, "bin"));
  } catch {
    /* no nvm */
  }
  return dirs;
}

/** EVERY executable named `name` across `dirs`, in order, deduped by realpath
 *  (symlinked installs would smoke-test the same binary twice). All of them are
 *  returned — resolution smoke-tests each in turn, so a stale/broken launcher
 *  earlier in the order can't hide a working later install. */
function findExecutables(name: string, dirs: string[]): string[] {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        let key = candidate;
        try {
          key = fs.realpathSync(candidate);
        } catch {
          /* dedupe on the literal path */
        }
        if (!seen.has(key)) {
          seen.add(key);
          found.push(candidate);
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return found;
}

export class CliBridge implements vscode.Disposable {
  private resolved: ResolvedCli | null | undefined; // undefined = not yet tried
  /** Full-sentence reason the last resolve failed ("not found" vs "found but
   *  won't run") — the two need different fixes, so never blur them. */
  private resolveFailure: string | undefined;
  /** In-flight resolution, so concurrent callers share ONE discovery pass. */
  private resolving: Promise<ResolvedCli | undefined> | undefined;
  /** Bumped by invalidate(); a pass that finishes under a stale generation
   *  (setting changed / restart mid-flight) must not write the cache. */
  private resolveGen = 0;
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
          this.invalidate();
          void this.resolve();
        }
      }),
      // Finished-run rows deep-link record ids, which are per-case — drop them
      // on a case switch so a stale row can't open a record in the wrong case.
      // clear finished rows AND re-render (the jobs snapshot below filters
      // running rows to the active case — the tree must drop them immediately)
      locator.onDidChangeCase(() => {
        this.clearFinishedJobs();
        this.jobEmitter.fire();
      }),
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
    this.invalidate();
    this.output.appendLine("overcast cli: re-resolving (restart requested)");
    return this.resolve();
  }

  /** Forget any cached/in-flight resolution (setting change, restart, retry).
   *  A pass already in flight keeps running but can't write the cache. */
  private invalidate(): void {
    this.resolved = undefined;
    this.resolving = undefined;
    this.resolveGen++;
  }

  /** Resolve (and smoke-test) the CLI; caches; maintains overcast.cliFound.
   *  Single-flight: the cache is only ever written with a FINISHED outcome —
   *  mutating it mid-pass would make cliFound/resolve report "not found"
   *  to concurrent callers while candidates are still being smoke-tested. */
  async resolve(): Promise<ResolvedCli | undefined> {
    if (this.resolved !== undefined) return this.resolved ?? undefined;
    if (!this.resolving) {
      const pass = this.doResolve(this.resolveGen).finally(() => {
        // don't clear a NEWER pass installed after an invalidate mid-flight
        if (this.resolving === pass) this.resolving = undefined;
      });
      this.resolving = pass;
    }
    return this.resolving;
  }

  private async doResolve(gen: number): Promise<ResolvedCli | undefined> {
    const setting = vscode.workspace.getConfiguration("overcast").get<string>("path", "").trim();
    const candidates: ResolvedCli[] = [];
    if (setting) {
      // An explicit setting never falls back to discovery — a wrong path
      // should fail loudly, not be silently papered over.
      if (setting.endsWith(".js") || setting.endsWith(".mjs")) {
        candidates.push({
          cmd: process.execPath,
          argsPrefix: [setting],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          display: `${setting} (via extension-host node)`,
        });
      } else {
        candidates.push({ cmd: setting, argsPrefix: [], env: {}, display: setting });
      }
    } else {
      for (const found of findExecutables("overcast", [...pathDirs(), ...wellKnownBinDirs()])) {
        candidates.push({ cmd: found, argsPrefix: [], env: {}, display: found });
      }
    }
    let resolved: ResolvedCli | null = null;
    for (const candidate of candidates) {
      if (await this.smokeTest(candidate)) {
        resolved = candidate;
        break;
      }
    }
    // Invalidated mid-pass (setting change / restart): the outcome is stale —
    // hand it to whoever awaited THIS pass, but leave the cache to the new one.
    if (gen !== this.resolveGen) return resolved ?? undefined;
    this.resolved = resolved;
    this.resolveFailure = resolved
      ? undefined
      : candidates.length > 0
        ? `The overcast CLI at ${candidates[0].display}${candidates.length > 1 ? ` (and ${candidates.length - 1} other install(s))` : ""} failed to run — see the Overcast output log.`
        : "The overcast CLI was not found on PATH or in the usual install locations.";
    await vscode.commands.executeCommand("setContext", "overcast.cliFound", !!this.resolved);
    if (this.resolved) this.output.appendLine(`overcast cli: ${this.resolved.display}`);
    else
      this.output.appendLine(
        `overcast cli: ${this.resolveFailure} (set overcast.path or install on PATH)`,
      );
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
          env: this.childEnv(cli),
        });
        let stderr = "";
        child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          done(false);
        }, 10_000);
        child.on("error", (e) => {
          clearTimeout(timer);
          this.output.appendLine(`  smoke test ${cli.display}: spawn failed: ${e.message}`);
          done(false);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0 && stderr.trim()) {
            this.output.appendLine(`  smoke test ${cli.display}: exit ${code}: ${stderr.trim()}`);
          }
          done(code === 0);
        });
      } catch {
        done(false);
      }
    });
  }

  /** Env for spawning the resolved CLI. Prepends the resolved binary's own
   *  directory to PATH: an `#!/usr/bin/env node` launcher (nvm/volta installs)
   *  resolves `node` from PATH, and node sits next to the launcher — but a
   *  GUI-launched extension host's PATH lacks that directory even when
   *  discovery (or the overcast.path setting) found the launcher itself. */
  private childEnv(cli: ResolvedCli, extra?: Record<string, string>): NodeJS.ProcessEnv {
    if (process.platform === "win32") return { ...process.env, ...cli.env, ...extra };
    const binDir = path.dirname(cli.cmd);
    const dirs = pathDirs();
    const PATH = dirs.includes(binDir) ? (process.env.PATH ?? "") : [binDir, ...dirs].join(path.delimiter);
    return { ...process.env, PATH, ...cli.env, ...extra };
  }

  /** Resolve or walk the user through fixing the setup. Returns undefined if missing. */
  async ensureCli(): Promise<ResolvedCli | undefined> {
    const cli = await this.resolve();
    if (cli) return cli;
    const pick = await vscode.window.showErrorMessage(
      `${this.resolveFailure ?? "The overcast CLI was not found."} Install it (npm install -g @kdrrr/overcast) or point overcast.path at a binary or a built dist/bin/overcast.js.`,
      "Open Settings",
      "Show Log",
      "Retry",
    );
    if (pick === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "overcast.path");
    } else if (pick === "Show Log") {
      this.output.show(true);
    } else if (pick === "Retry") {
      this.invalidate();
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
        env: this.childEnv(cli, opts.env),
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
        let failure = spawnErr
          ? { kind: "unknown" as const, message: spawnErr.message }
          : failureFor(code, records, stderr);
        // A capped stdout can cut a JSON document mid-stream — parseRecords
        // then yields nothing or a partial set while the exit code is still 0.
        // Never let that pose as a clean result.
        if (!failure && truncated) {
          failure = {
            kind: "unknown" as const,
            message: "output exceeded 64MB and was truncated — results are incomplete",
          };
        }
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

  /** Snapshot of tracked jobs, newest-first: running rows then the finished
   *  ring — scoped to the ACTIVE case. An in-flight run from a previous case
   *  keeps running (and lands nowhere on completion, see finishJob) but must
   *  not render as this case's work: its cancel button and the status-bar
   *  spinner would be aiming at another case folder. */
  get jobs(): readonly Job[] {
    const caseDir = this.locator.caseDir;
    // finished rows are already cleared on switch + cross-case completions
    // dropped; the filter makes the active-case invariant local, not implied
    return [
      ...this.runningJobs.filter((j) => j.caseDir === caseDir),
      ...this.finishedJobs.filter((j) => j.caseDir === caseDir),
    ];
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
      env: this.childEnv(cli, opts.env),
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const cts of this.jobCts.values()) cts.dispose();
    this.jobCts.clear();
    this.jobEmitter.dispose();
  }
}
