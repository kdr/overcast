// "Overcast: Initialize Case Here" — turn the workspace folder into a case
// (`overcast case init`), then re-locate.
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

export function registerInitCase(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.initCase", async () => {
      const cli = await deps.bridge.ensureCli();
      if (!cli) return;
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        void vscode.window.showErrorMessage("Open a folder first — a case is a directory.");
        return;
      }
      let dir = folders[0].uri.fsPath;
      if (folders.length > 1) {
        const pick = await vscode.window.showQuickPick(
          folders.map((f) => ({ label: f.name, description: f.uri.fsPath, dir: f.uri.fsPath })),
          { placeHolder: "Which folder becomes the case?" },
        );
        if (!pick) return;
        dir = pick.dir;
      }
      const name = await vscode.window.showInputBox({
        prompt: "Case name",
        value: folders[0].name,
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
      await deps.locator.refresh();
      deps.router.refresh();
      void vscode.window.showInformationMessage(`Overcast case ready: ${name || dir}`);
    }),
  );
}
