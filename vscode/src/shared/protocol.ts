// Host ↔ webview message contract, imported by BOTH the extension host
// (src/**) and the webview SPA (webview/src/**). Keep this file dependency-free
// (types only) — it must compile under both tsconfigs.

export type SpaView = "record" | "scan";

// ---- view state ------------------------------------------------------------

/** Field manifest row from `case memory get <id>` (paged large-field reads). */
export interface FieldInfo {
  name: string;
  type: string;
  /** display string from the CLI, e.g. "1.9KB" */
  size?: string;
  chars?: number;
  count?: number;
  preview?: string;
}

export interface RecordViewState {
  /** The full OvercastRecord (loose contract — render generically). */
  record: unknown;
  /** media.ref rewritten to a webview URI when local + previewable. */
  mediaWebviewUri?: string;
  /** Mime bucket for the media preview element. */
  mediaKind?: "image" | "video" | "audio";
  /** Large-field manifest (present when the record has pageable fields). */
  fields?: FieldInfo[];
}

export interface ScanHit {
  index: number;
  /** scan hit record id (capture-able ref) when present. */
  id?: string;
  title?: string;
  url?: string;
  excerpt?: string;
  source?: string;
  time?: string;
}

export interface ScanViewState {
  query: string;
  source?: string;
  hits: ScanHit[];
}

// ---- host → webview --------------------------------------------------------

export type HostMsg =
  | { type: "init"; view: SpaView; state: RecordViewState | ScanViewState }
  | {
      type: "fieldPage";
      recordId: string;
      field: string;
      offset: number;
      limit: number;
      total: number;
      text: string;
      hasMore: boolean;
    }
  | {
      type: "hitStatus";
      index: number;
      status: "working" | "done" | "error";
      note?: string;
      recordId?: string;
    }
  | { type: "error"; message: string };

// ---- webview → host --------------------------------------------------------

export type WebviewMsg =
  | { type: "ready" }
  | { type: "openExternal"; url: string }
  | { type: "openRecord"; recordId: string }
  | { type: "copy"; text: string }
  | { type: "getField"; recordId: string; field: string; offset: number; limit: number }
  | { type: "hitAction"; index: number; action: "capture" | "pullSense" | "open" };
