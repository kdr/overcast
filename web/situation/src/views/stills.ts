// Stills panel: the freshest frame per recapture source (webcam / browser /
// screenshot). Cells are keyed by the source ref so a new capture swaps the
// image in place — a bank of "current view" monitors that tick over on each
// monitor pass.

import type { SituationSnapshot } from "../../../../src/situation/wire.js";
import { mediaSrc } from "../api.js";
import { ageOf, el, fmtAge } from "../util.js";

export interface StillsView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
}

interface Cell {
  root: HTMLElement;
  img: HTMLImageElement;
  src: string | null;
}

export function createStills(): StillsView {
  const root = el("section", "panel panel-stills");
  const header = el("header");
  header.append(el("span", "", "◉ STILLS"), el("span", "sub"));
  const grid = el("div", "stillgrid");
  const empty = el("div", "empty", "NO LIVE STILLS — webcam/browser sources feed this panel");
  root.append(header, grid, empty);

  const cells = new Map<string, Cell>();

  return {
    el: root,
    update(snap) {
      const active = snap.panels.includes("stills");
      root.style.display = active ? "" : "none";
      if (!active) return;
      const stills = snap.stills;
      (header.querySelector(".sub") as HTMLElement).textContent = `${stills.length} live`;
      empty.style.display = stills.length ? "none" : "";

      const seen = new Set<string>();
      for (const still of stills) {
        seen.add(still.key);
        const src = mediaSrc(still.mediaUrl);
        let cell = cells.get(still.key);
        if (!cell) {
          const cellRoot = el("div", "stillcell");
          const img = el("img");
          img.alt = still.title;
          const label = el("div", "label");
          label.append(el("span", "s"), el("span", "t"), el("span", "a"));
          cellRoot.append(img, label);
          cell = { root: cellRoot, img, src: null };
          cells.set(still.key, cell);
        }
        if (src && cell.src !== src) {
          cell.src = src;
          cell.img.src = src;
          cell.root.classList.add("new");
          setTimeout(() => cell!.root.classList.remove("new"), 2500);
        }
        (cell.root.querySelector(".s") as HTMLElement).textContent = still.source ?? "";
        (cell.root.querySelector(".t") as HTMLElement).textContent = still.title;
        (cell.root.querySelector(".a") as HTMLElement).textContent = still.time ? fmtAge(ageOf(still.time)) : "";
      }
      for (const [key, cell] of [...cells]) {
        if (!seen.has(key)) {
          cell.root.remove();
          cells.delete(key);
        }
      }
      grid.replaceChildren(...stills.map((s) => cells.get(s.key)!.root));
    },
  };
}
