// "Overcast: Initialize Case Here" — turn the workspace folder into a case
// (`overcast case init`), then re-locate. With no folder open there is no
// "here" yet — instead of dead-ending, ask for a folder and pin it as the
// active case (same adopt path as Select a Case → "Choose another folder…").
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

function hasStore(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".overcast", "case.json"));
  } catch {
    return false;
  }
}

export function registerInitCase(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.initCase", async () => {
      const cli = await deps.bridge.ensureCli();
      if (!cli) return;
      const folders = vscode.workspace.workspaceFolders ?? [];
      let dir: string;
      // A dialog-picked folder isn't a workspace folder, so auto-detection
      // won't find the case afterward — it must be pinned via setChosenCase.
      let pickedOutsideWorkspace = false;
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
        pickedOutsideWorkspace = true;
        if (hasStore(dir)) {
          // Already a case — adopt it as-is; `case init --name` on an existing
          // store would silently rename it.
          await deps.locator.setChosenCase(dir);
          deps.router.refresh();
          void vscode.window.showInformationMessage(
            `Existing overcast case selected: ${path.basename(dir)}`,
          );
          return;
        }
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
      if (pickedOutsideWorkspace) await deps.locator.setChosenCase(dir);
      await deps.locator.refresh();
      deps.router.refresh();
      void vscode.window.showInformationMessage(`Overcast case ready: ${name || dir}`);
    }),
  );
}
