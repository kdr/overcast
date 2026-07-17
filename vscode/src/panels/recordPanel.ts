// Record detail editor tab. Data source is the CLI-sanctioned full read:
//   case memory get <id>            → {record, verb, state, media{ref}, fields[]}
//   case memory get <id> --field f --offset o --limit n
//                                   → {chunk, total, returned, has_more, next_offset}
// (verified against the fixture case; NOTE the manifest's field `size` is a
// display string like "1.9KB", so only chars/count/preview are forwarded).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FieldInfo, RecordViewState } from "../shared/protocol.ts";
import type { ExtDeps } from "../types.ts";
import { createSpaPanel } from "./webviewHost.ts";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|heic)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|mpeg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

function mediaKindFor(ref: string): RecordViewState["mediaKind"] {
  if (IMAGE_EXT.test(ref)) return "image";
  if (VIDEO_EXT.test(ref)) return "video";
  if (AUDIO_EXT.test(ref)) return "audio";
  return undefined;
}

interface MemoryManifest {
  record?: string;
  verb?: string;
  state?: string;
  media?: { ref?: string; at?: string };
  fields?: Array<{
    name?: string;
    type?: string;
    size?: unknown;
    chars?: number;
    count?: number;
    preview?: string;
  }>;
  error?: string;
}

interface FieldPagePayload {
  record?: string;
  field?: string;
  offset?: number;
  limit?: number;
  total?: number;
  returned?: number;
  has_more?: boolean;
  next_offset?: number;
  chunk?: unknown;
  error?: string;
}

export async function openRecordPanel(deps: ExtDeps, recordId: string): Promise<void> {
  if (!(await deps.bridge.ensureCli())) return;
  const result = await deps.bridge.run(["case", "memory", "get", recordId]);
  if (result.failure) {
    void vscode.window.showErrorMessage(`Overcast: ${result.failure.message}`);
    return;
  }
  const manifest = (result.records[0]?.payload ?? {}) as MemoryManifest;
  if (manifest.error) {
    void vscode.window.showErrorMessage(`Overcast: ${manifest.error}`);
    return;
  }

  const fields: FieldInfo[] = (manifest.fields ?? [])
    .filter((f): f is { name: string; type: string } & typeof f => !!f.name && !!f.type)
    .map((f) => ({
      name: f.name,
      type: f.type,
      chars: f.chars,
      count: f.count,
      preview: f.preview,
    }));

  const mediaRef = manifest.media?.ref;
  const mediaExists = !!mediaRef && path.isAbsolute(mediaRef) && fs.existsSync(mediaRef);
  const state: RecordViewState = {
    record: manifest,
    fields,
    mediaKind: mediaExists && mediaRef ? mediaKindFor(mediaRef) : undefined,
  };

  const panel = await createSpaPanel(deps.context, {
    viewType: "overcast.record",
    title: `${manifest.verb ?? "record"} ${recordId}`,
    view: "record",
    state,
    extraLocalRoots: mediaExists && mediaRef ? [vscode.Uri.file(path.dirname(mediaRef))] : [],
    onMessage: (msg, webview) => {
      if (msg.type === "openRecord") {
        void deps.router.openRecord(msg.recordId);
        return;
      }
      if (msg.type === "openMedia") {
        // the ref comes from the host-side manifest (trusted), not the webview
        if (mediaExists && mediaRef) {
          void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(mediaRef));
        }
        return;
      }
      if (msg.type !== "getField") return;
      void (async () => {
        const page = await deps.bridge.run([
          "case",
          "memory",
          "get",
          msg.recordId,
          "--field",
          msg.field,
          "--offset",
          String(msg.offset),
          "--limit",
          String(msg.limit),
        ]);
        const payload = (page.records[0]?.payload ?? {}) as FieldPagePayload;
        if (page.failure || payload.error) {
          void webview.postMessage({
            type: "error",
            message: payload.error ?? page.failure?.message ?? "field read failed",
          });
          return;
        }
        void webview.postMessage({
          type: "fieldPage",
          recordId: msg.recordId,
          field: payload.field ?? msg.field,
          offset: payload.offset ?? msg.offset,
          limit: payload.limit ?? msg.limit,
          total: payload.total ?? 0,
          text: typeof payload.chunk === "string" ? payload.chunk : JSON.stringify(payload.chunk),
          hasMore: payload.has_more === true,
        });
      })();
    },
  });

  // The SPA's "ready" arrives after the webview loads; opts.state is captured
  // by reference in the handshake, so enriching it here (post-create, when the
  // webview finally exists for asWebviewUri) lands in the init message.
  if (mediaExists && mediaRef && state.mediaKind) {
    state.mediaWebviewUri = panel.webview.asWebviewUri(vscode.Uri.file(mediaRef)).toString();
  }
}
