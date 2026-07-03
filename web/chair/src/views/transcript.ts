// Scrolling transcript: finalized entries + one live assistant entry fed by
// deltas, tool rows keyed by toolCallId, sticky autoscroll (only when the
// reader is already at the bottom).

import type { TranscriptItem } from "../../../../src/chair/wire.js";

export interface Transcript {
  el: HTMLElement;
  reset(items: TranscriptItem[]): void;
  user(text: string, source: "desk" | "chair"): void;
  assistantDelta(text: string): void;
  thinkingDelta(text: string): void;
  assistantEnd(text: string): void;
  toolStart(id: string, name: string, argsSummary?: string): void;
  toolEnd(id: string, isError?: boolean): void;
  notice(text: string, level?: "info" | "warning" | "error"): void;
}

export function createTranscript(): Transcript {
  const el = document.createElement("main");
  el.className = "transcript";

  let live: HTMLElement | undefined;
  let thinking: HTMLElement | undefined;
  const tools = new Map<string, HTMLElement>();

  const nearBottom = (): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const append = (node: HTMLElement): void => {
    const stick = nearBottom();
    el.appendChild(node);
    if (stick) el.scrollTop = el.scrollHeight;
  };
  const entry = (cls: string, text?: string): HTMLElement => {
    const div = document.createElement("div");
    div.className = `entry ${cls}`;
    if (text !== undefined) div.textContent = text;
    return div;
  };
  const endLive = (): void => {
    live?.classList.remove("live");
    live = undefined;
    thinking?.remove();
    thinking = undefined;
  };

  return {
    el,
    reset(items) {
      endLive();
      tools.clear();
      el.replaceChildren();
      for (const item of items) {
        if (item.role === "user") this.user(item.text, item.source ?? "desk");
        else if (item.role === "assistant") append(entry("assistant", item.text));
        else if (item.role === "tool") {
          const row = entry(`tool${item.text === "(error)" ? " error" : ""}`);
          row.innerHTML = `⚙ <span class="name"></span>`;
          row.querySelector(".name")!.textContent = item.toolName ?? "tool";
          append(row);
        }
      }
      el.scrollTop = el.scrollHeight;
    },
    user(text, source) {
      endLive();
      const div = entry(`user${source === "chair" ? " chair" : ""}`);
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = source === "chair" ? "you · from the chair" : "desk";
      div.appendChild(who);
      div.appendChild(document.createTextNode(text));
      append(div);
    },
    assistantDelta(text) {
      if (!live) {
        live = entry("assistant live");
        append(live);
      }
      const stick = nearBottom();
      live.textContent = (live.textContent ?? "") + text;
      if (stick) el.scrollTop = el.scrollHeight;
    },
    thinkingDelta(text) {
      if (!thinking) {
        thinking = entry("thinking");
        append(thinking);
      }
      thinking.textContent = ((thinking.textContent ?? "") + text).slice(-600);
    },
    assistantEnd(text) {
      if (live) {
        live.classList.remove("live");
        if (text) live.textContent = text;
        live = undefined;
      } else if (text) {
        append(entry("assistant", text));
      }
      thinking?.remove();
      thinking = undefined;
    },
    toolStart(id, name, argsSummary) {
      const row = entry("tool running");
      row.innerHTML = `⚙ <span class="name"></span> <span class="args"></span>`;
      row.querySelector(".name")!.textContent = name;
      if (argsSummary) row.querySelector(".args")!.textContent = argsSummary;
      tools.set(id, row);
      append(row);
    },
    toolEnd(id, isError) {
      const row = tools.get(id);
      tools.delete(id);
      if (!row) return;
      row.classList.remove("running");
      if (isError) row.classList.add("error");
    },
    notice(text, level = "info") {
      append(entry(`notice${level === "error" ? " error" : ""}`, text));
    },
  };
}
