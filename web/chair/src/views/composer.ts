// Bottom composer: message box, delivery-mode segmented control
// (auto = steer while busy, new turn while idle), mic dictation, send + ABORT.

import type { ChairPromptMode } from "../../../../src/chair/wire.js";
import { createDictation } from "../dictation.js";

export interface Composer {
  el: HTMLElement;
  setBusy(busy: boolean): void;
}

export function createComposer(handlers: {
  onSend: (text: string, mode: ChairPromptMode) => Promise<void>;
  onAbort: () => void;
  onNotice: (text: string, level?: "info" | "warning" | "error") => void;
}): Composer {
  const el = document.createElement("footer");
  el.className = "composer";
  el.innerHTML = `
    <textarea rows="1" placeholder="message the desk…" autocomplete="off"></textarea>
    <span class="modes">
      <button type="button" data-mode="auto" class="active">auto</button>
      <button type="button" data-mode="steer">steer</button>
      <button type="button" data-mode="followUp">follow-up</button>
    </span>
    <span class="actions">
      <button type="button" class="mic" hidden>mic</button>
      <button type="button" class="abort">ABORT</button>
      <button type="button" class="send">send</button>
    </span>
  `;
  const input = el.querySelector<HTMLTextAreaElement>("textarea")!;
  const mic = el.querySelector<HTMLButtonElement>(".mic")!;
  const send = el.querySelector<HTMLButtonElement>(".send")!;
  const abort = el.querySelector<HTMLButtonElement>(".abort")!;
  let mode: ChairPromptMode = "auto";

  for (const btn of el.querySelectorAll<HTMLButtonElement>(".modes button")) {
    btn.addEventListener("click", () => {
      mode = (btn.dataset.mode ?? "auto") as ChairPromptMode;
      el.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  }

  const autosize = (): void => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.3)}px`;
  };

  // Dictation: tap-to-toggle. While listening the textarea is the live
  // transcript view (base text captured at start + finals + interim); a manual
  // stop keeps whatever is displayed, submit hard-cancels so a late final
  // flush can't repopulate the cleared box.
  let base = "";
  const dictation = createDictation({
    onText: (finalText, interim) => {
      const spoken = (finalText + interim).trim();
      input.value = base ? (spoken ? `${base} ${spoken}` : base) : spoken;
      autosize();
    },
    onState: (listening) => {
      mic.classList.toggle("on", listening);
      input.placeholder = listening ? "listening…" : busyPlaceholder();
    },
    onError: (message) => handlers.onNotice(message, "warning"),
  });
  if (dictation.support !== "unsupported") mic.hidden = false;
  if (dictation.support === "insecure") mic.classList.add("blocked");
  mic.addEventListener("click", () => {
    if (dictation.support === "insecure") {
      handlers.onNotice(
        "mic needs HTTPS (or localhost) — expose the chair with e.g. `tailscale serve` instead of the plain-HTTP tailnet bind",
        "warning",
      );
      return;
    }
    if (dictation.listening()) {
      dictation.stop();
    } else {
      base = input.value.trim();
      dictation.start();
    }
  });

  let busy = false;
  const busyPlaceholder = (): string => (busy ? "steer the running agent…" : "message the desk…");

  const submit = async (): Promise<void> => {
    dictation.cancel();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await handlers.onSend(text, mode);
      input.value = "";
      input.style.height = "auto";
    } finally {
      send.disabled = false;
    }
  };
  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });
  input.addEventListener("input", autosize);
  abort.addEventListener("click", () => {
    dictation.cancel(); // halting remote control stops the mic too (matches submit)
    handlers.onAbort();
  });

  return {
    el,
    setBusy(nowBusy) {
      busy = nowBusy;
      if (!dictation.listening()) input.placeholder = busyPlaceholder();
    },
  };
}
