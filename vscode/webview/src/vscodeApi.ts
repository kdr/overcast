// Thin wrapper over the VS Code webview messaging API.
import type { HostMsg, WebviewMsg } from "../../src/shared/protocol.ts";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(msg: WebviewMsg): void {
  api.postMessage(msg);
}

/** Origins a host→webview message may legitimately arrive from. VS Code serves
 *  webview content off a per-panel `vscode-webview://<uuid>` origin and the
 *  extension host posts into that same frame, so anything else is a stray sender
 *  (an embedded remote frame, another window) and must be ignored — an unchecked
 *  handler trusts whoever posts, CodeQL js/missing-origin-check. `""`/`"null"`
 *  cover the opaque-origin case some webview hosts report. */
function originAllowed(origin: string): boolean {
  return (
    origin === "" ||
    origin === "null" ||
    origin === window.origin ||
    origin.startsWith("vscode-webview://")
  );
}

/** The host contract is a discriminated union — anything without a string `type`
 *  is not one of ours, whatever origin it claims. */
function isHostMsg(data: unknown): data is HostMsg {
  return typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string";
}

export function onMessage(handler: (msg: HostMsg) => void): void {
  window.addEventListener("message", (e: MessageEvent) => {
    if (!originAllowed(e.origin) || !isHostMsg(e.data)) return;
    handler(e.data);
  });
}
