// Admission rules for host→webview messages, kept in their own module (free of
// the `acquireVsCodeApi()` top-level call in vscodeApi.ts) so they are directly
// unit-testable — this is a security boundary, and an untested one is a
// decorative one.

import type { HostMsg } from "../../src/shared/protocol.ts";

/** Host→webview messages must come from THIS panel's own origin — nothing
 *  broader. VS Code's webview preload forwards the extension host's message into
 *  the content frame with `postMessage(data.message, window.origin, …)`, so a
 *  genuine host message always arrives with `event.origin === window.origin`.
 *
 *  Accepting any `vscode-webview://…` origin (or the opaque `""`/`"null"`) would
 *  widen this to other panels and sandboxed frames, which is exactly the stray
 *  sender the check exists to reject — an unchecked handler trusts whoever posts
 *  (CodeQL js/missing-origin-check). */
export function originAllowed(origin: string, selfOrigin: string): boolean {
  // an empty selfOrigin (non-browser/opaque context) must never turn into
  // "everything matches" — reject rather than fail open
  return selfOrigin !== "" && origin === selfOrigin;
}

/** The host contract is a discriminated union — anything without a string `type`
 *  is not one of ours, whatever origin it claims. */
export function isHostMsg(data: unknown): data is HostMsg {
  return typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string";
}

/** The message if it passes BOTH gates, else undefined. */
export function acceptHostMessage(
  event: { origin: string; data: unknown },
  selfOrigin: string,
): HostMsg | undefined {
  if (!originAllowed(event.origin, selfOrigin)) return undefined;
  return isHostMsg(event.data) ? event.data : undefined;
}
