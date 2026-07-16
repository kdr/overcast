// Triage sidebar: suggested findings awaiting review (`case status --json`
// payload.triage) — inline ✓/✗ via contextValue "overcast.finding"; click
// opens the finding record. The activity-bar badge count is set in
// extension.ts from the same payload.
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

export class TriageItem extends vscode.TreeItem {
  readonly findingId: string;
  constructor(row: {
    id: string;
    text: string;
    confidence?: string;
    score?: number;
    excerpt?: string;
    url?: string;
  }) {
    super(row.text, vscode.TreeItemCollapsibleState.None);
    this.findingId = row.id;
    const parts: string[] = [];
    if (row.confidence) parts.push(row.confidence);
    if (typeof row.score === "number") parts.push(`score ${row.score}`);
    this.description = parts.join(" · ");
    const tooltipLines = [
      `Suggested lead — ${row.text}`,
      "",
      "✓ Accept as evidence (promotes it into ask/brief)",
      "🗑 Dismiss (not relevant — never re-fires)",
    ];
    if (row.excerpt) tooltipLines.push("", row.excerpt);
    if (row.url) tooltipLines.push("", row.url);
    this.tooltip = tooltipLines.join("\n");
    this.iconPath = new vscode.ThemeIcon("lightbulb");
    this.contextValue = "overcast.finding";
    this.id = `triage:${row.id}`;
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [row.id],
    };
  }
}

export class TriageTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: ExtDeps) {
    deps.model.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    const rows = this.deps.model.status?.triage ?? [];
    return rows.map(
      (r) =>
        new TriageItem(
          r as {
            id: string;
            text: string;
            confidence?: string;
            score?: number;
            excerpt?: string;
            url?: string;
          },
        ),
    );
  }
}
