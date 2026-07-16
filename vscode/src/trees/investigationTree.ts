// Investigation sidebar: one collapsible node per line of investigation
// (TargetThread from `case status --json` payload.threads) — label = target
// value, description = stage + funnel, tooltip = question/narrative. Children:
// linked findings (text joined from the model's finding map) + recent evidence
// record ids (click → record detail). Closed lines sort to the bottom, dimmed.
import * as vscode from "vscode";
import type { ExtDeps, TargetThread } from "../types.ts";

function stageIcon(thread: TargetThread): vscode.ThemeIcon {
  if (thread.status === "answered") return new vscode.ThemeIcon("check");
  if (thread.status === "dead-end") return new vscode.ThemeIcon("circle-slash");
  switch (thread.stage) {
    case "answered":
      return new vscode.ThemeIcon("check");
    case "dead-end":
      return new vscode.ThemeIcon("circle-slash");
    case "corroborated":
      return new vscode.ThemeIcon("verified");
    case "leads":
      return new vscode.ThemeIcon("search");
    case "collecting":
      return new vscode.ThemeIcon("sync");
    default:
      return new vscode.ThemeIcon("target");
  }
}

function isClosed(thread: TargetThread): boolean {
  return thread.status === "answered" || thread.status === "dead-end";
}

export class ThreadItem extends vscode.TreeItem {
  constructor(readonly thread: TargetThread) {
    const closed = isClosed(thread);
    const hasChildren =
      (thread.findingIds?.length ?? 0) > 0 || (thread.recentEvidenceIds?.length ?? 0) > 0;
    super(
      thread.value,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const funnel = thread.funnel ?? { scan: 0, captures: 0, senses: 0, matches: 0 };
    const funnelText = `scan ${funnel.scan} · cap ${funnel.captures} · sense ${funnel.senses}`;
    this.description = closed ? `${thread.stage} (closed)` : `${thread.stage} · ${funnelText}`;
    this.iconPath = stageIcon(thread);
    const lines: string[] = [];
    if (thread.question) lines.push(`Q: ${thread.question}`);
    if (thread.narrative) lines.push(thread.narrative);
    lines.push(`stage: ${thread.stage} · status: ${thread.status}`);
    lines.push(funnelText);
    this.tooltip = lines.join("\n\n");
    this.contextValue = "overcast.thread";
    this.id = `thread:${thread.id}`;
  }
}

class ThreadFindingItem extends vscode.TreeItem {
  readonly findingId: string;
  constructor(findingId: string, text: string, status: string) {
    super(text.length > 80 ? `${text.slice(0, 77)}…` : text, vscode.TreeItemCollapsibleState.None);
    this.findingId = findingId;
    this.description = status;
    this.iconPath = new vscode.ThemeIcon(
      status === "accepted" ? "star-full" : status === "dismissed" ? "trash" : "lightbulb",
    );
    this.contextValue = "overcast.finding";
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [findingId],
    };
  }
}

class ThreadEvidenceItem extends vscode.TreeItem {
  readonly recordId: string;
  constructor(recordId: string, verb: string | undefined) {
    super(verb ? `${verb} ${recordId}` : recordId, vscode.TreeItemCollapsibleState.None);
    this.recordId = recordId;
    this.iconPath = new vscode.ThemeIcon("file-media");
    this.contextValue = "overcast.record";
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [recordId],
    };
  }
}

export class InvestigationTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: ExtDeps) {
    deps.model.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      const threads = this.deps.model.status?.threads ?? [];
      const open = threads.filter((t) => !isClosed(t));
      const closed = threads.filter(isClosed);
      return [...open, ...closed].map((t) => new ThreadItem(t));
    }
    if (element instanceof ThreadItem) {
      const items: vscode.TreeItem[] = [];
      const verbById = new Map(this.deps.model.records.map((r) => [r.id, r.verb]));
      for (const fid of element.thread.findingIds ?? []) {
        const f = this.deps.model.findings.get(fid);
        items.push(new ThreadFindingItem(fid, f?.text ?? fid, f?.status ?? "open"));
      }
      for (const rid of element.thread.recentEvidenceIds ?? []) {
        items.push(new ThreadEvidenceItem(rid, verbById.get(rid)));
      }
      return items;
    }
    return [];
  }
}
