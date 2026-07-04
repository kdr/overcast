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
import { clearToken, getCase, getState, pairToken, postAbort, postPrompt } from "./api.js";
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
  // whether the SSE stream is currently live; when it isn't (a transient resync
  // is retrying), a successful send/abort kicks a resync so the transcript
  // catches up now instead of waiting out the retry timer (Bugbot round 21).
  let streamConnected = false;
  const refreshIfDisconnected = (): void => {
    if (!streamConnected) void resync();
  };
  const composer = createComposer({
    onSend: async (text, mode) => {
      try {
        const res = await postPrompt(text, mode);
        if (res.delivered !== "turn") transcript.notice(`queued as ${res.delivered} — lands at the next loop point`);
        refreshIfDisconnected();
      } catch (e) {
        transcript.notice(`send failed: ${(e as Error).message}`, "error");
      }
    },
    onAbort: () => {
      void postAbort()
        .then(refreshIfDisconnected)
        .catch(() => transcript.notice("abort failed", "error"));
    },
  });

  let booted = false;
  let lastSeq = 0;
  let disconnect: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let resyncToken = 0;
  const ERROR_RESYNC_MS = 3000;

  const onEvent = (evt: ChairWireEvent): void => {
    if (evt.type === "hello") {
      // a hello re-baselines the dedupe cursor: after a desk rebind the bridge
      // resets its seq to 0, so a stale (larger) lastSeq would silently drop
      // every new event until a full resync. Trust the connection's own seq.
      lastSeq = evt.seq;
      statusbar.set({ caseName: evt.caseName, model: evt.model ?? "", busy: evt.busy });
      composer.setBusy(evt.busy);
      return;
    }
    // dedupe belt: EventSource reconnects / since-replay can re-send events
    if (evt.seq <= lastSeq) return;
    lastSeq = evt.seq;
    switch (evt.type) {
      case "state":
        statusbar.set({ busy: evt.busy, model: evt.model ?? "" });
        composer.setBusy(evt.busy);
        break;
      case "agent":
        statusbar.set({ busy: evt.phase === "start" });
        composer.setBusy(evt.phase === "start");
        // the run ended (possibly an abort, where message/tool end events don't
        // arrive) — close the open live line + running tool chips so later text
        // can't append to a stale line
        if (evt.phase === "end") transcript.finalizeRun();
        break;
      case "message":
        if (evt.phase === "start" && evt.role === "user") transcript.user(evt.text ?? "", evt.source ?? "desk");
        if (evt.phase === "start" && evt.role === "assistant") transcript.assistantStart();
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
        onStatus: (connected) => {
          streamConnected = connected;
          statusbar.set({ connected });
          // EventSource can't read the HTTP status, and it silently retries a
          // 401 (rotated token) forever. If it stays down, force a resync — its
          // getState surfaces the 401 → clearToken + re-pair gate. A quick
          // recovery cancels it, so a transient blip just reconnects.
          if (connected) {
            if (errorTimer) clearTimeout(errorTimer);
            errorTimer = undefined;
          } else if (!errorTimer) {
            errorTimer = setTimeout(() => {
              errorTimer = undefined;
              void resync();
            }, ERROR_RESYNC_MS);
          }
        },
      },
      since,
    );
  };

  const resync = async (): Promise<void> => {
    // in-flight guard: visibilitychange, gap, and the retry timer can all fire
    // resync concurrently; only the newest run may touch the UI/stream so their
    // getState/reset/openStream can't interleave.
    const token = ++resyncToken;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = undefined;
    }
    disconnect?.(); // no events while the transcript is rebuilt
    disconnect = undefined;
    streamConnected = false; // a manual close doesn't fire onStatus
    try {
      const snap = await getState();
      if (token !== resyncToken) return; // superseded by a newer resync
      statusbar.set({ caseName: snap.caseName, model: snap.model ?? "", busy: snap.busy, connected: true });
      composer.setBusy(snap.busy);
      transcript.reset(snap.transcript, snap.runningTools);
      // seed the live assistant line with any in-flight (unfinalized) text so a
      // mid-stream wake/gap doesn't blank it; later deltas append seamlessly
      if (snap.live) transcript.assistantDelta(snap.live);
      lastSeq = snap.seq;
      booted = true;
      openStream(snap.seq); // resume exactly where the snapshot left off
    } catch (e) {
      if (token !== resyncToken) return; // superseded — let the newer run own the outcome
      const message = (e as Error).message;
      if (!booted || message === "unauthorized") {
        // pre-boot failure, or the token was rotated (/chair off) → re-pair.
        // Drop the revoked token so a reload without a fresh #t= doesn't keep
        // sending it (matches the fallback console's 401 handling).
        if (message === "unauthorized") clearToken();
        gate(`connection failed: ${message} — re-scan the pairing QR from the desk (/chair qr).`);
        return;
      }
      // transient (network blip, laptop asleep): keep the console and retry, but
      // leave the stream CLOSED. Reopening it here with the old cursor while the
      // transcript wasn't rebuilt would replay events on top of stale state and
      // duplicate lines — the next successful resync reopens after a full reset.
      statusbar.set({ connected: false });
      transcript.notice(`resync failed: ${message} — retrying…`, "warning");
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
