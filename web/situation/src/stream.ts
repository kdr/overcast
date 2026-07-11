// The live event stream: native EventSource with its built-in reconnect +
// Last-Event-ID replay (the server keeps a ring buffer). A "gap" event means
// the ring was outrun — the caller refetches /api/state. Identical discipline
// to the chair console's stream.ts, over the situation wire.

import type { SituationWireEvent } from "../../../src/situation/wire.js";
import { pairToken } from "./api.js";

export interface StreamHandlers {
  onEvent: (evt: SituationWireEvent) => void;
  /** Stream lost the plot (ring-buffer gap) — refetch /api/state and rebuild. */
  onResync: () => void;
  onStatus: (connected: boolean) => void;
}

/** Open the SSE stream, optionally resuming after `since`. Returns a closer. */
export function connectStream(handlers: StreamHandlers, since?: number): () => void {
  const params = new URLSearchParams({ token: pairToken() });
  if (since !== undefined) params.set("since", String(since));
  const source = new EventSource(`/events?${params}`);
  let closed = false;
  source.onopen = () => {
    if (!closed) handlers.onStatus(true);
  };
  source.onerror = () => {
    if (!closed) handlers.onStatus(false);
  };
  source.onmessage = (msg) => {
    if (closed) return;
    let evt: SituationWireEvent;
    try {
      evt = JSON.parse(msg.data) as SituationWireEvent;
    } catch {
      return;
    }
    if (evt.type === "gap") {
      handlers.onResync();
      return;
    }
    handlers.onEvent(evt);
  };
  return () => {
    closed = true;
    source.onopen = null;
    source.onerror = null;
    source.onmessage = null;
    source.close();
  };
}
