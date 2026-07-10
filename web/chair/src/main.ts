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

  // Any 401 from an action (not just resync) means the token was rotated —
  // clear it and re-pair, per api.ts's contract (Bugbot round 24).
  const isAuthError = (e: unknown): boolean => (e as Error)?.message === "unauthorized";
  // Once we've gated on auth failure, ALL background activity must stop — the
  // SSE stream, the retry/error timers, and the visibilitychange resync — and
  // the revoked token must leave the URL, so nothing keeps hitting the bridge
  // with the dead bearer after the UI says "re-pair" (Bugbot round 28).
  let gated = false;
  const teardownSession = (): void => {
    gated = true;
    disconnect?.(); // close the EventSource (stops its auto-reconnect)
    disconnect = undefined;
    streamConnected = false;
    if (retryTimer) clearTimeout(retryTimer);
    if (errorTimer) clearTimeout(errorTimer);
    retryTimer = errorTimer = undefined;
    // strip the revoked #t= so pairToken() can't re-read it; a new QR re-pairs
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* history API unavailable — the teardown above already stopped traffic */
    }
  };
  const onAuthFailure = (msg = "unauthorized — the pairing token was rotated"): void => {
    teardownSession();
    clearToken();
    gate(`${msg}. Re-scan the QR from the desk (/chair qr).`);
  };
  const statusbar = createStatusBar(() => {
    void getCase()
      .then(openCaseDrawer)
      .catch((e) => (isAuthError(e) ? onAuthFailure() : transcript.notice("case glance failed", "error")));
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
        if (isAuthError(e)) return onAuthFailure();
        transcript.notice(`send failed: ${(e as Error).message}`, "error");
      }
    },
    onAbort: () => {
      void postAbort()
        .then(refreshIfDisconnected)
        .catch((e) => (isAuthError(e) ? onAuthFailure() : transcript.notice("abort failed", "error")));
    },
    onNotice: (text, level) => transcript.notice(text, level),
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
    if (gated) return; // session torn down after auth failure — no more traffic
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
      if (gated) return; // a teardown (auth failure) landed while getState was in-flight — stay down
      // getState succeeded but the SSE isn't up yet — leave "connected" to the
      // stream's onopen (still "reconnecting…" until then), don't claim it here
      statusbar.set({ caseName: snap.caseName, model: snap.model ?? "", busy: snap.busy, connected: false });
      composer.setBusy(snap.busy);
      transcript.reset(snap.transcript, snap.runningTools);
      // seed the live assistant line with any in-flight (unfinalized) text so a
      // mid-stream wake/gap doesn't blank it; later deltas append seamlessly
      if (snap.live) transcript.assistantDelta(snap.live);
      lastSeq = snap.seq;
      booted = true;
      openStream(snap.seq); // resume exactly where the snapshot left off — onopen flips connected true
    } catch (e) {
      if (token !== resyncToken) return; // superseded — let the newer run own the outcome
      if (gated) return; // torn down mid-flight — don't retry or re-gate
      const message = (e as Error).message;
      if (message === "unauthorized") {
        // token rotated (/chair off) or a bad QR → tear down + re-pair.
        onAuthFailure("connection failed: unauthorized");
        return;
      }
      // transient (network blip, desk still starting, laptop asleep) — pre- OR
      // post-boot: keep the console and retry. A first-load blip must NOT send
      // the operator to the re-pair gate. The stream stays CLOSED; the next
      // successful resync reopens after a full reset (no replay on stale state).
      statusbar.set({ connected: false });
      transcript.notice(booted ? `resync failed: ${message} — retrying…` : `connecting to the desk… (${message})`, "warning");
      retryTimer = setTimeout(() => void resync(), RETRY_MS);
    }
  };

  document.addEventListener("visibilitychange", () => {
    // Safari suspends EventSource in background tabs; rebuild on return
    if (!gated && document.visibilityState === "visible") void resync();
  });

  app.replaceChildren(statusbar.el, transcript.el, composer.el);
  await resync();
}

void boot();
