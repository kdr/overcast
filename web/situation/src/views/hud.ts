// HUD strip: case identity + the pulse chips (findings/triage/scan/monitor/
// brief freshness — same signals the wall HUD and `case status` derive), plus
// connection dot, live clock, and the OFF AIR state.

import type { SituationSnapshot, SituationWireEvent } from "../../../../src/situation/wire.js";
import { ageOf, el, fmtAge } from "../util.js";

export interface HudView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
  setConnected(connected: boolean): void;
  monitorPulse(evt: Extract<SituationWireEvent, { type: "monitor" }>): void;
  setOffAir(reason: string): void;
}

export function createHud(): HudView {
  const root = el("header", "hud");
  const brand = el("span", "brand", "◉ OVERCAST SITUATION");
  const caseName = el("span", "case");
  const chips = el("span");
  chips.style.display = "contents";
  const right = el("span", "right");
  const passChip = el("span", "chip cyan");
  passChip.style.display = "none";
  const conn = el("span", "conn");
  const clock = el("span", "clock");
  right.append(passChip, conn, clock);
  root.append(brand, caseName, chips, right);

  const tick = (): void => {
    clock.textContent = new Date().toLocaleTimeString();
  };
  tick();
  setInterval(tick, 1000);

  let generatedAt: string | null = null;

  const chip = (text: string, tone = ""): HTMLElement => el("span", `chip${tone ? ` ${tone}` : ""}`, text);

  return {
    el: root,
    update(snap) {
      caseName.textContent = `CASE ▸ ${snap.caseName}`;
      caseName.title = snap.caseDir;
      generatedAt = snap.generatedAt;
      const hud = snap.hud;
      const next: HTMLElement[] = [];
      next.push(chip(`● ${hud.openFindings} OPEN FINDING${hud.openFindings === 1 ? "" : "S"}`, hud.openFindings ? "bad" : ""));
      if (hud.suggestedFindings) next.push(chip(`TRIAGE ${hud.suggestedFindings}`, "amber"));
      for (const s of hud.lastScans.slice(0, 4)) next.push(chip(`SCAN ${s.source.toUpperCase()} ${fmtAge(s.ageSeconds)}`, "cyan"));
      if (hud.monitor) next.push(chip(`MONITOR ${fmtAge(hud.monitor.ageSeconds)} · +${hud.monitor.newItems}`, "amber"));
      if (hud.briefAgeSeconds != null) next.push(chip(`BRIEF ${fmtAge(hud.briefAgeSeconds)}`, "magenta"));
      next.push(chip(`${hud.records} RECORDS`));
      if (snap.monitor?.every) {
        next.push(chip(`CADENCE ${snap.monitor.every} · PASS ${snap.monitor.passes}`, "cyan"));
      }
      next.push(chip(`SYNC ${fmtAge(ageOf(generatedAt))}`, "muted"));
      chips.replaceChildren(...next);
    },
    setConnected(connected) {
      conn.classList.toggle("on", connected);
      conn.title = connected ? "live" : "reconnecting…";
    },
    monitorPulse(evt) {
      if (evt.phase === "start") {
        passChip.style.display = "";
        passChip.textContent = `PASS ${evt.pass} RUNNING…`;
      } else {
        passChip.textContent = `PASS ${evt.pass}${evt.newItems !== undefined ? ` — ${evt.newItems} NEW` : ""}${evt.error ? " — ERR" : ""}`;
        passChip.className = `chip ${evt.error ? "bad" : "cyan"}`;
        setTimeout(() => {
          passChip.style.display = "none";
          passChip.className = "chip cyan";
        }, 8000);
      }
    },
    setOffAir(reason) {
      conn.classList.remove("on");
      passChip.style.display = "none";
      chips.replaceChildren(el("span", "offair", `■ OFF AIR — ${reason}`));
    },
  };
}
