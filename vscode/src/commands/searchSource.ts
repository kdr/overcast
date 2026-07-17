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
      // same argv guard as the query/spec inputs — a '-'-leading value is
      // eaten by the CLI parser as a flag, leaving --source valueless
      validateInput: (v) =>
        v.trim().startsWith("-") ? "Filters can't start with '-' (read as a CLI flag)" : undefined,
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
    // a '-'-leading value is not consumed as the flag's value by the CLI parser
    validateInput: (v) =>
      v.trim().startsWith("-") ? "Queries can't start with '-' (read as a CLI flag)" : undefined,
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
  // scan exits non-zero when ANY single source fails (e.g. one
  // credential-gapped source) while healthy sources still returned real hits
  // in the same records stream — keep those hits and warn, like the chat
  // surfaces do; only a hitless failure is surfaced as a plain failure.
  const result = await deps.bridge.runWithProgress(title, args, { keepPartialFailure: true });
  if (!result) return;
  deps.router.refresh();

  const hits = hitsFromRecords(result.records);
  if (hits.length === 0) {
    if (result.cancelled) return; // cancelled before anything usable arrived
    if (result.failure) {
      await deps.bridge.surfaceFailure(result);
      return;
    }
    void vscode.window.showInformationMessage(
      `Overcast: scan of ${filterLabel} returned no hits.`,
    );
    return;
  }
  if (result.cancelled) {
    void vscode.window.showWarningMessage(
      `Overcast: scan cancelled — showing ${hits.length} hit${hits.length === 1 ? "" : "s"} gathered before the cancel.`,
    );
  } else if (result.failure) {
    void vscode.window.showWarningMessage(
      `Overcast: scan of ${filterLabel} partially failed — showing ${hits.length} hit${hits.length === 1 ? "" : "s"} from healthy sources. ${result.failure.message}`,
    );
  }
  await openScanResultsPanel(deps, {
    query: query.trim() || filterLabel,
    source: filter ? filterLabel : undefined,
    hits,
  });
}

// Common source types offered by "Add Source…" (spec: `<type>:<ref>`; the CLI
// accepts any registered type — Custom covers the long tail).
const SOURCE_TYPE_PICKS: Array<vscode.QuickPickItem & { prefix?: string; hint?: string }> = [
  { label: "youtube", description: "@handle · search:<q> · playlist:<id> · URL", prefix: "youtube:", hint: "@handle" },
  { label: "x", description: "@handle · <query> · video:<q> · image:<q>", prefix: "x:", hint: "@handle" },
  { label: "tiktok", description: "@user · #tag", prefix: "tiktok:", hint: "@user" },
  { label: "web", description: "web search query", prefix: "web:", hint: "search terms" },
  { label: "instagram", description: "@handle · #tag · post URL", prefix: "instagram:", hint: "@handle" },
  { label: "telegram", description: "public channel or t.me URL", prefix: "telegram:", hint: "channel" },
  { label: "dl", description: "any yt-dlp URL (Rumble/Odysee/Vimeo/…)", prefix: "dl:", hint: "https://…" },
  { label: "webcam", description: "<lat>,<lng>[,radius] · country:<ISO2>", prefix: "webcam:", hint: "47.36,8.54,20" },
  { label: "gdelttv", description: "broadcast-TV news query (no key)", prefix: "gdelttv:", hint: "\"query\"" },
  { label: "browser", description: "rendered-page watch (URL)", prefix: "browser:", hint: "https://…" },
  { label: "$(edit) Custom…", description: "any <type>:<ref> the CLI accepts" },
];

async function addSourceFlow(deps: ExtDeps): Promise<void> {
  if (!(await deps.bridge.ensureCli())) return;
  if (!deps.locator.caseDir) {
    void vscode.window.showWarningMessage("Overcast: no case selected — pick one first.");
    return;
  }
  const pick = await vscode.window.showQuickPick(SOURCE_TYPE_PICKS, {
    placeHolder: "Source type — where should this case keep looking?",
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!pick) return;
  const spec = await vscode.window.showInputBox({
    prompt: "Source spec (<type>:<ref>)",
    value: pick.prefix ?? "",
    placeHolder: pick.prefix ? `${pick.prefix}${pick.hint}` : "type:ref",
    valueSelection: pick.prefix ? [pick.prefix.length, pick.prefix.length] : undefined,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (t.startsWith("-")) return "Specs can't start with '-' (read as a CLI flag)";
      if (!/^[a-z0-9_-]+:.+/i.test(t)) return "Expected <type>:<ref>, e.g. youtube:@handle";
      return undefined;
    },
  });
  if (!spec?.trim()) return;
  const result = await deps.bridge.runWithProgress(`Adding source ${spec.trim()}`, [
    "source",
    "add",
    spec.trim(),
  ]);
  if (!result) return;
  deps.router.refresh();
  const scanNow = await vscode.window.showInformationMessage(
    `Overcast: source ${spec.trim()} added.`,
    "Scan Now",
  );
  if (scanNow) {
    const p = (result.records[0]?.payload ?? {}) as { id?: unknown };
    await runScanFlow(deps, typeof p.id === "string" ? p.id : undefined);
  }
}

export function registerSearchSource(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.searchSource", () => runScanFlow(deps)),
    vscode.commands.registerCommand("overcast.addSource", () => addSourceFlow(deps)),
    vscode.commands.registerCommand("overcast.scanSourceNode", (node?: unknown) => {
      const sourceId =
        node && typeof node === "object" && typeof (node as { sourceId?: unknown }).sourceId === "string"
          ? (node as { sourceId: string }).sourceId
          : undefined;
      return runScanFlow(deps, sourceId);
    }),
  );
}
