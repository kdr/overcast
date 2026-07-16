// Sources & Monitors sidebar: per-source coverage rows (`case status --json`
// payload.coverage — SourceCoverage) with humanized last-scan freshness and
// the hits/captured/sensed funnel. Never-scanned enabled sources ("gap") get a
// warning icon. contextValue "overcast.source" + .sourceId powers "Scan Now…".
import * as vscode from "vscode";
import type { ExtDeps, SourceCoverage } from "../types.ts";

export function humanizeAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "never scanned";
  if (seconds < 60) return "scanned just now";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `scanned ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `scanned ${h}h ago`;
  return `scanned ${Math.floor(h / 24)}d ago`;
}

export class SourceItem extends vscode.TreeItem {
  readonly sourceId: string;
  constructor(row: SourceCoverage) {
    super(row.spec ?? row.id, vscode.TreeItemCollapsibleState.None);
    this.sourceId = row.id;
    const freshness = row.gap ? "never scanned" : humanizeAge(row.lastScanAgeSeconds);
    this.description = `${freshness} · hits ${row.hits} · cap ${row.captured} · sensed ${row.sensed}`;
    this.iconPath = row.gap
      ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
      : new vscode.ThemeIcon(row.enabled === false ? "circle-slash" : "rss");
    this.tooltip = [
      `${row.spec ?? row.id} (${row.type})`,
      row.enabled === false ? "disabled" : "enabled",
      freshness,
      `hits ${row.hits} · captured ${row.captured} · sensed ${row.sensed}`,
      row.gap ? "⚠ enabled but never scanned" : "",
    ]
      .filter(Boolean)
      .join("\n");
    this.contextValue = "overcast.source";
    this.id = `source:${row.id}`;
  }
}

export class SourcesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
    const coverage = this.deps.model.status?.coverage ?? [];
    return coverage.map((row) => new SourceItem(row));
  }
}
