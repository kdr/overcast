// The thin "run a verb for the chat surface" core shared by the @overcast
// participant and the overcast_* language-model tools. Runs through the bridge's
// plain `run` (NOT runWithProgress — the Runs view already tracks the job; an
// agent loop calling tools in a loop must not spawn a progress notification per
// call), then maps a failure to a model-facing message.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CliBridge } from "../services/cliBridge.ts";
import type { OvercastRecord } from "../types.ts";
import { failureMessage } from "./summarize.ts";

export interface ChatVerbOutcome {
  ok: boolean;
  records: OvercastRecord[];
  /** raw stdout (used by /brief, which runs rawOutput to stream the md report). */
  stdout?: string;
  /** model-facing failure line when !ok. */
  message?: string;
}

/** Run a verb through the bridge for the chat surface and normalize the result. */
export async function runVerbForChat(
  bridge: CliBridge,
  args: string[],
  token?: vscode.CancellationToken,
  opts: { rawOutput?: boolean } = {},
): Promise<ChatVerbOutcome> {
  const result = await bridge.run(args, { token, rawOutput: opts.rawOutput });
  if (result.failure) {
    return { ok: false, records: result.records, message: failureMessage(result.failure) };
  }
  return { ok: true, records: result.records, stdout: result.stdout };
}

/** Resolve a media path from a tool/chat arg: absolute as-is, else relative to a
 *  workspace folder or the case dir. Returns undefined when nothing exists (the
 *  file existence check the `sense` surfaces do before running). */
export function resolveMediaFile(caseDir: string | undefined, file: string): string | undefined {
  const raw = file.trim();
  if (!raw) return undefined;
  if (path.isAbsolute(raw)) return fs.existsSync(raw) ? raw : undefined;
  const roots = [
    ...(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []),
    ...(caseDir ? [caseDir] : []),
  ];
  for (const root of roots) {
    const abs = path.join(root, raw);
    if (fs.existsSync(abs)) return abs;
  }
  return undefined;
}
