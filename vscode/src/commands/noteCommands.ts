// Add a human observation to the case (`overcast note <text>`). Notes are
// evidence: searchable by ask, shown in brief, and listed in the Records tree
// (verb group "note") — click one there to read it. Invoked from a record/tree
// node, the note is anchored to that record via --ref.
import * as vscode from "vscode";
import { idFrom } from "./findingCommands.ts";
import type { ExtDeps } from "../types.ts";

export function registerNoteCommands(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.addNote", async (arg?: unknown) => {
      if (!(await deps.bridge.ensureCli())) return;
      if (!deps.locator.caseDir) {
        const pick = await vscode.window.showWarningMessage(
          "A note is stored in a case — none is active.",
          "Select Case…",
        );
        if (pick) await vscode.commands.executeCommand("overcast.selectCase");
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: "New note — a human observation for this case",
        placeHolder: "e.g. Crane barge matches the one seen at pier 9 on 06-02",
        ignoreFocusOut: true,
      });
      if (!text?.trim()) return;

      const args = ["note", text.trim()];
      const ref = idFrom(arg); // anchor to a record when invoked from a tree node
      if (ref) args.push("--ref", ref);
      const confidence = await vscode.window.showQuickPick(["(none)", "low", "medium", "high"], {
        placeHolder: "Confidence (optional)",
        ignoreFocusOut: true,
      });
      if (confidence && confidence !== "(none)") args.push("--confidence", confidence);

      const result = await deps.bridge.runWithProgress("Adding note", args);
      if (!result) return;
      deps.router.refresh();
      const rec = result.records.find((r) => r.verb === "note") ?? result.records[0];
      if (rec?.id) {
        const open = await vscode.window.showInformationMessage(`Note added → ${rec.id}`, "Open");
        if (open) await deps.router.openRecord(rec.id);
      }
    }),
  );
}
