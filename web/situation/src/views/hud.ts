// HUD strip: case identity + pulse chips (findings/triage/scan/monitor/brief
// freshness — the same signals the wall HUD and `case status` derive) + a
// connection dot, a live clock, and sync controls. Chips are TAPPABLE — each
// opens a popover with a glance of detail. The SYNC control shows the last-sync
// age + the server poll interval and a ⟳ force-sync button.

import type { SituationSnapshot, SituationWireEvent } from "../../../../src/situation/wire.js";
import { sourceStyle } from "../sources.js";
import { ageOf, el, fmtAge } from "../util.js";

export interface HudView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
  setConnected(connected: boolean): void;
  monitorPulse(evt: Extract<SituationWireEvent, { type: "monitor" }>): void;
  setOffAir(reason: string): void;
  /** flash the sync control while a force-sync is in flight */
  syncing(on: boolean): void;
}

interface Chip {
  text: string;
  tone: string;
  color?: string;
  detail: string;
}

export function createHud(onSyncNow: () => void): HudView {
  const root = el("header", "hud");
  const brand = el("span", "brand", "◉ OVERCAST SITUATION");
  const caseName = el("span", "case");
  const chips = el("span");
  chips.style.display = "contents";
  const right = el("span", "right");
  const passChip = el("span", "chip cyan");
  passChip.style.display = "none";
  const syncBtn = el("button", "syncbtn", "⟳");
  syncBtn.title = "sync to now";
  syncBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onSyncNow();
  });
  const conn = el("span", "conn");
  const clock = el("span", "clock");
  right.append(passChip, syncBtn, conn, clock);
  root.append(brand, caseName, chips, right);

  // one shared popover, positioned under the tapped chip
  const pop = el("div", "hud-pop");
  pop.style.display = "none";
  document.body.append(pop);
  const closePop = (): void => {
    pop.style.display = "none";
  };
  document.addEventListener("click", closePop);
  window.addEventListener("resize", closePop);

  const openPop = (anchor: HTMLElement, detail: string): void => {
    pop.textContent = detail;
    pop.style.display = "block";
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 10)}px`;
    pop.style.top = `${r.bottom + 6}px`;
  };

  const tick = (): void => {
    clock.textContent = new Date().toLocaleTimeString();
  };
  tick();
  setInterval(tick, 1000);

  let generatedAt: string | null = null;

  const build = (snap: SituationSnapshot): Chip[] => {
    const hud = snap.hud;
    const out: Chip[] = [];
    out.push({
      text: `● ${hud.openFindings} OPEN FINDING${hud.openFindings === 1 ? "" : "S"}`,
      tone: hud.openFindings ? "bad" : "",
      detail: `${hud.openFindings} open finding${hud.openFindings === 1 ? "" : "s"} in this case.`,
    });
    if (hud.suggestedFindings) {
      out.push({ text: `TRIAGE ${hud.suggestedFindings}`, tone: "amber", detail: `${hud.suggestedFindings} suggested lead(s) awaiting triage (finding accept/dismiss).` });
    }
    for (const s of hud.lastScans.slice(0, 5)) {
      const st = sourceStyle(s.source);
      out.push({
        text: `${st.emoji} ${st.label.toUpperCase()} ${fmtAge(s.ageSeconds)}`,
        tone: "",
        color: st.color,
        detail: `Last ${st.label} scan ${new Date(s.time).toLocaleString()} — ${fmtAge(s.ageSeconds)} ago.`,
      });
    }
    if (hud.monitor) {
      out.push({
        text: `MONITOR ${fmtAge(hud.monitor.ageSeconds)} · +${hud.monitor.newItems}`,
        tone: "amber",
        detail: `Last monitor pass ${new Date(hud.monitor.time).toLocaleString()} — ${hud.monitor.newItems} new item(s).`,
      });
    }
    if (hud.briefAgeSeconds != null) out.push({ text: `BRIEF ${fmtAge(hud.briefAgeSeconds)}`, tone: "magenta", detail: `Last brief generated ${fmtAge(hud.briefAgeSeconds)} ago.` });
    const counts = Object.entries(hud.counts).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ${n}`).join(" · ");
    out.push({ text: `${hud.records} RECORDS`, tone: "", detail: `${hud.records} records — ${counts}` });
    if (snap.monitor?.every) {
      out.push({ text: `CADENCE ${snap.monitor.every} · PASS ${snap.monitor.passes}`, tone: "cyan", detail: `This server owns the monitor cadence: a pass every ${snap.monitor.every}. ${snap.monitor.passes} pass(es) so far${snap.monitor.running ? " (running now)" : ""}.` });
    }
    return out;
  };

  const syncChip = el("button", "chip muted sync") as HTMLButtonElement;

  return {
    el: root,
    update(snap) {
      caseName.textContent = `CASE ▸ ${snap.caseName}`;
      caseName.title = snap.caseDir;
      generatedAt = snap.generatedAt;
      const built = build(snap);
      const nodes = built.map((c) => {
        const b = el("button", `chip${c.tone ? ` ${c.tone}` : ""}`) as HTMLButtonElement;
        b.textContent = c.text;
        if (c.color) b.style.color = c.color;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          openPop(b, c.detail);
        });
        return b;
      });
      // sync chip: age + poll interval, tappable for detail
      syncChip.textContent = `SYNC ${fmtAge(ageOf(generatedAt))} · every ${snap.pollSeconds}s`;
      syncChip.onclick = (e) => {
        e.stopPropagation();
        openPop(syncChip, `Snapshot generated ${generatedAt ? new Date(generatedAt).toLocaleString() : "—"} (${fmtAge(ageOf(generatedAt))} ago). The server re-checks the case store every ${snap.pollSeconds}s; ⟳ forces a sync to now.`);
      };
      nodes.push(syncChip);
      chips.replaceChildren(...nodes);
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
      syncBtn.style.display = "none";
      chips.replaceChildren(el("span", "offair", `■ OFF AIR — ${reason}`));
    },
    syncing(on) {
      syncBtn.classList.toggle("spin", on);
    },
  };
}
