// Overcast for VS Code — activation wiring. The extension is a thin client of
// the overcast CLI: services read the case via `--json` calls + fs watching,
// panels display the CLI's own generated HTML, and every mutation goes through
// a spawned `overcast …` (never a library import — see CLAUDE.md invariants).
import * as vscode from "vscode";
import { registerChatParticipant } from "./chat/participant.ts";
import { registerChatTools } from "./chat/tools.ts";
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
    openRecord: (recordId, caseDir) => openRecordPanel(deps, recordId, caseDir),
    refresh: () => void model.refresh(),
  };
  const deps: ExtDeps = { context, output, bridge, locator, model, registry, router };
  const artifacts = registerArtifactPanels(deps);

  // ---- command deck (webview view, pinned at the top of the container) ----
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "overcast.deck",
      new CommandDeckProvider(deps, () => void nudgeLayout()),
    ),
  );

  // ---- sidebar trees ----
  const trees: [string, vscode.TreeDataProvider<vscode.TreeItem>][] = [
    ["overcast.investigation", new InvestigationTreeProvider(deps)],
    ["overcast.sources", new SourcesTreeProvider(deps)],
    ["overcast.records", new RecordsTreeProvider(deps)],
  ];
  const views = new Map<string, vscode.TreeView<vscode.TreeItem>>();
  const providers = new Map<string, vscode.TreeDataProvider<vscode.TreeItem>>();
  for (const [id, provider] of trees) {
    const view = vscode.window.createTreeView(id, {
      treeDataProvider: provider,
      // Sources media rows expose "Analyze All Selected" (listMultiSelection-
      // gated in package.json) — without multi-select that entry can never fire
      canSelectMany: id === "overcast.sources",
    });
    views.set(id, view);
    providers.set(id, provider);
    context.subscriptions.push(view);
  }

  // ---- one-time layout nudge ------------------------------------------------
  // VS Code persists per-workspace section collapse/size state, and a stale
  // layout (tree sections collapsed at the bottom, the deck webview filling the
  // sidebar) survives reinstalls — `initialSize` only applies to fresh state.
  // When the Overcast container first becomes visible, reveal one root element
  // in each tree (focus/select-less reveal expands a collapsed section), so the
  // sections open top-down and the deck gives the space back. Runs stays
  // collapsed by design. Marked done per-workspace only after every tree had
  // content to expand (an empty tree can't be revealed — retry next time).
  const NUDGE_KEY = "overcast.layoutNudge.v1";
  let nudging = false;
  const nudgeLayout = async (): Promise<void> => {
    if (nudging || context.workspaceState.get<boolean>(NUDGE_KEY)) return;
    nudging = true;
    try {
      let allExpanded = true;
      for (const id of ["overcast.investigation", "overcast.sources", "overcast.records"]) {
        const view = views.get(id);
        const provider = providers.get(id);
        if (!view || !provider) continue;
        const roots = await provider.getChildren();
        const first = roots?.[0];
        if (!first) {
          allExpanded = false; // nothing to reveal yet (model still loading / empty case)
          continue;
        }
        try {
          await view.reveal(first, { focus: false, select: false, expand: false });
        } catch {
          allExpanded = false; // view gone mid-flight — retry on next visibility
        }
      }
      if (allExpanded) await context.workspaceState.update(NUDGE_KEY, true);
    } finally {
      nudging = false;
    }
  };
  // The deck's visibility callback handles the "container already open" case;
  // also retry once the model delivers data while the container is visible.
  context.subscriptions.push(
    model.onDidChange(() => {
      if (views.get("overcast.investigation")?.visible) void nudgeLayout();
    }),
  );
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

  // ---- chat: @overcast participant + overcast_* language-model tools ----
  // Both APIs are stable in VS Code ≥1.96; guard the whole wiring so exotic hosts
  // that lack the chat / language-model-tool API skip it cleanly.
  if (
    typeof vscode.chat?.createChatParticipant === "function" &&
    typeof (vscode as { lm?: { registerTool?: unknown } }).lm?.registerTool === "function"
  ) {
    registerChatTools(deps);
    registerChatParticipant(deps);
  }

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
