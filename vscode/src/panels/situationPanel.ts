// The live Situation page as an EDITOR TAB (not the bottom panel): a singleton
// WebviewPanel whose HTML tracks SituationServerManager state — a full-bleed
// iframe of the token-authed local situation server when running, cards
// otherwise. The manager owns the server lifecycle; this is just the surface.
import * as vscode from "vscode";
import type { SituationServerManager, SituationState } from "../services/situationServer.ts";
import type { ExtDeps } from "../types.ts";

let panel: vscode.WebviewPanel | undefined;

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(state: SituationState): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    "frame-src http://127.0.0.1:* http://localhost:* https:",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${n}'`,
  ].join("; ");
  const head = `<!doctype html><html><head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; }
      body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
      .card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; height: 100%; padding: 0 24px; text-align: center; }
      .muted { opacity: 0.7; max-width: 60em; }
      button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; padding: 5px 14px; cursor: pointer; font: inherit; }
      button:hover { background: var(--vscode-button-hoverBackground); }
      iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
    </style>
  </head><body>`;
  const button = (label: string, command: string) => `
    <button id="go">${label}</button>
    <script nonce="${n}">
      const vs = acquireVsCodeApi();
      document.getElementById("go").addEventListener("click", () => vs.postMessage({ command: "${command}" }));
    </script>`;
  const foot = `</body></html>`;

  switch (state.phase) {
    case "running":
      return `${head}<iframe src="${escapeHtml(state.iframeUrl ?? "")}" allow="autoplay; fullscreen"></iframe>${foot}`;
    case "starting":
      return `${head}<div class="card"><div>Starting the situation server…</div><div class="muted">${escapeHtml(state.message ?? "")}</div></div>${foot}`;
    case "error":
      return `${head}<div class="card"><div>⚠ Situation server</div><div class="muted">${escapeHtml(state.message ?? "unknown error")}</div>${button("Restart", "restart")}</div>${foot}`;
    case "idle":
    default:
      return `${head}<div class="card">
        <div>Monitor the situation</div>
        <div class="muted">Start a token-authenticated local situation server for this case and embed the live page — wall tiles, scan/monitor feed, map, stills — right here.</div>
        ${button("Start Situation Server", "start")}
      </div>${foot}`;
  }
}

/** Open (or reveal) the Situation editor tab and start the server. */
export function openSituationPanel(deps: ExtDeps, manager: SituationServerManager): void {
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel(
      "overcast.situationPanel",
      "Situation",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(deps.context.extensionUri, "media", "overcast.svg");
    const render = () => {
      if (panel) panel.webview.html = html(manager.state);
    };
    const stateSub = manager.onDidChangeState(render);
    const msgSub = panel.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg?.command === "start" || msg?.command === "restart") void manager.start();
    });
    panel.onDidDispose(() => {
      stateSub.dispose();
      msgSub.dispose();
      panel = undefined;
      const stopOnClose = vscode.workspace
        .getConfiguration("overcast")
        .get<boolean>("situation.stopOnClose", false);
      if (stopOnClose) void manager.stop();
    });
    render();
  }
  void manager.start();
}
