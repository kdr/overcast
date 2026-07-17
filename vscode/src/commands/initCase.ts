// "Overcast: Initialize Case Here" — turn the workspace folder into a case
// (`overcast case init`), then re-locate. With no folder open there is no
// "here" yet — instead of dead-ending, ask for a folder and pin it as the
// active case (same adopt path as Select a Case → "Choose another folder…").
import * as path from "node:path";
import * as vscode from "vscode";
import { hasCaseStore } from "../services/caseLocator.ts";
import type { ExtDeps } from "../types.ts";

export function registerInitCase(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.initCase", async () => {
      const cli = await deps.bridge.ensureCli();
      if (!cli) return;
      const folders = vscode.workspace.workspaceFolders ?? [];
      let dir: string;
      if (folders.length === 0) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "Use as Case Folder",
          title: "A case is a directory — pick the folder that becomes the case",
        });
        if (!picked?.[0]) return;
        dir = picked[0].fsPath;
      } else if (folders.length > 1) {
        const pick = await vscode.window.showQuickPick(
          folders.map((f) => ({ label: f.name, description: f.uri.fsPath, dir: f.uri.fsPath })),
          { placeHolder: "Which folder becomes the case?" },
        );
        if (!pick) return;
        dir = pick.dir;
      } else {
        dir = folders[0].uri.fsPath;
      }
      if (hasCaseStore(dir)) {
        // Never `case init` over an existing store — on any path here (palette,
        // chat button, Select Case → Initialize…): with --name it would
        // silently rename the case. Adopt it as the active case instead.
        await deps.locator.setChosenCase(dir);
        deps.router.refresh();
        void vscode.window.showInformationMessage(
          `Folder is already an overcast case — selected: ${path.basename(dir)}`,
        );
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: "Case name",
        value: path.basename(dir),
        ignoreFocusOut: true,
      });
      if (name === undefined) return;
      const args = ["case", "init"];
      if (name.trim()) args.push("--name", name.trim());
      const result = await deps.bridge.runWithProgress(`Initializing case in ${dir}`, args, {
        caseDir: dir,
        cwd: dir,
      });
      if (!result) return;
      // Always pin: auto-detection can't see a dialog-picked folder at all,
      // and in multi-root (or under a stale chosen-case override) the new
      // case wouldn't become active either — initCase on X must END with X
      // active, same rule as adoptFolder. setChosenCase refreshes the locator.
      await deps.locator.setChosenCase(dir);
      deps.router.refresh();
      void vscode.window.showInformationMessage(`Overcast case ready: ${name || dir}`);
    }),
  );
}
