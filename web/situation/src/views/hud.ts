// HUD strip: case identity + pulse chips (findings/triage/scan/monitor/brief
// freshness — the same signals the wall HUD and `case status` derive) + a live
// clock and a liveness/sync control. Chips are TAPPABLE — each opens a popover
// with a glance of detail. The SYNC control shows connection liveness (◉ LIVE
// while the stream is up, ⚠ + a climbing age when it drops) with the data
// refresh + control cadences and last-data age in its popover, plus a ⟳ button
// that forces a sync to now.

import type { SituationSnapshot, SituationWireEvent } from "../../../../src/situation/wire.js";
import { sourceStyle } from "../sources.js";
import { ageOf, el, fmtAge } from "../util.js";

export interface HudView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
  setConnected(connected: boolean): void;
  /** note a fresh contact with the server (event/heartbeat) — resets the age */
  markSynced(): void;
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
  const syncChip = el("button", "chip sync") as HTMLButtonElement;
  const syncBtn = el("button", "syncbtn", "⟳");
  syncBtn.title = "sync to now";
  syncBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onSyncNow();
  });
  const clock = el("span", "clock");
  right.append(passChip, syncChip, syncBtn, clock);
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

  // liveness state
  let connected = false;
  let lastContact = Date.now();
  let pollSeconds = 60;
  let generatedAt: string | null = null;

  const renderSync = (): void => {
    if (connected) {
      syncChip.textContent = "◉ LIVE";
      syncChip.className = "chip sync live";
    } else {
      syncChip.textContent = `⚠ ${fmtAge((Date.now() - lastContact) / 1000)}`;
      syncChip.className = "chip sync down";
    }
  };
  syncChip.addEventListener("click", (e) => {
    e.stopPropagation();
    const dataAge = fmtAge(ageOf(generatedAt));
    openPop(
      syncChip,
      connected
        ? `Live — the stream is connected. Data refreshes every ${pollSeconds}s (⟳ to sync now); control (set/stop) applies within ~2s. Newest data ${dataAge} old.`
        : `Reconnecting — no contact for ${fmtAge((Date.now() - lastContact) / 1000)}. The console will resync automatically; ⟳ to retry. Newest data ${dataAge} old.`,
    );
  });

  const tick = (): void => {
    clock.textContent = new Date().toLocaleTimeString();
    if (!connected) renderSync(); // climb the age while offline
  };
  tick();
  setInterval(tick, 1000);
  renderSync();

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

  return {
    el: root,
    update(snap) {
      caseName.textContent = `CASE ▸ ${snap.caseName}`;
      caseName.title = snap.caseDir;
      generatedAt = snap.generatedAt;
      pollSeconds = snap.pollSeconds;
      lastContact = Date.now(); // a snapshot IS a sync
      renderSync();
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
      chips.replaceChildren(...nodes);
    },
    setConnected(c) {
      connected = c;
      if (c) lastContact = Date.now();
      renderSync();
    },
    markSynced() {
      lastContact = Date.now();
      if (connected) return; // "◉ LIVE" already; nothing to reflow
      renderSync();
    },
    monitorPulse(evt) {
      lastContact = Date.now();
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
      connected = false;
      passChip.style.display = "none";
      syncBtn.style.display = "none";
      syncChip.textContent = "■ OFF AIR";
      syncChip.className = "chip sync down";
      chips.replaceChildren(el("span", "offair", `■ OFF AIR — ${reason}`));
    },
    syncing(on) {
      syncBtn.classList.toggle("spin", on);
    },
  };
}
