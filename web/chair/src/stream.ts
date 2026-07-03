// The live event stream: native EventSource with its built-in reconnect +
// Last-Event-ID replay (the bridge keeps a ring buffer). A "gap" event or an
// iOS background suspension (visibilitychange) triggers a full resync via the
// snapshot instead of trusting a stale transcript.

import type { ChairWireEvent } from "../../../src/chair/wire.js";
import { pairToken } from "./api.js";

export interface StreamHandlers {
  onEvent: (evt: ChairWireEvent) => void;
  /** Stream lost or gapped — refetch /api/state and rebuild. */
  onResync: () => void;
  onStatus: (connected: boolean) => void;
}

export function connectStream(handlers: StreamHandlers): () => void {
  const source = new EventSource(`/events?token=${encodeURIComponent(pairToken())}`);
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
  const onVisible = (): void => {
    // Safari suspends EventSource in background tabs; resync on return
    if (document.visibilityState === "visible") handlers.onResync();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    source.close();
  };
}
