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
import type { OvercastRecord } from "../types.ts";
import type { CaseLocator } from "./caseLocator.ts";

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const KILL_ESCALATE_MS = 3000;

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
    );
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
    if (!opts.rawOutput && !args.includes("--json")) finalArgs.push("--json");

    this.output.appendLine(`$ overcast ${finalArgs.slice(cli.argsPrefix.length).join(" ")}`);

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
      const cancelSub = opts.token?.onCancellationRequested(() => {
        this.output.appendLine("  (cancelled — SIGTERM)");
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATE_MS);
      });
      const finish = (code: number, spawnErr?: Error) => {
        cancelSub?.dispose();
        if (killTimer) clearTimeout(killTimer);
        if (truncated) this.output.appendLine("  (stdout truncated at 64MB)");
        const records = parseRecords(stdout);
        const failure = spawnErr
          ? { kind: "unknown" as const, message: spawnErr.message }
          : failureFor(code, records, stderr);
        resolvePromise({ code, records, stdout, stderr, failure });
      };
      child.on("error", (err) => finish(-1, err));
      child.on("close", (code) => finish(code ?? -1));
    });
  }

  /**
   * Run under a cancellable progress notification and surface failures with
   * actionable buttons. Returns undefined when the run failed or was cancelled
   * (already reported to the user).
   */
  async runWithProgress(
    title: string,
    args: string[],
    opts: RunOptions = {},
  ): Promise<CliResult | undefined> {
    const cli = await this.ensureCli();
    if (!cli) return undefined;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_progress, token) => {
        const result = await this.run(args, { ...opts, token });
        if (token.isCancellationRequested) return undefined;
        if (result.failure) {
          await this.surfaceFailure(result);
          return undefined;
        }
        return result;
      },
    );
  }

  private async surfaceFailure(result: CliResult): Promise<void> {
    const failure = result.failure;
    if (!failure) return;
    if (failure.kind === "needs_credentials") {
      const pick = await vscode.window.showWarningMessage(
        `Overcast needs credentials/setup: ${failure.message}`,
        "Run overcast setup",
        "Show Log",
      );
      if (pick === "Run overcast setup") {
        const term = vscode.window.createTerminal({ name: "overcast setup" });
        term.show();
        term.sendText("overcast setup");
      } else if (pick === "Show Log") {
        this.output.show(true);
      }
      return;
    }
    const label = failure.kind === "usage" ? "Overcast (internal argv error)" : "Overcast";
    const pick = await vscode.window.showErrorMessage(`${label}: ${failure.message}`, "Show Log");
    if (pick === "Show Log") this.output.show(true);
  }

  /** Serialized mutation lane (finding accept/dismiss etc. — no double-fires). */
  mutate(args: string[], opts: RunOptions = {}): Promise<CliResult> {
    const next = this.mutateQueue.then(() => this.run(args, opts));
    this.mutateQueue = next.catch(() => undefined);
    return next;
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
  }
}
