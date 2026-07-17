// Command deck: the webview view pinned at the top of the Overcast container.
// A compact grid of labeled buttons (each with a small inline-SVG icon — no
// icon font/CDN, CSP stays `default-src 'none'`) that each post a message →
// the host runs the matching existing command id. Self-contained inline HTML,
// strict CSP + nonce, themed with VS Code CSS variables. It reads only cheap
// synchronous state (locator/bridge) and re-renders on model + case change
// (a thin client — no CLI calls of its own).
import * as vscode from "vscode";
import type { ExtDeps } from "../types.ts";

interface DeckButton {
  label: string;
  command: string;
  /** inline SVG path/shape markup (trusted constant), drawn in currentColor */
  icon: string;
}

// 16x16 stroke icons (stroke=currentColor set on the shared <svg> wrapper).
const ICONS = {
  note: '<path d="M11.7 2.3l2 2L5.5 12.5l-2.8.8.8-2.8z"/>',
  scan: '<circle cx="6.8" cy="6.8" r="4.3"/><path d="M10 10l4 4"/>',
  eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  book: '<path d="M8 3.2C6.6 2.2 4 2.2 2.5 2.8v10.4c1.5-.6 4.1-.6 5.5.4 1.4-1 4-1 5.5-.4V2.8C12 2.2 9.4 2.2 8 3.2z"/><path d="M8 3.2v10.4"/>',
  map: '<path d="M8 1.5A4.5 4.5 0 0 1 12.5 6c0 3-4.5 8.5-4.5 8.5S3.5 9 3.5 6A4.5 4.5 0 0 1 8 1.5z"/><circle cx="8" cy="6" r="1.6"/>',
  graph:
    '<circle cx="3.2" cy="3.5" r="1.7"/><circle cx="12.8" cy="5" r="1.7"/><circle cx="6.5" cy="12.5" r="1.7"/><path d="M4.8 4L11 4.7M12 6.5l-4.3 4.6M4 5.1l2 5.7"/>',
  wall: '<rect x="1.8" y="1.8" width="5.2" height="5.2"/><rect x="9" y="1.8" width="5.2" height="5.2"/><rect x="1.8" y="9" width="5.2" height="5.2"/><rect x="9" y="9" width="5.2" height="5.2"/>',
  broadcast:
    '<circle cx="8" cy="8" r="1.4"/><path d="M4.8 4.8a4.5 4.5 0 0 0 0 6.4M11.2 4.8a4.5 4.5 0 0 1 0 6.4M2.6 2.6a7.6 7.6 0 0 0 0 10.8M13.4 2.6a7.6 7.6 0 0 1 0 10.8"/>',
  terminal:
    '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6.2l2.6 2L4 10.2M8.4 10.5h3.6"/>',
  init: '<path d="M1.5 4h4.5l1.5 1.8h7v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M8 8v4M6 10h4"/>',
  folder:
    '<path d="M1.5 4h4.5l1.5 1.8h7v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>',
  swap: '<path d="M2 5.5h9.5M9 2.5l3 3-3 3"/><path d="M14 10.5H4.5M7 7.5l-3 3 3 3"/>',
  plus: '<path d="M8 2.5v11M2.5 8h11"/>',
};

interface DeckGroup {
  /** tiny muted caption over the row */
  title: string;
  buttons: DeckButton[];
}

// The everyday deck, grouped along the OSINT cycle:
// prepare → collect → process → analyze → present. The agent terminal is
// cross-cutting (it drives the whole loop) and lives in the head row.
const CASE_GROUPS: DeckGroup[] = [
  {
    title: "Prepare",
    buttons: [
      { label: "Case Setup", command: "overcast.caseSetup", icon: ICONS.gear },
      { label: "Add Source…", command: "overcast.addSource", icon: ICONS.plus },
    ],
  },
  {
    title: "Collect",
    buttons: [{ label: "Scan…", command: "overcast.searchSource", icon: ICONS.scan }],
  },
  {
    title: "Process",
    buttons: [{ label: "Analyze Media…", command: "overcast.runVerb", icon: ICONS.eye }],
  },
  {
    title: "Analyze",
    buttons: [
      { label: "New Note", command: "overcast.addNote", icon: ICONS.note },
      { label: "Map", command: "overcast.showMap", icon: ICONS.map },
      { label: "Graph", command: "overcast.showGraph", icon: ICONS.graph },
    ],
  },
  {
    title: "Present",
    buttons: [
      { label: "Brief", command: "overcast.viewBrief", icon: ICONS.book },
      { label: "Wall", command: "overcast.showWall", icon: ICONS.wall },
      { label: "Situation", command: "overcast.situationOpen", icon: ICONS.broadcast },
    ],
  },
];

