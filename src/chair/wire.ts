// The chair wire protocol — the stable JSON contract between the in-session
// bridge (src/chair/bridge.ts) and the phone console (web/chair). The console
// imports these types (type-only, erased at build), so this file is the single
// source of truth for both sides. Keep it additive: the console may lag the
// desk binary by a version.

/** One SSE event on `GET /events`. `seq` is monotonic and doubles as the SSE
 *  `id:` — reconnecting clients replay everything after their `Last-Event-ID`. */
export type ChairWireEvent =
  | {
      type: "hello";
      seq: number;
      caseName: string;
      session?: string;
      model?: string;
      busy: boolean;
      clients: number;
      version: string;
    }
  | {
      type: "state";
      seq: number;
      busy: boolean;
      pending: boolean;
      model?: string;
      ctxPercent?: number | null;
    }
  | { type: "agent"; seq: number; phase: "start" | "end" }
  | { type: "turn"; seq: number; phase: "start" | "end"; turnIndex?: number }
  | {
      type: "message";
      seq: number;
      phase: "start" | "end";
      role: "user" | "assistant";
      text?: string;
      source?: "desk" | "chair";
    }
  /** Streaming assistant output, coalesced by the bridge (≤ ~1 flush / 40ms). */
  | { type: "delta"; seq: number; kind: "text" | "thinking"; text: string }
  | {
      type: "tool";
      seq: number;
      phase: "start" | "update" | "end";
      toolCallId: string;
      name: string;
      argsSummary?: string;
      isError?: boolean;
      resultSummary?: string;
    }
  | { type: "notice"; seq: number; level: "info" | "warning" | "error"; text: string }
  /** The client asked to replay from a seq that fell out of the ring buffer —
   *  it should refetch `GET /api/state` and continue from the stream. */
  | { type: "gap"; seq: number };

/** A flattened session entry for the late-joiner snapshot. */
export interface TranscriptItem {
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  /** "desk" | "chair" for user items (chair = injected from the console). */
  source?: "desk" | "chair";
  at?: string;
}

/** `GET /api/state` — everything a late-joining console needs to render. */
export interface ChairSnapshot {
  seq: number;
  busy: boolean;
  session?: string;
  model?: string;
  caseName: string;
  caseDir: string;
  profile: string;
  clients: number;
  version: string;
  transcript: TranscriptItem[];
  /** In-flight assistant text (partial, mid-stream). Absent when idle — the
   *  console seeds its live line with this after a resync so a wake/gap during
   *  an active run doesn't blank streamed text that isn't finalized yet. */
  live?: string;
}

// --- case glance (`GET /api/case`) ------------------------------------------

export interface GlanceFinding {
  id: string;
  text: string;
  status: string;
  target?: string;
  time?: string;
}

export interface GlanceRecord {
  verb: string;
  id: string;
  time?: string;
  summary: string;
}

/** Read-only case summary: standing scope + open findings + latest evidence. */
export interface CaseGlance {
  caseName: string;
  dir: string;
  records: number;
  counts: Record<string, number>;
  targets: { id: string; kind: string; value: string }[];
  sources: { id: string; type: string; ref: string; enabled: boolean }[];
  openFindings: GlanceFinding[];
  /** newest record per verb, newest verbs first */
  latest: GlanceRecord[];
}

// --- command bodies -----------------------------------------------------------

export type ChairPromptMode = "auto" | "steer" | "followUp";

export interface ChairPromptBody {
  text: string;
  mode?: ChairPromptMode;
}

/** `POST /api/prompt` response: how the message was queued (202 — delivery is
 *  observed on the event stream, not guaranteed by this response). */
export interface ChairPromptResult {
  delivered: "turn" | "steer" | "followUp";
}
