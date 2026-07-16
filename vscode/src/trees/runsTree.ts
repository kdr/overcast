// Runs sidebar (collapsed by default): every tracked CLI invocation as a row —
// running jobs on top with a spinner + live elapsed, then the finished ring
// (newest-first). Data + the change event come straight off the CliBridge job
// tracker; nothing here calls the CLI. Running rows carry contextValue
// "overcast.run.running" so the inline Cancel action shows; finished rows with a
// record id deep-link via overcast.openRecord. A 1s re-render timer runs ONLY
// while ≥1 job is running (no idle timers).
import * as vscode from "vscode";
import { formatDuration, type Job } from "../lib/jobs.ts";
import type { ExtDeps } from "../types.ts";

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

class RunItem extends vscode.TreeItem {
  readonly jobId: string;
  constructor(job: Job) {
    super(job.label, vscode.TreeItemCollapsibleState.None);
    this.jobId = job.id;
    this.id = `run:${job.id}`;
    if (job.state === "running") {
      this.iconPath = new vscode.ThemeIcon("sync~spin");
      this.description = formatDuration(Date.now() - job.startedAt);
      this.contextValue = "overcast.run.running";
      this.tooltip = `${job.label}\nrunning…`;
      return;
    }
    const dur = job.endedAt ? formatDuration(job.endedAt - job.startedAt) : "";
    if (job.state === "ok") {
      this.iconPath = new vscode.ThemeIcon("check");
      this.description = dur;
    } else if (job.state === "failed") {
      this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"));
      this.description = job.failure ? `${dur} · ${truncate(job.failure)}` : dur;
    } else {
      this.iconPath = new vscode.ThemeIcon("circle-slash");
      this.description = `${dur} · cancelled`;
    }
    this.contextValue = "overcast.run.done";
    this.tooltip = [job.label, job.state, job.failure ?? "", job.recordId ?? ""]
      .filter(Boolean)
      .join("\n");
    if (job.recordId) {
      this.command = { command: "overcast.openRecord", title: "Open Record", arguments: [job.recordId] };
    }
  }
}

export class RunsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private tickTimer: NodeJS.Timeout | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: ExtDeps) {
    this.subs.push(deps.bridge.onDidChangeJobs(() => this.onJobsChanged()));
  }

  private onJobsChanged(): void {
    this.emitter.fire();
    this.syncTimer();
  }

  // Re-render each second only while something is running (so elapsed ticks);
  // stop the timer the moment the last job finishes.
  private syncTimer(): void {
    const anyRunning = this.deps.bridge.jobs.some((j) => j.state === "running");
    if (anyRunning && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.emitter.fire(), 1000);
    } else if (!anyRunning && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    return this.deps.bridge.jobs.map((j) => new RunItem(j));
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const d of this.subs) d.dispose();
    this.emitter.dispose();
  }
}
