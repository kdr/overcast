// "Overcast: Search Source…" (+ the tree "Scan Now…" on a source node).
//
// Verified CLI surface (scan --help, v0.0.9): scan has NO positional — the
// query is `--query <string>` (ad-hoc keyword; each source's bound ref is the
// default), `--source <string>` restricts to source ids/types (comma list),
// plus `--since` / `--limit`. Hit records: verb "scan", payload
// {title, url, snippet, published, source, source_id} (+ top-level media.ref);
// pull-progress rows carry payload.op === "pull_progress" and are skipped.
import * as vscode from "vscode";
import type { ScanHit } from "../shared/protocol.ts";
import type { ExtDeps, OvercastRecord } from "../types.ts";
import { openScanResultsPanel } from "../panels/scanResultsPanel.ts";

interface SourcePick extends vscode.QuickPickItem {
  /** value for --source (undefined = all enabled sources) */
  filter?: string;
  custom?: boolean;
}

async function pickSourceFilter(deps: ExtDeps): Promise<SourcePick | undefined> {
  const sources = deps.model.status?.sources ?? [];
  const items: SourcePick[] = [
    {
      label: "$(broadcast) All enabled sources",
      description: sources.length ? `${sources.filter((s) => s.enabled !== false).length} enabled` : "",
    },
  ];
  for (const s of sources) {
    items.push({
      label: `$(rss) ${s.type}:${s.ref}`,
      description: [s.name, s.enabled === false ? "(disabled)" : ""].filter(Boolean).join(" "),
      filter: s.id,
    });
  }
  items.push({
    label: "$(edit) Custom source filter…",
    description: "restrict by source ids/types (comma list)",
    custom: true,
  });
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Scan which source(s)?",
    ignoreFocusOut: true,
  });
  if (!pick) return undefined;
  if (pick.custom) {
    const raw = await vscode.window.showInputBox({
      prompt: "Source ids/types (comma list), e.g. youtube,web or src_ab12cd",
      ignoreFocusOut: true,
    });
    if (raw === undefined) return undefined;
    return { label: raw.trim(), filter: raw.trim() || undefined };
  }
  return pick;
}

export function hitsFromRecords(records: OvercastRecord[]): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const r of records) {
    if (r.verb !== "scan") continue;
    const p = (r.payload ?? {}) as Record<string, unknown>;
    if (p.op === "pull_progress") continue;
    if (r.state === "error") continue;
    const str = (k: string): string | undefined =>
      typeof p[k] === "string" && (p[k] as string).length > 0 ? (p[k] as string) : undefined;
    hits.push({
      index: hits.length,
      id: r.id,
      title: str("title"),
      url: str("url"),
      excerpt: str("snippet"),
      source: str("source"),
      time: str("published"),
    });
  }
  return hits;
}

async function runScanFlow(deps: ExtDeps, preselectedSourceId?: string): Promise<void> {
  if (!(await deps.bridge.ensureCli())) return;

  let filter = preselectedSourceId;
  let filterLabel = "all enabled sources";
  if (preselectedSourceId) {
    const src = (deps.model.status?.sources ?? []).find((s) => s.id === preselectedSourceId);
    filterLabel = src ? `${src.type}:${src.ref}` : preselectedSourceId;
  } else {
    const pick = await pickSourceFilter(deps);
    if (!pick) return;
    filter = pick.filter;
    filterLabel = pick.filter ? pick.label.replace(/^\$\([^)]+\)\s*/, "") : "all enabled sources";
  }

  const query = await vscode.window.showInputBox({
    prompt: "Ad-hoc keyword (--query) — leave empty to scan each source's bound ref",
    ignoreFocusOut: true,
  });
  if (query === undefined) return;

  const since = await vscode.window.showQuickPick(
    [
      { label: "No recency filter", value: undefined },
      { label: "Last 24 hours", value: "24h" },
      { label: "Last 7 days", value: "7d" },
      { label: "Last 30 days", value: "30d" },
    ],
    { placeHolder: "Only items newer than… (--since)", ignoreFocusOut: true },
  );
  if (!since) return;

  const limitRaw = await vscode.window.showInputBox({
    prompt: "Max hits per source (--limit) — empty for no cap",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === "" || /^\d+$/.test(v.trim()) ? undefined : "whole number or empty"),
  });
  if (limitRaw === undefined) return;

  const args = ["scan"];
  if (filter) args.push("--source", filter);
  if (query.trim()) args.push("--query", query.trim());
  if (since.value) args.push("--since", since.value);
  if (limitRaw.trim()) args.push("--limit", limitRaw.trim());

  const title = query.trim()
    ? `Scanning ${filterLabel} for “${query.trim()}”`
    : `Scanning ${filterLabel}`;
  const result = await deps.bridge.runWithProgress(title, args);
  if (!result) return;
  deps.router.refresh();

  const hits = hitsFromRecords(result.records);
  if (hits.length === 0) {
    void vscode.window.showInformationMessage(
      `Overcast: scan of ${filterLabel} returned no hits.`,
    );
    return;
  }
  await openScanResultsPanel(deps, {
    query: query.trim() || filterLabel,
    source: filter ? filterLabel : undefined,
    hits,
  });
}

export function registerSearchSource(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.searchSource", () => runScanFlow(deps)),
    vscode.commands.registerCommand("overcast.scanSourceNode", (node?: unknown) => {
      const sourceId =
        node && typeof node === "object" && typeof (node as { sourceId?: unknown }).sourceId === "string"
          ? (node as { sourceId: string }).sourceId
          : undefined;
      return runScanFlow(deps, sourceId);
    }),
  );
}
