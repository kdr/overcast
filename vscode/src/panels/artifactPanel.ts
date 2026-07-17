// Editor-tab webview panels for generated HTML artifacts, plus the
// showMap/showGraph/showWall commands that (re)generate then open them.
//
// One panel per artifact path (reveal-if-open). Each panel watches its
// artifact's directory and re-runs the rewrite pipeline when the file
// regenerates (verb re-runs write in place; watching the dir survives atomic
// replaces). A WebviewPanelSerializer restores panels across window reloads
// from the {artifactPath, title} state the bridge script stores via
// acquireVsCodeApi().setState (injected by htmlRewrite's stateJson).
//
// Verified payload fields for the artifact-producing verbs (fixture case,
// CLI 0.0.9): map/graph/wall/view → payload.viewer; grid → payload.view.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";
import { rewriteArtifactHtml } from "./htmlRewrite.ts";

const VIEW_TYPE = "overcast.artifact";
const RELOAD_DEBOUNCE_MS = 300;

export interface ArtifactOpener {
  open(absPath: string, title?: string): Promise<void>;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  watcher?: fs.FSWatcher;
  reloadTimer?: NodeJS.Timeout;
}

function missingHtml(absPath: string): string {
  // No external loads — safe without a CSP meta.
  return `<!doctype html><html><body style="font-family: var(--vscode-font-family, sans-serif); padding: 16px; opacity: .85">
  <p><strong>Artifact missing</strong></p>
  <p><code>${absPath.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></p>
  <p>Re-run the verb that generated it (map / graph / wall / view / grid) to regenerate.</p>
</body></html>`;
}

export function registerArtifactPanels(deps: ExtDeps): ArtifactOpener {
  const panels = new Map<string, PanelEntry>();

  async function loadInto(panel: vscode.WebviewPanel, absPath: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(absPath, "utf8");
    } catch {
      panel.webview.options = { enableScripts: false, localResourceRoots: [] };
      panel.webview.html = missingHtml(absPath);
      return;
    }
    const allowOsmTiles = vscode.workspace
      .getConfiguration("overcast")
      .get<boolean>("allowRemoteMapTiles", false);
    const result = rewriteArtifactHtml(raw, {
      toWebviewUri: (p) => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(),
      cspSource: panel.webview.cspSource,
      allowOsmTiles,
      stateJson: JSON.stringify({ artifactPath: absPath, title: panel.title }),
    });
    const roots = new Set(result.localRoots);
    roots.add(path.dirname(absPath));
    // localResourceRoots come FROM the rewrite, so options are (re)set before
    // html each load — settable on the webview object after creation.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [...roots].map((r) => vscode.Uri.file(r)),
    };
    panel.webview.html = result.html;
  }

  /** Wire messages, the regenerate-watcher, and dispose cleanup. */
  function attach(panel: vscode.WebviewPanel, absPath: string): void {
    const entry: PanelEntry = { panel };
    panels.set(absPath, entry);

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = raw as { type?: string; url?: string };
      if (msg?.type === "openExternal" && typeof msg.url === "string") {
        if (/^https?:\/\//i.test(msg.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
      }
    });

    try {
      const dir = path.dirname(absPath);
      const base = path.basename(absPath);
      entry.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename !== base) return;
        if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
        entry.reloadTimer = setTimeout(() => {
          entry.reloadTimer = undefined;
          void loadInto(panel, absPath);
        }, RELOAD_DEBOUNCE_MS);
      });
      entry.watcher.on("error", () => {
        /* directory vanished — the next loadInto shows missingHtml */
      });
    } catch {
      /* watching is best-effort; manual re-open still works */
    }

    panel.onDidDispose(() => {
      entry.watcher?.close();
      if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
      panels.delete(absPath);
    });
  }

  async function open(absPath: string, title?: string): Promise<void> {
    const resolved = path.resolve(absPath);
    const existing = panels.get(resolved);
    if (existing) {
      if (title) existing.panel.title = title;
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
      await loadInto(existing.panel, resolved);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title ?? path.basename(resolved),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(deps.context.extensionUri, "media", "overcast.svg");
    attach(panel, resolved);
    await loadInto(panel, resolved);
  }

  deps.context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
        const s = (state ?? {}) as { artifactPath?: string; title?: string };
        if (!s.artifactPath) {
          panel.dispose();
          return;
        }
        const resolved = path.resolve(s.artifactPath);
        if (s.title) panel.title = s.title;
        attach(panel, resolved);
        await loadInto(panel, resolved);
      },
    }),
  );

  // ---- generate-and-open commands -------------------------------------------
  const artifactCommands: Array<{ cmd: string; verb: "map" | "graph" | "wall"; title: string }> = [
    { cmd: "overcast.showMap", verb: "map", title: "Map" },
    { cmd: "overcast.showGraph", verb: "graph", title: "Graph" },
    { cmd: "overcast.showWall", verb: "wall", title: "Wall" },
  ];
  for (const { cmd, verb, title } of artifactCommands) {
    deps.context.subscriptions.push(
      vscode.commands.registerCommand(cmd, async () => {
        if (!(await deps.bridge.ensureCli())) return;
        const args = [verb, "--no-open"];
        if (verb === "map") {
          const allowOsmTiles = vscode.workspace
            .getConfiguration("overcast")
            .get<boolean>("allowRemoteMapTiles", false);
          if (!allowOsmTiles) args.push("--offline");
        }
        const result = await deps.bridge.runWithProgress(`overcast ${verb}`, args);
        if (!result) return;
        deps.router.refresh();
        const rec = result.records.find((r) => r.verb === verb);
        const payload = (rec?.payload ?? {}) as { viewer?: unknown };
        if (typeof payload.viewer === "string" && payload.viewer) {
          const caseName = deps.model.status?.info?.name;
          await open(payload.viewer, caseName ? `${title} — ${caseName}` : title);
        } else {
          void vscode.window.showWarningMessage(
            `Overcast: ${verb} finished but returned no viewer path.`,
          );
        }
      }),
    );
  }

  return { open };
}
