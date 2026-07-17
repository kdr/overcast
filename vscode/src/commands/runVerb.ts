// "Overcast: Run Verb…" — the registry-driven quick-pick flow. Every step is
// generated from VerbSpecJSON (overcast commands --json): verb pick (grouped),
// positional args (file picker for path-ish names, choices → QuickPick),
// optional flags (multi-pick, defaults prefilled), argv confirmation, run.
import * as path from "node:path";
import * as vscode from "vscode";
import { assembleArgs, type CollectedValues } from "../lib/argAssembly.ts";
import { htmlPathsInPayload } from "../lib/cliOutput.ts";
import type { ExtDeps, OvercastRecord, VerbSpecJSON } from "../types.ts";

const GROUP_ORDER: VerbSpecJSON["group"][] = [
  "sense",
  "inspect",
  "osint",
  "read",
  "state",
  "config",
];

const PATHISH = /input|ref|path|video|image|file|clip|media|sample|reference/i;
/** Flags the bridge/output contract owns — never offered in the picker. */
const RESERVED_FLAGS = new Set(["format", "json"]);

interface VerbItem extends vscode.QuickPickItem {
  spec?: VerbSpecJSON;
}

async function pickVerb(verbs: VerbSpecJSON[]): Promise<VerbSpecJSON | undefined> {
  const items: VerbItem[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = verbs.filter((v) => v.group === group);
    if (inGroup.length === 0) continue;
    items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
    for (const spec of inGroup) {
      items.push({ label: spec.name, description: spec.summary, spec });
    }
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "overcast verb to run",
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return pick?.spec;
}

async function collectPositional(
  spec: VerbSpecJSON,
  arg: VerbSpecJSON["args"][number],
): Promise<string | string[] | undefined | "cancel"> {
  if (arg.choices?.length) {
    const pick = await vscode.window.showQuickPick(
      arg.choices.map((c) => ({ label: c })),
      { placeHolder: `<${arg.name}> — ${arg.summary}`, ignoreFocusOut: true },
    );
    return pick ? pick.label : "cancel";
  }
  if (PATHISH.test(arg.name)) {
    const active = vscode.window.activeTextEditor?.document.uri;
    const options: (vscode.QuickPickItem & { mode: "pick" | "active" | "type" | "skip" })[] = [
      { label: "$(folder-opened) Pick a file…", mode: "pick" },
    ];
    if (active?.scheme === "file") {
      options.push({
        label: `$(file) Active editor file`,
        description: active.fsPath,
        mode: "active",
      });
    }
    options.push({ label: "$(edit) Type a value (path, URL, or record id)…", mode: "type" });
    if (!arg.required) options.push({ label: "$(dash) Skip", mode: "skip" });
    const how = await vscode.window.showQuickPick(options, {
      placeHolder: `<${arg.name}> — ${arg.summary}`,
      ignoreFocusOut: true,
    });
    if (!how) return "cancel";
    if (how.mode === "skip") return undefined;
    if (how.mode === "active") return active?.fsPath;
    if (how.mode === "pick") {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false });
      return picked?.[0] ? picked[0].fsPath : "cancel";
    }
  }
  const raw = await vscode.window.showInputBox({
    prompt: arg.variadic
      ? `<${arg.name}…> — ${arg.summary} (space-separated values)`
      : `<${arg.name}> — ${arg.summary}${arg.required ? "" : " (empty to skip)"}`,
    ignoreFocusOut: true,
  });
  if (raw === undefined) return "cancel";
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return arg.variadic ? trimmed.split(/\s+/) : trimmed;
}

interface FlagItem extends vscode.QuickPickItem {
  flag: VerbSpecJSON["flags"][number];
}

