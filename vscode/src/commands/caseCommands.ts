// Case management UX: a picker (status bar + palette) to switch the active case
// without editing settings, an explorer folder action to adopt/initialize a
// folder as the case, launching the interactive overcast AGENT in a terminal,
// and a CLI restart. The active-case override lives in workspaceState (see
// CaseLocator.setChosenCase) so it survives reloads and beats auto-detection.
import * as path from "node:path";
import * as vscode from "vscode";
import { hasCaseStore } from "../services/caseLocator.ts";
import type { ExtDeps } from "../types.ts";

const OVERCAST_VIEW = "workbench.view.extension.overcast";

async function focusOvercastView(): Promise<void> {
  try {
    await vscode.commands.executeCommand(OVERCAST_VIEW);
  } catch {
    /* view container not ready — non-fatal */
  }
}

export function registerCaseCommands(deps: ExtDeps): void {
  const { context, locator, bridge, model, output } = deps;

  // ---- switch the active case (status-bar item + palette) -------------------
  const selectCase = vscode.commands.registerCommand("overcast.selectCase", async () => {
    const cases = await locator.listCases();
    type Item = vscode.QuickPickItem & { dir?: string; action?: "init" | "browse" | "clear" };
    const items: Item[] = cases.map((c) => ({
      label: `$(cloud) ${c.name}`,
      description: c.dir === locator.caseDir ? "active" : undefined,
      detail: c.dir,
      dir: c.dir,
    }));
    items.push(
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(new-folder) Initialize a new case here…", action: "init" },
      { label: "$(folder-opened) Choose another folder…", action: "browse" },
    );
    if (context.workspaceState.get<string>("overcast.chosenCaseDir")) {
      items.push({ label: "$(discard) Clear override (auto-detect)", action: "clear" });
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select the active overcast case",
      matchOnDetail: true,
    });
    if (!pick) return;
    if (pick.dir) {
      await locator.setChosenCase(pick.dir);
      await focusOvercastView();
      return;
    }
    if (pick.action === "clear") {
      await locator.setChosenCase(undefined);
      return;
    }
    if (pick.action === "init") {
      await vscode.commands.executeCommand("overcast.initCase");
      return;
    }
    if (pick.action === "browse") {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Use as overcast case",
      });
      if (!picked?.[0]) return;
      await adoptFolder(deps, picked[0].fsPath);
    }
  });

  // ---- explorer folder → adopt as case (init if needed) + open the view -----
  const openInOvercast = vscode.commands.registerCommand(
    "overcast.openInOvercast",
    async (uri?: vscode.Uri) => {
      const dir = uri?.fsPath;
      if (!dir) return;
      await adoptFolder(deps, dir);
    },
  );

  // ---- launch the interactive overcast AGENT (TUI) in a terminal ------------
  const openTerminal = vscode.commands.registerCommand("overcast.openAgentTerminal", async () => {
    const cli = await bridge.ensureCli();
    if (!cli) return;
    const caseDir = locator.caseDir;
    if (!caseDir) {
      void vscode.window.showWarningMessage("Overcast: no case selected — pick one first.");
      return;
    }
    // Open in the EDITOR area (a tab), not the bottom panel — the agent TUI is
    // a full-window experience, so it belongs where files open.
    const term = vscode.window.createTerminal({
      name: `overcast · ${locator.caseName ?? ""}`.trim(),
      cwd: caseDir,
      location: vscode.TerminalLocation.Editor,
      // node-runner mode relaunches the resolved runner, which needs
      // ELECTRON_RUN_AS_NODE in the terminal's env
      env: bridge.terminalEnv(cli),
    });
    term.show();
    // Launch the interactive agent (TUI) via bridge.terminalLaunch: node-runner
    // aware (reuses the SAME resolved runner every spawned run uses — a bare
    // `node` may not be on the terminal's PATH), and carrying the same
    // --profile/--home settings as every spawned run.
    // Records the agent writes land in .overcast/ (the sidebar auto-refreshes);
    // the agent opens its own HTML artifacts in the OS browser — open them here
    // from the Records tree to get a webview panel instead.
    term.sendText(bridge.terminalLaunch(cli));
  });

  // ---- case setup wizard (agent-guided → its own terminal) ------------------
  const caseSetup = vscode.commands.registerCommand("overcast.caseSetup", async () => {
    const cli = await bridge.ensureCli();
    if (!cli) return;
    const caseDir = locator.caseDir;
    if (!caseDir) {
      void vscode.window.showWarningMessage("Overcast: no case selected — pick one first.");
      return;
    }
    // Plain `overcast case setup` (no flags) only PRINTS the setup status — the
    // interactive question-at-a-time wizard is the agent's job (the TUI system
    // prompt drives it). Launch the TUI with an initial message so the wizard
    // starts immediately: `--tui "<message>"` (a --tui non-verb positional is
    // pi's initial message, see routeArgv). Editor tab like the agent terminal.
    const term = vscode.window.createTerminal({
      name: `overcast setup · ${locator.caseName ?? ""}`.trim(),
      cwd: caseDir,
      location: vscode.TerminalLocation.Editor,
      env: bridge.terminalEnv(cli),
    });
    term.show();
    // single-quoted: literal in zsh/bash and PowerShell — so the message must
    // contain NO apostrophes/backticks (cmd.exe is best-effort, like the rest
    // of terminalLaunch)
    const wizardMsg =
      "Walk me through case setup as a step-by-step wizard. Check the current setup status first, then ask me one question at a time. If the case is already set up, summarize the current setup and offer edits.";
    term.sendText(bridge.terminalLaunch(cli, "--tui", `'${wizardMsg}'`));
  });

  // ---- restart / re-resolve the CLI -----------------------------------------
  const restartCli = vscode.commands.registerCommand("overcast.restartCli", async () => {
    const cli = await bridge.restart();
    // the restart may have landed on an upgraded/repointed binary — the verb
    // registry's memory tier must re-check the version on next use
    deps.registry.invalidate();
    void vscode.window.showInformationMessage(
      cli ? `Overcast CLI: ${cli.display}` : "Overcast CLI still not found — set overcast.path.",
    );
    await model.refresh();
  });

  // ---- status-bar item showing / switching the active case ------------------
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "overcast.selectCase";
  const refreshStatus = () => {
    const name = locator.caseName;
    statusItem.text = name ? `$(cloud) ${name}` : "$(cloud) Overcast: no case";
    statusItem.tooltip = locator.caseDir
      ? `Active overcast case: ${locator.caseDir}\nClick to switch`
      : "No overcast case — click to select or initialize";
    statusItem.show();
  };
  refreshStatus();

  context.subscriptions.push(
    selectCase,
    openInOvercast,
    openTerminal,
    caseSetup,
    restartCli,
    statusItem,
    locator.onDidChangeCase(refreshStatus),
    model.onDidChange(refreshStatus),
  );
  void output; // reserved for future logging
}

/** Adopt a folder as the active case, initializing the store if absent. */
async function adoptFolder(deps: ExtDeps, dir: string): Promise<void> {
  if (!hasCaseStore(dir)) {
    const pick = await vscode.window.showInformationMessage(
      `No overcast case in "${path.basename(dir)}". Initialize one here?`,
      "Initialize",
      "Cancel",
    );
    if (pick !== "Initialize") return;
    const cli = await deps.bridge.ensureCli();
    if (!cli) return;
    const result = await deps.bridge.runWithProgress(`Initializing case in ${dir}`, ["case", "init"], {
      caseDir: dir,
      cwd: dir,
    });
    if (!result) return;
  }
  await deps.locator.setChosenCase(dir);
  await focusOvercastView();
}
