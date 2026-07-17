// Shared loader for the Vite-built webview SPA (webview/ → dist/webview/).
// Reads the built index.html, rewrites its relative asset URLs to webview URIs,
// injects a strict CSP + script nonces, and wires the init/ready handshake.
import * as vscode from "vscode";
import type { HostMsg, SpaView, RecordViewState, ScanViewState, WebviewMsg } from "../shared/protocol.ts";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function spaRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "dist", "webview");
}

/** Load dist/webview/index.html rewritten for this webview, CSP + nonce injected. */
export async function loadSpaHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): Promise<string> {
  const root = spaRoot(extensionUri);
  const raw = Buffer.from(
    await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "index.html")),
  ).toString("utf8");
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `media-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource} data:`,
  ].join("; ");
  let html = raw.replace(
    /(src|href)="\.\/([^"]+)"/g,
    (_m, attr: string, rel: string) =>
      `${attr}="${webview.asWebviewUri(vscode.Uri.joinPath(root, ...rel.split("/"))).toString()}"`,
  );
  html = html.replace(/<script /g, `<script nonce="${n}" `);
  html = html.replace(
    /<head>/i,
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
  );
  return html;
}

export interface SpaPanelOptions {
  viewType: string;
  title: string;
  view: SpaView;
  state: RecordViewState | ScanViewState;
  column?: vscode.ViewColumn;
  /** extra roots beyond dist/webview (e.g. the case media dir for previews) */
  extraLocalRoots?: vscode.Uri[];
  /** app-specific messages (openExternal/copy are handled by the host already) */
  onMessage?: (msg: WebviewMsg, webview: vscode.Webview) => void;
}

/** Create an editor-tab webview panel running the SPA, init/ready handshaken. */
export async function createSpaPanel(
  context: vscode.ExtensionContext,
  opts: SpaPanelOptions,
): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    opts.viewType,
    opts.title,
    opts.column ?? vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [spaRoot(context.extensionUri), ...(opts.extraLocalRoots ?? [])],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "overcast.svg");
  wireSpaWebview(panel.webview, opts, () => panel.dispose());
  panel.webview.html = await loadSpaHtml(panel.webview, context.extensionUri);
  return panel;
}

/** Shared message wiring (also usable by WebviewViewProviders). */
export function wireSpaWebview(
  webview: vscode.Webview,
  opts: Pick<SpaPanelOptions, "view" | "state" | "onMessage">,
  _onClose?: () => void,
): void {
  webview.onDidReceiveMessage((raw: unknown) => {
    const msg = raw as WebviewMsg;
    switch (msg.type) {
      case "ready": {
        const init: HostMsg = { type: "init", view: opts.view, state: opts.state };
        void webview.postMessage(init);
        return;
      }
      case "openExternal":
        if (/^https?:\/\//i.test(msg.url)) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "copy":
        void vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage("Overcast: copied", 1500);
        return;
      default:
        opts.onMessage?.(msg, webview);
    }
  });
}
