// Sources & Monitors sidebar: per-source coverage rows (`case status --json`
// payload.coverage — SourceCoverage) with humanized last-scan freshness and
// the hits/captured/sensed funnel. Never-scanned enabled sources ("gap") get a
// warning icon. contextValue "overcast.source" + .sourceId powers "Scan Now…".
//
// A source expands into the media it grabbed (coverage row `media` items —
// capture provenance), and an "Analyzed media" folder at the root groups every
// media ref that has ≥1 sense record (computed client-side from the compact
// record rows). Media rows carry resourceUri so the senses context submenu
// (resourceExtname-gated, shared with the Explorer) applies to local files.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { analyzedMedia } from "../lib/analyzedMedia.ts";
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
  constructor(readonly row: SourceCoverage) {
    super(
      row.spec ?? row.id,
      (row.media?.length ?? 0) > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
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

/** A grabbed/analyzed media row. Local files get resourceUri (file icon +
 *  resourceExtname-gated senses submenu); click opens the linked record. */
export class MediaItem extends vscode.TreeItem {
  readonly recordId: string;
  constructor(opts: {
    idPrefix: string;
    ref: string;
    recordId: string;
    title?: string;
    detail: string;
    tooltipLines?: string[];
  }) {
    const isLocal = path.isAbsolute(opts.ref) && fs.existsSync(opts.ref);
    super(
      opts.title ?? path.basename(opts.ref),
      vscode.TreeItemCollapsibleState.None,
    );
    this.recordId = opts.recordId;
    this.description = opts.detail;
    if (isLocal) {
      this.resourceUri = vscode.Uri.file(opts.ref);
      this.contextValue = "overcast.media.file";
    } else {
      this.iconPath = new vscode.ThemeIcon("file-media");
      this.contextValue = "overcast.media";
    }
    this.tooltip = [opts.title ?? "", opts.ref, ...(opts.tooltipLines ?? [])]
      .filter(Boolean)
      .join("\n");
    // recordId is part of the identity: a source can capture the same ref more
    // than once (one row per capture record) — a ref-only id would collide,
    // breaking tree identity and deep-linking the wrong record.
    this.id = `${opts.idPrefix}:${opts.recordId}:${opts.ref}`;
    this.command = { command: "overcast.openRecord", title: "Open Record", arguments: [opts.recordId] };
  }
}

class AnalyzedFolderItem extends vscode.TreeItem {
  constructor(count: number) {
    super("Analyzed media", vscode.TreeItemCollapsibleState.Collapsed);
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon("telescope");
    this.tooltip = "Every media file with at least one sense/forensics record in this case.";
    this.contextValue = "overcast.analyzedFolder";
    this.id = "analyzed-media";
  }
}

class IndexesFolderItem extends vscode.TreeItem {
  constructor(count: number) {
    super("Indexes", vscode.TreeItemCollapsibleState.Collapsed);
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon("database");
    this.tooltip =
      "The case's search destinations: typed remote tinycloud indexes and local DBs (face/CLIP/CLAP/audio-fp/voice-print/…).";
    this.contextValue = "overcast.indexesFolder";
    this.id = "indexes";
  }
}

class IndexItem extends vscode.TreeItem {
  constructor(info: { id: string; type: string; backend?: string; name?: string; members?: number }) {
    super(info.name || info.id, vscode.TreeItemCollapsibleState.None);
    const bits = [info.type];
    if (typeof info.members === "number") bits.push(`${info.members} member${info.members === 1 ? "" : "s"}`);
    this.description = bits.join(" · ");
    this.iconPath = new vscode.ThemeIcon(info.backend === "local" ? "server" : "cloud");
    this.tooltip = [
      info.name ? `${info.name} (${info.id})` : info.id,
      `type: ${info.type}`,
      info.backend ? `backend: ${info.backend}` : "",
      typeof info.members === "number" ? `${info.members} member(s)` : "",
    ]
      .filter(Boolean)
      .join("\n");
    this.contextValue = "overcast.index";
    this.id = `index:${info.id}`;
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

  // Roots only (layout-nudge reveal support).
  getParent(): vscode.TreeItem | undefined {
    return undefined;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof SourceItem) {
      // One vocabulary with the Analyzed-media folder: derive the label from
      // the SAME rollup (verbs listed when we have them), with the pulse
      // `sensed` flag as fallback for refs whose analysis records fell outside
      // the model's compact record window.
      const byRef = new Map(analyzedMedia(this.deps.model.records).map((a) => [a.ref, a]));
      const items: vscode.TreeItem[] = (element.row.media ?? []).map((m) => {
        const rollup = byRef.get(m.ref);
        const analyzed = !!rollup || m.sensed;
        return new MediaItem({
          idPrefix: `srcmedia:${element.sourceId}`,
          ref: m.ref,
          recordId: m.record,
          title: m.title,
          detail: rollup ? rollup.verbs.join(" · ") : analyzed ? "analyzed" : "not analyzed",
          tooltipLines: [
            analyzed
              ? `✓ analyzed${rollup ? `: ${rollup.verbs.join(", ")}` : ""}`
              : "grabbed, not yet analyzed",
          ],
        });
      });
      // coverage.media is capped (newest 50) while `captured` counts them all —
      // say so instead of silently omitting the older grabs
      const hidden = element.row.captured - items.length;
      if (hidden > 0) {
        const more = new vscode.TreeItem(`… ${hidden} older grab${hidden === 1 ? "" : "s"}`);
        more.description = "see Records";
        more.iconPath = new vscode.ThemeIcon("ellipsis");
        more.tooltip = "The tree shows this source's newest grabs; the full capture trail lives in the Records view.";
        more.id = `srcmedia:${element.sourceId}:more`;
        items.push(more);
      }
      return items;
    }
    if (element instanceof AnalyzedFolderItem) {
      return analyzedMedia(this.deps.model.records).map(
        (m) =>
          new MediaItem({
            idPrefix: "analyzed",
            ref: m.ref,
            recordId: m.recordId,
            detail: m.verbs.join(" · "),
            tooltipLines: [`analyzed by: ${m.verbs.join(", ")}`],
          }),
      );
    }
    if (element instanceof IndexesFolderItem) {
      return this.deps.model.indexes.map((i) => new IndexItem(i));
    }
    if (element) return [];
    const coverage = this.deps.model.status?.coverage ?? [];
    const items: vscode.TreeItem[] = coverage.map((row) => new SourceItem(row));
    const analyzed = analyzedMedia(this.deps.model.records);
    if (analyzed.length > 0) items.push(new AnalyzedFolderItem(analyzed.length));
    const indexes = this.deps.model.indexes;
    if (indexes.length > 0) items.push(new IndexesFolderItem(indexes.length));
    return items;
  }
}
