// Command deck: the webview view pinned at the top of the Overcast container.
// A compact grid of REAL LABELED buttons (text, not icons) that each post a
// message → the host runs the matching existing command id. Self-contained
// inline HTML, strict CSP + nonce, themed with VS Code CSS variables. It reads
// only cheap synchronous state (locator/bridge) and re-renders on model + case
// change (a thin client — no CLI calls of its own).
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

interface DeckButton {
  label: string;
  command: string;
}

// Actions with a case (the everyday deck).
const CASE_BUTTONS: DeckButton[] = [
  { label: "New Note", command: "overcast.addNote" },
  { label: "Scan…", command: "overcast.searchSource" },
  { label: "Run Verb…", command: "overcast.runVerb" },
  { label: "Status Report", command: "overcast.viewBrief" },
  { label: "Map", command: "overcast.showMap" },
  { label: "Graph", command: "overcast.showGraph" },
  { label: "Wall", command: "overcast.showWall" },
  { label: "Situation", command: "overcast.situationOpen" },
  { label: "Agent Terminal", command: "overcast.openAgentTerminal" },
];

// Actions with no case selected.
const NO_CASE_BUTTONS: DeckButton[] = [
  { label: "Initialize Case Here", command: "overcast.initCase" },
  { label: "Select Case…", command: "overcast.selectCase" },
];

// Every command the deck is allowed to dispatch (guards the message channel).
const ALLOWED = new Set([...CASE_BUTTONS, ...NO_CASE_BUTTONS].map((b) => b.command));

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

export class CommandDeckProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: ExtDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const d of this.subs) d.dispose(); // a re-resolve (hide→show) mustn't stack subs
    this.subs.length = 0;
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg?.command && ALLOWED.has(msg.command)) {
        void vscode.commands.executeCommand(msg.command);
      }
    });
    // Re-render on case-board refreshes and case switches (both cheap here).
    this.subs.push(
      this.deps.model.onDidChange(() => this.render()),
      this.deps.locator.onDidChangeCase(() => this.render()),
    );
    webviewView.onDidDispose(() => {
      for (const d of this.subs) d.dispose();
      this.subs.length = 0;
      this.view = undefined;
    });
    this.render();
  }

  private render(): void {
    if (this.view) this.view.webview.html = this.html();
  }

  private html(): string {
    const n = nonce();
    const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${n}'`].join("; ");
    const hasCase = !!this.deps.locator.caseDir;
    const cliFound = this.deps.bridge.cliFound;
    const caseName = hasCase ? (this.deps.locator.caseName ?? "case") : "no case";
    const buttons = hasCase ? CASE_BUTTONS : NO_CASE_BUTTONS;
    const dotClass = cliFound ? "ok" : "bad";
    const dotTitle = cliFound ? "overcast CLI found" : "overcast CLI not found — set overcast.path";
    const buttonHtml = buttons
      .map(
        (b) =>
          `<button class="deck-btn" data-cmd="${escapeHtml(b.command)}">${escapeHtml(b.label)}</button>`,
      )
      .join("");
    return `<!doctype html><html><head>
      <meta charset="utf-8" />
      <meta http-equiv="Content-Security-Policy" content="${csp}" />
      <style>
        html, body { margin: 0; padding: 0; }
        body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
        .deck { padding: 8px 10px 10px; }
        .head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; min-width: 0; }
        .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
        .dot.ok { background: var(--vscode-testing-iconPassed, #3fb950); }
        .dot.bad { background: var(--vscode-testing-iconFailed, #f14c4c); }
        .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .grid { display: flex; flex-wrap: wrap; gap: 6px; }
        .deck-btn {
          color: var(--vscode-button-foreground); background: var(--vscode-button-background);
          border: none; border-radius: 2px; padding: 4px 10px; cursor: pointer; font: inherit;
          white-space: nowrap;
        }
        .deck-btn:hover { background: var(--vscode-button-hoverBackground); }
        .deck-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
      </style>
    </head><body>
      <div class="deck">
        <div class="head">
          <span class="dot ${dotClass}" title="${escapeHtml(dotTitle)}"></span>
          <span class="name" title="${escapeHtml(caseName)}">${escapeHtml(caseName)}</span>
        </div>
        <div class="grid">${buttonHtml}</div>
      </div>
      <script nonce="${n}">
        const vs = acquireVsCodeApi();
        for (const el of document.querySelectorAll(".deck-btn")) {
          el.addEventListener("click", () => vs.postMessage({ command: el.getAttribute("data-cmd") }));
        }
      </script>
    </body></html>`;
  }
}