async function collectFlags(
  spec: VerbSpecJSON,
): Promise<CollectedValues["flags"] | "cancel"> {
  const offerable = spec.flags.filter((f) => !RESERVED_FLAGS.has(f.name));
  if (offerable.length === 0) return {};
  const picked = await vscode.window.showQuickPick(
    offerable.map(
      (flag): FlagItem => ({
        label: `--${flag.name}`,
        description:
          flag.summary + (flag.default !== undefined ? `  (default: ${flag.default})` : ""),
        flag,
      }),
    ),
    {
      placeHolder: `optional flags for ${spec.name} (none to run with defaults)`,
      canPickMany: true,
      matchOnDescription: true,
      ignoreFocusOut: true,
    },
  );
  if (picked === undefined) return "cancel";
  const flags: CollectedValues["flags"] = {};
  for (const { flag } of picked) {
    if (flag.type === "boolean") {
      flags[flag.name] = true;
      continue;
    }
    if (flag.choices?.length) {
      const choice = await vscode.window.showQuickPick(
        flag.choices.map((c) => ({ label: c })),
        { placeHolder: `--${flag.name} — ${flag.summary}`, ignoreFocusOut: true },
      );
      if (!choice) return "cancel";
      flags[flag.name] = choice.label;
      continue;
    }
    const raw = await vscode.window.showInputBox({
      prompt: `--${flag.name} — ${flag.summary}`,
      value: flag.default !== undefined ? String(flag.default) : undefined,
      ignoreFocusOut: true,
      validateInput:
        flag.type === "number"
          ? (v) => (v.trim() === "" || !Number.isNaN(Number(v)) ? undefined : "must be a number")
          : undefined,
    });
    if (raw === undefined) return "cancel";
    if (raw.trim() === "") continue;
    flags[flag.name] = flag.type === "number" ? Number(raw) : raw;
  }
  return flags;
}

export async function routeResult(
  deps: ExtDeps,
  verb: string,
  records: OvercastRecord[],
  /** the case the run targeted (captured at spawn) — a run finishing after a
   *  case switch must open its record in ITS case, not the locator's. */
  caseDir?: string,
): Promise<void> {
  const rec = records.find((r) => r.verb === verb) ?? records[0];
  deps.router.refresh();
  if (!rec) return;
  const artifacts = htmlPathsInPayload(rec.payload);
  if (artifacts.length > 0) {
    await deps.router.openArtifact(artifacts[0], `${verb} — ${path.basename(artifacts[0])}`);
    return;
  }
  if (rec.id) await deps.router.openRecord(rec.id, caseDir);
}

export function registerRunVerb(deps: ExtDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand("overcast.runVerb", async () => {
      if (!(await deps.bridge.ensureCli())) return;
      const verbs = await deps.registry.getVerbs();
      if (verbs.length === 0) {
        void vscode.window.showErrorMessage(
          "Overcast: could not load the verb registry (overcast commands --json).",
        );
        return;
      }
      const spec = await pickVerb(verbs);
      if (!spec) return;

      if (spec.group !== "config" && !deps.locator.caseDir) {
        const pick = await vscode.window.showWarningMessage(
          `overcast ${spec.name} needs a case in the workspace.`,
          "Initialize Case Here",
        );
        if (pick) await vscode.commands.executeCommand("overcast.initCase");
        return;
      }

      const values: CollectedValues = { args: {}, flags: {} };
      for (const arg of spec.args) {
        const v = await collectPositional(spec, arg);
        if (v === "cancel") return;
        if (v === undefined && arg.required) return; // required + skipped = abort
        values.args[arg.name] = v;
      }
      const flags = await collectFlags(spec);
      if (flags === "cancel") return;
      values.flags = flags;

      let argv: string[];
      try {
        argv = assembleArgs(spec, values);
      } catch (e) {
        void vscode.window.showErrorMessage(String(e instanceof Error ? e.message : e));
        return;
      }

      const confirm = await vscode.window.showQuickPick(
        [
          { label: `$(play) Run: overcast ${argv.join(" ")}`, run: true },
          { label: "$(close) Cancel", run: false },
        ],
        { placeHolder: "Confirm", ignoreFocusOut: true },
      );
      if (!confirm?.run) return;

      const caseDir = deps.locator.caseDir; // ONE capture: the spawn and the record routing
      const result = await deps.bridge.runWithProgress(`overcast ${spec.name}`, argv, { caseDir });
      if (!result) return;
      const rec = result.records.find((r) => r.verb === spec.name) ?? result.records[0];
      await routeResult(deps, spec.name, result.records, caseDir);
      if (rec?.id) {
        void vscode.window.showInformationMessage(
          `overcast ${spec.name} → ${result.records.length} record(s), ${rec.id}${rec.state === "pending" ? " (pending)" : ""}`,
        );
      }
    }),
  );
}
