// Locates the active overcast case in the workspace and maintains the
// `overcast.hasCase` context key. A case is any directory holding
// `.overcast/case.json` (CLAUDE.md invariant #4: case = a folder).
//
// Resolution order:
//   1. an explicit user choice (status-bar/command picker; workspaceState)
//   2. the `overcast.caseDir` setting (absolute, or relative to folder 0)
//   3. a workspace folder root containing .overcast/case.json
//   4. the shallowest .overcast/case.json found anywhere in the workspace
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export interface CaseContext {
  caseDir: string;
}

export interface CaseChoice {
  dir: string;
  name: string;
}

const CHOSEN_KEY = "overcast.chosenCaseDir";

/** The one store-detection check (a case = a folder with `.overcast/case.json`)
 *  — import this rather than re-checking the path shape elsewhere. */
export function hasCaseStore(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".overcast", "case.json"));
  } catch {
    return false;
  }
}

function caseName(dir: string): string {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, ".overcast", "case.json"), "utf8"));
    if (info && typeof info.name === "string" && info.name.trim()) return info.name.trim();
  } catch {
    /* fall through to basename */
  }
  return path.basename(dir);
}

export class CaseLocator implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CaseContext | undefined>();
  readonly onDidChangeCase = this.emitter.event;
  private currentCase: CaseContext | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/.overcast/case.json");
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => void this.refresh()),
      watcher.onDidDelete(() => void this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("overcast.caseDir")) void this.refresh();
      }),
    );
  }

  get current(): CaseContext | undefined {
    return this.currentCase;
  }

  get caseDir(): string | undefined {
    return this.currentCase?.caseDir;
  }

  get caseName(): string | undefined {
    return this.currentCase ? caseName(this.currentCase.caseDir) : undefined;
  }

  /** User-pinned case (from the picker); undefined = auto/settings. */
  private get chosen(): string | undefined {
    const v = this.context.workspaceState.get<string>(CHOSEN_KEY);
    return v && fs.existsSync(v) ? v : undefined;
  }

  async setChosenCase(dir: string | undefined): Promise<void> {
    await this.context.workspaceState.update(CHOSEN_KEY, dir);
    await this.refresh();
  }

  /** All cases discoverable in the workspace, for the picker. */
  async listCases(): Promise<CaseChoice[]> {
    const seen = new Set<string>();
    const out: CaseChoice[] = [];
    const add = (dir: string) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      out.push({ dir, name: caseName(dir) });
    };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (hasCaseStore(folder.uri.fsPath)) add(folder.uri.fsPath);
    }
    const nested = await vscode.workspace.findFiles(
      "**/.overcast/case.json",
      "**/node_modules/**",
      200,
    );
    for (const u of nested) add(path.dirname(path.dirname(u.fsPath)));
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async refresh(): Promise<void> {
    const found = await this.locate();
    const changed = found?.caseDir !== this.currentCase?.caseDir;
    this.currentCase = found;
    await vscode.commands.executeCommand("setContext", "overcast.hasCase", !!found);
    if (changed) this.emitter.fire(found);
  }

  private async locate(): Promise<CaseContext | undefined> {
    const chosen = this.chosen;
    if (chosen) return { caseDir: chosen };

    const folders = vscode.workspace.workspaceFolders ?? [];
    const setting = vscode.workspace.getConfiguration("overcast").get<string>("caseDir", "");
    if (setting) {
      const base = folders[0]?.uri.fsPath ?? process.cwd();
      const dir = path.isAbsolute(setting) ? setting : path.resolve(base, setting);
      // An explicit setting wins even if the store isn't initialized yet (the
      // init flow points here); only require the directory itself to exist.
      if (fs.existsSync(dir)) return { caseDir: dir };
      return undefined;
    }
    for (const folder of folders) {
      if (hasCaseStore(folder.uri.fsPath)) return { caseDir: folder.uri.fsPath };
    }
    const nested = await vscode.workspace.findFiles(
      "**/.overcast/case.json",
      "**/node_modules/**",
      25,
    );
    if (nested.length === 0) return undefined;
    const dirs = nested
      .map((u) => path.dirname(path.dirname(u.fsPath))) // strip /.overcast/case.json
      .sort((a, b) => a.length - b.length);
    return { caseDir: dirs[0] };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
