// Case management UX: a picker (status bar + palette) to switch the active case
// without editing settings, an explorer folder action to adopt/initialize a
// folder as the case, launching the interactive overcast AGENT in a terminal,
// and a CLI restart. The active-case override lives in workspaceState (see
// CaseLocator.setChosenCase) so it survives reloads and beats auto-detection.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

const OVERCAST_VIEW = "workbench.view.extension.overcast";

function hasStore(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".overcast", "case.json"));
  } catch {
    return false;
  }
}

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
    });
    term.show();
    // Launch the interactive agent (TUI). In node-runner mode cli.cmd is the
    // extension host's Electron binary (only runnable as node with
    // ELECTRON_RUN_AS_NODE) — a plain terminal must use real `node <script>`
    // instead; otherwise the resolved overcast binary / PATH name.
    const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
    const launch = cli.argsPrefix.length ? `node ${cli.argsPrefix.map(q).join(" ")}` : q(cli.cmd);
    // Records the agent writes land in .overcast/ (the sidebar auto-refreshes);
    // the agent opens its own HTML artifacts in the OS browser — open them here
    // from the Records tree to get a webview panel instead.
    term.sendText(launch);
  });

  // ---- restart / re-resolve the CLI -----------------------------------------
  const restartCli = vscode.commands.registerCommand("overcast.restartCli", async () => {
    const cli = await bridge.restart();
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
    restartCli,
    statusItem,
    locator.onDidChangeCase(refreshStatus),
    model.onDidChange(refreshStatus),
  );
  void output; // reserved for future logging
}

/** Adopt a folder as the active case, initializing the store if absent. */
async function adoptFolder(deps: ExtDeps, dir: string): Promise<void> {
  if (!hasStore(dir)) {
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
