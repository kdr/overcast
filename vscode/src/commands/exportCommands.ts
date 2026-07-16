// Brief exports.
//   HTML → `brief --export <path>.html --theme csi` → artifact panel
//   Markdown → `brief --export <path>.md` → text editor
// The CLI resolves a bare --export filename against the case media dir; we
// always pass an absolute path from the save dialog so exports land where the
// user chose.
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

async function exportBrief(deps: ExtDeps, kind: "html" | "md"): Promise<void> {
  if (!(await deps.bridge.ensureCli())) return;
  const caseDir = deps.locator.caseDir;
  if (!caseDir) {
    void vscode.window.showWarningMessage("Overcast: no case in this workspace.");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(caseDir, `brief-${stamp}.${kind}`)),
    filters: kind === "html" ? { HTML: ["html"] } : { Markdown: ["md"] },
    title: `Export brief (${kind})`,
  });
  if (!target) return;

  const args = ["brief", "--export", target.fsPath];
  if (kind === "html") args.push("--theme", "csi");
  const result = await deps.bridge.runWithProgress("Exporting brief", args, { caseDir });
  if (!result) return;
  deps.router.refresh();

  if (kind === "html") {
    await deps.router.openArtifact(target.fsPath, `Brief — ${path.basename(target.fsPath)}`);
  } else {
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

/** Quick status report: (re)generate the brief HTML into the case and open it
 *  in an artifact tab — no save dialog. */
async function viewBrief(deps: ExtDeps): Promise<void> {
  if (!(await deps.bridge.ensureCli())) return;
  const caseDir = deps.locator.caseDir;
  if (!caseDir) {
    void vscode.window.showWarningMessage("Overcast: no case in this workspace.");
    return;
  }
  const out = path.join(caseDir, ".overcast", "media", "brief.html");
  const result = await deps.bridge.runWithProgress(
    "Building status report",
    ["brief", "--export", out, "--theme", "csi"],
    { caseDir },
  );
  if (!result) return;
  await deps.router.openArtifact(out, `Brief — ${deps.model.status?.info?.name ?? "case"}`);
}

export function registerExportCommands(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.viewBrief", () => viewBrief(deps)),
    vscode.commands.registerCommand("overcast.exportBriefHtml", () => exportBrief(deps, "html")),
    vscode.commands.registerCommand("overcast.exportBriefMarkdown", () => exportBrief(deps, "md")),
  );
}
