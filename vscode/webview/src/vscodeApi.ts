// Thin wrapper over the VS Code webview messaging API.
import type { HostMsg, WebviewMsg } from "../../src/shared/protocol.ts";
import { acceptHostMessage } from "./hostMessage.ts";

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

export function onMessage(handler: (msg: HostMsg) => void): void {
  window.addEventListener("message", (e: MessageEvent) => {
    // origin + shape gates live in hostMessage.ts so they can be unit-tested
    const msg = acceptHostMessage(e, window.origin);
    if (msg) handler(msg);
  });
}
