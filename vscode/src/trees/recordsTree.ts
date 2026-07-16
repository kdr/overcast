// Records sidebar: the record trail (`case records --json` compact rows —
// returned OLDEST-first by the CLI, reversed here) grouped by verb, rows
// newest-first inside each group. contextValue "overcast.record"; click opens
// the record detail panel.
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtDeps, RecordRow } from "../types.ts";

class VerbGroupItem extends vscode.TreeItem {
  constructor(
    readonly verb: string,
    count: number,
  ) {
    super(verb, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon("folder");
    this.id = `verbgroup:${verb}`;
  }
}

export class RecordItem extends vscode.TreeItem {
  readonly recordId: string;
  constructor(row: RecordRow) {
    super(row.id, vscode.TreeItemCollapsibleState.None);
    this.recordId = row.id;
    const parts: string[] = [];
    if (row.state && row.state !== "ready") parts.push(row.state);
    if (row.media) parts.push(path.basename(row.media));
    if (row.at !== null && row.at !== undefined) parts.push(`@${row.at}`);
    this.description = parts.join(" · ");
    this.iconPath =
      row.state === "error"
        ? new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"))
        : row.state === "pending"
          ? new vscode.ThemeIcon("clock")
          : new vscode.ThemeIcon(row.media ? "file-media" : "note");
    this.tooltip = [row.id, `verb: ${row.verb}`, row.state ? `state: ${row.state}` : "", row.media ?? ""]
      .filter(Boolean)
      .join("\n");
    this.contextValue = "overcast.record";
    this.id = `record:${row.id}`;
    this.command = {
      command: "overcast.openRecord",
      title: "Open Record",
      arguments: [row.id],
    };
  }
}

export class RecordsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: ExtDeps) {
    deps.model.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const newestFirst = [...this.deps.model.records].reverse();
    if (!element) {
      const counts = new Map<string, number>();
      for (const r of newestFirst) counts.set(r.verb, (counts.get(r.verb) ?? 0) + 1);
      return [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([verb, count]) => new VerbGroupItem(verb, count));
    }
    if (element instanceof VerbGroupItem) {
      return newestFirst.filter((r) => r.verb === element.verb).map((r) => new RecordItem(r));
    }
    return [];
  }
}
