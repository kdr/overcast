// Overcast for VS Code — activation wiring. The extension is a thin client of
// the overcast CLI: services read the case via `--json` calls + fs watching,
// panels display the CLI's own generated HTML, and every mutation goes through
// a spawned `overcast …` (never a library import — see CLAUDE.md invariants).
import * as vscode from "vscode";
import { registerCaseCommands } from "./commands/caseCommands.ts";
import { registerContextVerbs } from "./commands/contextVerbs.ts";
import { registerExportCommands } from "./commands/exportCommands.ts";
import { registerFindingCommands } from "./commands/findingCommands.ts";
import { registerInitCase } from "./commands/initCase.ts";
import { registerNoteCommands } from "./commands/noteCommands.ts";
import { registerRunVerb } from "./commands/runVerb.ts";
import { registerSearchSource } from "./commands/searchSource.ts";
import { registerArtifactPanels } from "./panels/artifactPanel.ts";
import { openRecordPanel } from "./panels/recordPanel.ts";
import { openSituationPanel } from "./panels/situationPanel.ts";
import { CaseLocator } from "./services/caseLocator.ts";
import { CaseStatusModel } from "./services/caseStatusModel.ts";
import { CliBridge } from "./services/cliBridge.ts";
import { SituationServerManager } from "./services/situationServer.ts";
import { VerbRegistry } from "./services/verbRegistry.ts";
import { InvestigationTreeProvider } from "./trees/investigationTree.ts";
import { RecordsTreeProvider } from "./trees/recordsTree.ts";
import { RunsTreeProvider } from "./trees/runsTree.ts";
import { SourcesTreeProvider } from "./trees/sourcesTree.ts";
import { CommandDeckProvider } from "./views/commandDeck.ts";
import type { ExtDeps, PanelRouter } from "./types.ts";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Overcast");
  context.subscriptions.push(output);

  const locator = new CaseLocator(context);
  const bridge = new CliBridge(output, locator);
  const model = new CaseStatusModel(bridge, locator);
  const registry = new VerbRegistry(bridge, context);
  context.subscriptions.push(locator, bridge, model);

  // Router methods close over `deps`, which is assigned immediately below —
  // nothing invokes them synchronously during activation.
  const router: PanelRouter = {
    openArtifact: async (absPath, title) => artifacts.open(absPath, title),
    openRecord: (recordId) => openRecordPanel(deps, recordId),
    refresh: () => void model.refresh(),
  };
  const deps: ExtDeps = { context, output, bridge, locator, model, registry, router };
  const artifacts = registerArtifactPanels(deps);

  // ---- command deck (webview view, pinned at the top of the container) ----
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("overcast.deck", new CommandDeckProvider(deps)),
  );

  // ---- sidebar trees ----
  const trees: [string, vscode.TreeDataProvider<vscode.TreeItem>][] = [
    ["overcast.investigation", new InvestigationTreeProvider(deps)],
    ["overcast.sources", new SourcesTreeProvider(deps)],
    ["overcast.records", new RecordsTreeProvider(deps)],
  ];
  const views = new Map<string, vscode.TreeView<vscode.TreeItem>>();
  for (const [id, provider] of trees) {
    const view = vscode.window.createTreeView(id, { treeDataProvider: provider });
    views.set(id, view);
    context.subscriptions.push(view);
  }
  // The triage-count badge lives on Investigation now (Triage merged into it).
  context.subscriptions.push(
    model.onDidChange(() => {
      const count = deps.model.status?.triage?.length ?? 0;
      const investigationBadgeView = views.get("overcast.investigation");
      if (investigationBadgeView) {
        investigationBadgeView.badge =
          count > 0
            ? { value: count, tooltip: `${count} suggested finding(s) awaiting review` }
            : undefined;
      }
    }),
  );

  // ---- runs (CLI job tracker): a tree + a running-count badge + a status-bar
  // spinner. All three ride the bridge's onDidChangeJobs event. ----
  const runsTree = new RunsTreeProvider(deps);
  const runsView = vscode.window.createTreeView("overcast.runs", { treeDataProvider: runsTree });
  const runsStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  runsStatus.command = "overcast.runs.focus"; // auto-registered per view
  context.subscriptions.push(
    runsTree,
    runsView,
    runsStatus,
    bridge.onDidChangeJobs(() => {
      const running = bridge.jobs.filter((j) => j.state === "running").length;
      runsView.badge = running
        ? { value: running, tooltip: `${running} overcast run(s) in progress` }
        : undefined;
      if (running > 0) {
        runsStatus.text = `$(sync~spin) overcast: ${running}`;
        runsStatus.tooltip = `${running} overcast run(s) in progress — click to show Runs`;
        runsStatus.show();
      } else {
        runsStatus.hide();
      }
    }),
    vscode.commands.registerCommand("overcast.cancelRun", (node?: unknown) => {
      const id = (node as { jobId?: unknown } | undefined)?.jobId;
      if (typeof id === "string") bridge.cancelJob(id);
    }),
    vscode.commands.registerCommand("overcast.clearRuns", () => bridge.clearFinishedJobs()),
  );

  // ---- open the agent terminal when the view is opened with no editors ----
  // (once per session, setting-gated). The agent waits for input, so this only
  // surfaces the interface — it spends nothing until the user types.
  let agentTerminalOffered = false;
  const investigationView = views.get("overcast.investigation");
  if (investigationView) {
    context.subscriptions.push(
      investigationView.onDidChangeVisibility((e) => {
        if (!e.visible || agentTerminalOffered) return;
        const enabled = vscode.workspace
          .getConfiguration("overcast")
          .get<boolean>("agentTerminalOnOpen", true);
        if (!enabled || vscode.window.visibleTextEditors.length > 0 || !locator.caseDir) return;
        agentTerminalOffered = true;
        void vscode.commands.executeCommand("overcast.openAgentTerminal");
      }),
    );
  }

  // ---- situation (opens as an editor tab) ----
  const situation = new SituationServerManager(deps);
  context.subscriptions.push(situation);

  // ---- commands ----
  registerInitCase(deps);
  registerCaseCommands(deps);
  registerNoteCommands(deps);
  registerFindingCommands(deps);
  registerExportCommands(deps);
  registerRunVerb(deps);
  registerContextVerbs(deps);
  registerSearchSource(deps);
  context.subscriptions.push(
    vscode.commands.registerCommand("overcast.refresh", () => void model.refresh()),
    vscode.commands.registerCommand("overcast.situationOpen", () => openSituationPanel(deps, situation)),
    vscode.commands.registerCommand("overcast.situationStop", () => situation.stop()),
  );

  // ---- boot ----
  context.subscriptions.push(locator.onDidChangeCase(() => void model.refresh()));
  await bridge.resolve();
  await locator.refresh();
  model.startWatching(context);
  await model.refresh();
  output.appendLine(
    `overcast extension activated${locator.caseDir ? ` — case: ${locator.caseDir}` : " — no case located"}`,
  );
}

export function deactivate(): void {
  // Long-lived children (situation serve) are killed via their Disposables in
  // context.subscriptions; nothing extra to do here.
}