// Actions with no case selected.
const NO_CASE_GROUPS: DeckGroup[] = [
  {
    title: "Case",
    buttons: [
      { label: "Initialize Case Here", command: "overcast.initCase", icon: ICONS.init },
      { label: "Select Case…", command: "overcast.selectCase", icon: ICONS.folder },
    ],
  },
];

// Every command the deck is allowed to dispatch (guards the message channel).
// selectCase + the agent terminal ride the head row, not a grid button.
const ALLOWED = new Set([
  ...[...CASE_GROUPS, ...NO_CASE_GROUPS].flatMap((g) => g.buttons.map((b) => b.command)),
  "overcast.selectCase",
  "overcast.openAgentTerminal",
]);

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

  constructor(
    private readonly deps: ExtDeps,
    /** fired when the deck (and so the Overcast container) becomes visible —
     *  the extension's signal to run its one-time layout nudge. */
    private readonly onVisible?: () => void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    for (const d of this.subs) d.dispose(); // a re-resolve (hide→show) mustn't stack subs
    this.subs.length = 0;
    this.view = webviewView;
    this.onVisible?.();
    this.subs.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) this.onVisible?.();
      }),
    );
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
    const groups = hasCase ? CASE_GROUPS : NO_CASE_GROUPS;
    const dotClass = cliFound ? "ok" : "bad";
    const dotTitle = cliFound ? "overcast CLI found" : "overcast CLI not found — set overcast.path";
    const button = (b: DeckButton) =>
      `<button class="deck-btn" data-cmd="${escapeHtml(b.command)}">` +
      `<svg viewBox="0 0 16 16" aria-hidden="true">${b.icon}</svg>` +
      `<span>${escapeHtml(b.label)}</span></button>`;
    const groupHtml = groups
      .map(
        (g) =>
          `<div class="group"><div class="group-title">${escapeHtml(g.title)}</div>` +
          `<div class="grid">${g.buttons.map(button).join("")}</div></div>`,
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
        .name {
          font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          background: none; border: none; color: inherit; font-family: inherit; font-size: inherit;
          padding: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; min-width: 0;
        }
        .name:hover { color: var(--vscode-textLink-foreground); }
        .name svg {
          width: 12px; height: 12px; flex: 0 0 auto; opacity: 0.7;
          fill: none; stroke: currentColor; stroke-width: 1.4;
          stroke-linecap: round; stroke-linejoin: round;
        }
        /* cycle groups flow left→right, wrapping — short phases share a line */
        .groups { display: flex; flex-wrap: wrap; gap: 8px 16px; }
        .group { flex: 0 1 auto; }
        .group-title {
          font-size: 0.78em; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          opacity: 0.55; margin: 0 0 3px 1px;
        }
        .grid { display: flex; flex-wrap: wrap; gap: 6px; }
        .icon-btn {
          margin-left: auto; flex: 0 0 auto; background: none; border: none; padding: 2px;
          color: inherit; cursor: pointer; opacity: 0.75; display: inline-flex;
        }
        .icon-btn:hover { opacity: 1; color: var(--vscode-textLink-foreground); }
        .icon-btn svg {
          width: 14px; height: 14px;
          fill: none; stroke: currentColor; stroke-width: 1.4;
          stroke-linecap: round; stroke-linejoin: round;
        }
        .deck-btn {
          color: var(--vscode-button-foreground); background: var(--vscode-button-background);
          border: none; border-radius: 2px; padding: 4px 10px 4px 8px; cursor: pointer; font: inherit;
          white-space: nowrap; display: inline-flex; align-items: center; gap: 5px;
        }
        .deck-btn svg {
          width: 13px; height: 13px; flex: 0 0 auto;
          fill: none; stroke: currentColor; stroke-width: 1.4;
          stroke-linecap: round; stroke-linejoin: round;
        }
        .deck-btn:hover { background: var(--vscode-button-hoverBackground); }
        .deck-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
      </style>
    </head><body>
      <div class="deck">
        <div class="head">
          <span class="dot ${dotClass}" title="${escapeHtml(dotTitle)}"></span>
          <button class="name" data-cmd="overcast.selectCase" title="Active case: ${escapeHtml(caseName)} — click to switch the case folder">
            <span>${escapeHtml(caseName)}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">${ICONS.swap}</svg>
          </button>
          ${hasCase ? `<button class="icon-btn" data-cmd="overcast.openAgentTerminal" title="Open the overcast agent terminal"><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS.terminal}</svg></button>` : ""}
        </div>
        <div class="groups">${groupHtml}</div>
      </div>
      <script nonce="${n}">
        const vs = acquireVsCodeApi();
        for (const el of document.querySelectorAll("[data-cmd]")) {
          el.addEventListener("click", () => vs.postMessage({ command: el.getAttribute("data-cmd") }));
        }
      </script>
    </body></html>`;
  }
}
