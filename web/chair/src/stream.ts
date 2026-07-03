// The live event stream: native EventSource with its built-in reconnect +
// Last-Event-ID replay (the bridge keeps a ring buffer). A fresh connection
// can also resume from a known snapshot seq via ?since= — main.ts uses that to
// resync without duplicating or dropping events (fetch state → reset → resume
// from the snapshot's seq). A "gap" event means the ring was outrun: resync.

import type { ChairWireEvent } from "../../../src/chair/wire.js";
import { pairToken } from "./api.js";

export interface StreamHandlers {
  onEvent: (evt: ChairWireEvent) => void;
  /** Stream lost the plot (ring-buffer gap) — refetch /api/state and rebuild. */
  onResync: () => void;
  onStatus: (connected: boolean) => void;
}

/** Open the SSE stream, optionally resuming after `since`. Returns a closer. */
export function connectStream(handlers: StreamHandlers, since?: number): () => void {
  const params = new URLSearchParams({ token: pairToken() });
  if (since !== undefined) params.set("since", String(since));
  const source = new EventSource(`/events?${params}`);
  source.onopen = () => handlers.onStatus(true);
  source.onerror = () => handlers.onStatus(false);
  source.onmessage = (msg) => {
    let evt: ChairWireEvent;
    try {
      evt = JSON.parse(msg.data) as ChairWireEvent;
    } catch {
      return;
    }
    if (evt.type === "gap") {
      handlers.onResync();
      return;
    }
    handlers.onEvent(evt);
  };
  return () => source.close();
}
