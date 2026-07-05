// Bottom composer: message box, delivery-mode segmented control
// (auto = steer while busy, new turn while idle), send + ABORT.

import type { ChairPromptMode } from "../../../../src/chair/wire.js";

export interface Composer {
  el: HTMLElement;
  setBusy(busy: boolean): void;
}

export function createComposer(handlers: {
  onSend: (text: string, mode: ChairPromptMode) => Promise<void>;
  onAbort: () => void;
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
      <button type="button" class="abort">ABORT</button>
      <button type="button" class="send">send</button>
    </span>
  `;
  const input = el.querySelector<HTMLTextAreaElement>("textarea")!;
  const send = el.querySelector<HTMLButtonElement>(".send")!;
  const abort = el.querySelector<HTMLButtonElement>(".abort")!;
  let mode: ChairPromptMode = "auto";

  for (const btn of el.querySelectorAll<HTMLButtonElement>(".modes button")) {
    btn.addEventListener("click", () => {
      mode = (btn.dataset.mode ?? "auto") as ChairPromptMode;
      el.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  }

  const submit = async (): Promise<void> => {
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
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.3)}px`;
  });
  abort.addEventListener("click", handlers.onAbort);

  return {
    el,
    setBusy(busy) {
      input.placeholder = busy ? "steer the running agent…" : "message the desk…";
    },
  };
}
