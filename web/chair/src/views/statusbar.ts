// Top status bar: chair mark, case, model chip, busy pulse, case-drawer button.

export interface StatusBar {
  el: HTMLElement;
  set(state: { caseName?: string; model?: string; busy?: boolean; connected?: boolean }): void;
}

export function createStatusBar(onCaseTap: () => void): StatusBar {
  const el = document.createElement("header");
  el.className = "statusbar";
  el.innerHTML = `
    <span class="mark">◉ CHAIR</span>
    <span class="case"></span>
    <span class="chip model"></span>
    <span class="spacer"></span>
    <span class="busy" hidden>working</span>
    <span class="chip link" hidden>reconnecting…</span>
  `;
  const caseEl = el.querySelector<HTMLElement>(".case")!;
  const modelEl = el.querySelector<HTMLElement>(".model")!;
  const busyEl = el.querySelector<HTMLElement>(".busy")!;
  const linkEl = el.querySelector<HTMLElement>(".link")!;
  const caseBtn = document.createElement("button");
  caseBtn.textContent = "case";
  caseBtn.addEventListener("click", onCaseTap);
  el.appendChild(caseBtn);

  return {
    el,
    set(state) {
      if (state.caseName !== undefined) caseEl.textContent = `case://${state.caseName}`;
      if (state.model !== undefined) modelEl.textContent = state.model || "—";
      if (state.busy !== undefined) busyEl.hidden = !state.busy;
      if (state.connected !== undefined) linkEl.hidden = state.connected;
    },
  };
}
