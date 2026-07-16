// Finding review + record actions for the sidebar trees.
//   accept/dismiss → bridge.mutate(["finding", …]) (serialized lane — verified:
//   emits a review record {finding_id, status, reviewed_at} and the triage row
//   drops out of `case status` on the next refresh)
//   accept-with-target → QuickPick over payload.targets, --target <id>
//   openRecord → router.openRecord (accepts a bare id or any tree node
//   carrying findingId/recordId)
//   copyRecordJson → `case memory get <id>` (the CLI-sanctioned full read:
//   record envelope + field manifest; raw jsonl is never read directly)
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

type IdNode = { findingId?: unknown; recordId?: unknown };

/** Pull a record id out of a command argument (bare string or tree node). */
export function idFrom(arg: unknown): string | undefined {
  if (typeof arg === "string" && arg.trim()) return arg.trim();
  if (arg && typeof arg === "object") {
    const node = arg as IdNode;
    if (typeof node.findingId === "string") return node.findingId;
    if (typeof node.recordId === "string") return node.recordId;
  }
  return undefined;
}

async function review(
  deps: ExtDeps,
  action: "accept" | "dismiss",
  findingId: string,
  targetId?: string,
): Promise<void> {
  const args = ["finding", action, findingId];
  if (targetId) args.push("--target", targetId);
  const result = await deps.bridge.mutate(args);
  if (result.failure) {
    void vscode.window.showErrorMessage(`Overcast finding ${action}: ${result.failure.message}`);
    return;
  }
  deps.router.refresh();
  vscode.window.setStatusBarMessage(
    `Overcast: finding ${action === "accept" ? "accepted" : "dismissed"}${targetId ? ` → ${targetId}` : ""}`,
    2500,
  );
}

export function registerFindingCommands(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.acceptFinding", async (node?: unknown) => {
      const id = idFrom(node);
      if (!id) return;
      await review(deps, "accept", id);
    }),

    vscode.commands.registerCommand("overcast.dismissFinding", async (node?: unknown) => {
      const id = idFrom(node);
      if (!id) return;
      await review(deps, "dismiss", id);
    }),

    vscode.commands.registerCommand("overcast.acceptFindingWithTarget", async (node?: unknown) => {
      const id = idFrom(node);
      if (!id) return;
      const targets = deps.model.status?.targets ?? [];
      if (targets.length === 0) {
        const pick = await vscode.window.showWarningMessage(
          "No lines of investigation in this case — accept without a target?",
          "Accept",
          "Cancel",
        );
        if (pick === "Accept") await review(deps, "accept", id);
        return;
      }
      const pick = await vscode.window.showQuickPick(
        targets.map((t) => ({
          label: t.value,
          description: t.id,
          detail: t.description,
          targetId: t.id,
        })),
        { placeHolder: "Stamp this finding onto which line of investigation?", ignoreFocusOut: true },
      );
      if (!pick) return;
      await review(deps, "accept", id, pick.targetId);
    }),

    vscode.commands.registerCommand("overcast.openRecord", async (nodeOrId?: unknown) => {
      const id = idFrom(nodeOrId);
      if (!id) {
        const typed = await vscode.window.showInputBox({
          prompt: "Record id (rec_…)",
          ignoreFocusOut: true,
        });
        if (!typed?.trim()) return;
        await deps.router.openRecord(typed.trim());
        return;
      }
      await deps.router.openRecord(id);
    }),

    vscode.commands.registerCommand("overcast.copyRecordJson", async (node?: unknown) => {
      const id = idFrom(node);
      if (!id) return;
      const result = await deps.bridge.run(["case", "memory", "get", id]);
      if (result.failure) {
        void vscode.window.showErrorMessage(`Overcast: ${result.failure.message}`);
        return;
      }
      const rec = result.records[0];
      await vscode.env.clipboard.writeText(JSON.stringify(rec?.payload ?? rec ?? {}, null, 2));
      vscode.window.setStatusBarMessage(`Overcast: copied ${id} JSON`, 2000);
    }),

    vscode.commands.registerCommand("overcast.copyRecordId", async (node?: unknown) => {
      const id = idFrom(node);
      if (!id) return;
      await vscode.env.clipboard.writeText(id);
      vscode.window.setStatusBarMessage(`Overcast: copied ${id}`, 2000);
    }),
  );
}
