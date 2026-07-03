// Chair console boot: pair (token from the QR's URL fragment), snapshot, then
// live-drive the desk session — stream, steer/follow-up, abort, case glance.
//
// Resync discipline: the stream is closed BEFORE the snapshot fetch and
// reopened from the snapshot's seq (?since=), so a visibility wake or ring
// gap never duplicates or drops transcript entries. After first boot a failed
// resync degrades to a notice + retry — only an auth failure (token rotated /
// chair off) tears the console down to the pairing gate.

import "./theme.css";
import type { ChairWireEvent } from "../../../src/chair/wire.js";
import { getCase, getState, pairToken, postAbort, postPrompt } from "./api.js";
import { connectStream } from "./stream.js";
import { createStatusBar } from "./views/statusbar.js";
import { createTranscript } from "./views/transcript.js";
import { createComposer } from "./views/composer.js";
import { openCaseDrawer } from "./views/case.js";

const RETRY_MS = 8000;

const app = document.getElementById("app")!;

function gate(message: string): void {
  app.innerHTML = `<div class="gate"><div class="mark">◉ CHAIR</div><p>${message}</p></div>`;
}

async function boot(): Promise<void> {
  if (!pairToken()) {
    gate("not paired — scan the QR from <code>/chair on</code> in the desk session (the token rides in the QR link).");
    return;
  }

  const statusbar = createStatusBar(() => {
    void getCase()
      .then(openCaseDrawer)
      .catch(() => transcript.notice("case glance failed", "error"));
  });
  const transcript = createTranscript();
  const composer = createComposer({
    onSend: async (text, mode) => {
      try {
        const res = await postPrompt(text, mode);
        if (res.delivered !== "turn") transcript.notice(`queued as ${res.delivered} — lands at the next loop point`);
      } catch (e) {
        transcript.notice(`send failed: ${(e as Error).message}`, "error");
      }
    },
    onAbort: () => {
      void postAbort().catch(() => transcript.notice("abort failed", "error"));
    },
  });

  let booted = false;
  let lastSeq = 0;
  let disconnect: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const onEvent = (evt: ChairWireEvent): void => {
    // dedupe belt: EventSource reconnects can replay; hello is positional
    if (evt.type !== "hello") {
      if (evt.seq <= lastSeq) return;
      lastSeq = evt.seq;
    }
    switch (evt.type) {
      case "hello":
        statusbar.set({ caseName: evt.caseName, model: evt.model ?? "", busy: evt.busy });
        composer.setBusy(evt.busy);
        break;
      case "state":
        statusbar.set({ busy: evt.busy, model: evt.model ?? "" });
        composer.setBusy(evt.busy);
        break;
      case "agent":
        statusbar.set({ busy: evt.phase === "start" });
        composer.setBusy(evt.phase === "start");
        break;
      case "message":
        if (evt.phase === "start" && evt.role === "user") transcript.user(evt.text ?? "", evt.source ?? "desk");
        if (evt.phase === "end" && evt.role === "assistant") transcript.assistantEnd(evt.text ?? "");
        break;
      case "delta":
        if (evt.kind === "text") transcript.assistantDelta(evt.text);
        else transcript.thinkingDelta(evt.text);
        break;
      case "tool":
        if (evt.phase === "start") transcript.toolStart(evt.toolCallId, evt.name, evt.argsSummary);
        if (evt.phase === "end") transcript.toolEnd(evt.toolCallId, evt.isError);
        break;
      case "notice":
        transcript.notice(evt.text, evt.level);
        break;
      default:
        break;
    }
  };

  const openStream = (since?: number): void => {
    disconnect?.();
    disconnect = connectStream(
      {
        onEvent,
        onResync: () => void resync(),
        onStatus: (connected) => statusbar.set({ connected }),
      },
      since,
    );
  };

  const resync = async (): Promise<void> => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    disconnect?.(); // no events while the transcript is rebuilt
    disconnect = undefined;
    try {
      const snap = await getState();
      statusbar.set({ caseName: snap.caseName, model: snap.model ?? "", busy: snap.busy, connected: true });
      composer.setBusy(snap.busy);
      transcript.reset(snap.transcript);
      lastSeq = snap.seq;
      booted = true;
      openStream(snap.seq); // resume exactly where the snapshot left off
    } catch (e) {
      const message = (e as Error).message;
      if (!booted || message === "unauthorized") {
        // pre-boot failure, or the token was rotated (/chair off) → re-pair
        gate(`connection failed: ${message} — re-scan the pairing QR from the desk (/chair qr).`);
        return;
      }
      // transient (network blip, laptop asleep): keep the console, keep trying
      statusbar.set({ connected: false });
      transcript.notice(`resync failed: ${message} — retrying…`, "warning");
      openStream(lastSeq);
      retryTimer = setTimeout(() => void resync(), RETRY_MS);
    }
  };

  document.addEventListener("visibilitychange", () => {
    // Safari suspends EventSource in background tabs; rebuild on return
    if (document.visibilityState === "visible") void resync();
  });

  app.replaceChildren(statusbar.el, transcript.el, composer.el);
  await resync();
}

void boot();
