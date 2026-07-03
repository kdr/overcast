// Chair console boot: pair (token from the QR's URL fragment), snapshot, then
// live-drive the desk session — stream, steer/follow-up, abort, case glance.

import "./theme.css";
import type { ChairWireEvent } from "../../../src/chair/wire.js";
import { getCase, getState, pairToken, postAbort, postPrompt } from "./api.js";
import { connectStream } from "./stream.js";
import { createStatusBar } from "./views/statusbar.js";
import { createTranscript } from "./views/transcript.js";
import { createComposer } from "./views/composer.js";
import { openCaseDrawer } from "./views/case.js";

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

  const resync = async (): Promise<void> => {
    try {
      const snap = await getState();
      statusbar.set({ caseName: snap.caseName, model: snap.model ?? "", busy: snap.busy, connected: true });
      composer.setBusy(snap.busy);
      transcript.reset(snap.transcript);
    } catch (e) {
      gate(`connection failed: ${(e as Error).message} — re-scan the pairing QR?`);
    }
  };

  const onEvent = (evt: ChairWireEvent): void => {
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

  app.replaceChildren(statusbar.el, transcript.el, composer.el);
  await resync();
  connectStream({
    onEvent,
    onResync: () => void resync(),
    onStatus: (connected) => statusbar.set({ connected }),
  });
}

void boot();
