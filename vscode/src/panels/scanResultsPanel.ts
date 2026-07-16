// "Scan: <query>" editor tab listing scan hits with per-hit actions —
// Capture (`capture <hit record id>` — verified: capture accepts a scan.hit
// record id, URL, or local path and emits a capture record with
// payload.capture_id + media.ref), Pull + Sense (capture, then the
// media-appropriate watch/see/listen ON THE CAPTURE RECORD ID — verified:
// media args resolve capture record ids; there is NO standalone `pull` verb),
// Open URL. Uses the shared SPA host (webviewHost.ts, view "scan").
import * as vscode from "vscode";
import type { HostMsg, ScanHit, ScanViewState } from "../shared/protocol.ts";
import type { ExtDeps } from "../types.ts";
import { createSpaPanel } from "./webviewHost.ts";

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|ts)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

/** Pick the sense verb for a captured media ref (default: watch). */
export function senseVerbFor(mediaRef: string): "watch" | "see" | "listen" {
  if (IMAGE_EXT.test(mediaRef)) return "see";
  if (AUDIO_EXT.test(mediaRef)) return "listen";
  if (VIDEO_EXT.test(mediaRef)) return "watch";
  return "watch";
}

async function captureHit(
  deps: ExtDeps,
  post: (msg: HostMsg) => void,
  hit: ScanHit,
  alsoSense: boolean,
): Promise<void> {
  const status = (
    status: "working" | "done" | "error",
    note: string,
    recordId?: string,
  ): void => post({ type: "hitStatus", index: hit.index, status, note, recordId });

  const ref = hit.id ?? hit.url;
  if (!ref) {
    status("error", "hit has no capturable ref");
    return;
  }
  status("working", "capturing…");
  const cap = await deps.bridge.run(["capture", ref]);
  if (cap.failure) {
    status("error", cap.failure.message);
    return;
  }
  const capRec = cap.records.find((r) => r.verb === "capture");
  if (!capRec) {
    status("error", "no capture record emitted");
    return;
  }
  deps.router.refresh();
  if (!alsoSense) {
    status("done", "captured", capRec.id);
    return;
  }

  const payload = (capRec.payload ?? {}) as Record<string, unknown>;
  const mediaRef =
    capRec.media?.ref ?? (typeof payload.path === "string" ? payload.path : "");
  const verb = senseVerbFor(mediaRef);
  status("working", `captured — running ${verb}…`);
  const sensed = await deps.bridge.run([verb, capRec.id]);
  if (sensed.failure) {
    status("error", `captured (${capRec.id}) but ${verb} failed: ${sensed.failure.message}`);
    return;
  }
  const senseRec = sensed.records.find((r) => r.verb === verb) ?? sensed.records[0];
  deps.router.refresh();
  const pending = senseRec?.state === "pending" ? " (pending)" : "";
  status("done", `captured + ${verb}${pending}`, senseRec?.id ?? capRec.id);
}

export async function openScanResultsPanel(deps: ExtDeps, state: ScanViewState): Promise<void> {
  const running = new Set<number>();
  await createSpaPanel(deps.context, {
    viewType: "overcast.scan",
    title: `Scan: ${state.query}`,
    view: "scan",
    state,
    onMessage: (msg, webview) => {
      if (msg.type === "openRecord") {
        void deps.router.openRecord(msg.recordId);
        return;
      }
      if (msg.type !== "hitAction") return;
      const hit = state.hits.find((h) => h.index === msg.index);
      if (!hit) return;
      if (msg.action === "open") {
        if (hit.url && /^https?:\/\//i.test(hit.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(hit.url));
        } else {
          void vscode.window.showInformationMessage(
            `Overcast: hit has no external URL${hit.url ? ` (${hit.url})` : ""}.`,
          );
        }
        return;
      }
      if (running.has(hit.index)) return;
      running.add(hit.index);
      const post = (m: HostMsg): void => void webview.postMessage(m);
      void captureHit(deps, post, hit, msg.action === "pullSense").finally(() =>
        running.delete(hit.index),
      );
    },
  });
}
