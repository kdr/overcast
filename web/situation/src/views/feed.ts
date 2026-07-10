// Feed panel: reverse-chron scan/monitor hits — "latest results / latest posts
// on the topic". A filter bar (one chip per source type present, colored) narrows
// the list; each card is colour-coded by source with an emoji + @handle. Records
// unseen on the previous render get a landing flash.

import type { SituationSnapshot } from "../../../../src/situation/wire.js";
import { mediaSrc } from "../api.js";
import { sourceStyle, formatAuthor } from "../sources.js";
import { ageOf, el, fmtAge } from "../util.js";

export interface FeedView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
}

export function createFeed(): FeedView {
  const root = el("section", "panel panel-feed");
  const header = el("header");
  header.append(el("span", "", "◉ FEED"), el("span", "sub"));
  const filterbar = el("div", "filterbar");
  const list = el("ul", "feedlist");
  const empty = el("div", "empty", "NO HITS YET — scan/monitor feeds this panel");
  root.append(header, filterbar, list, empty);

  let known = new Set<string>();
  let first = true;
  // types the user has toggled OFF (default = everything on). Kept across refreshes.
  const hidden = new Set<string>();

  const renderFilters = (types: string[], render: () => void): void => {
    filterbar.replaceChildren(
      ...types.map((type) => {
        const st = sourceStyle(type);
        const on = !hidden.has(type);
        const chip = el("button", `fchip${on ? " on" : ""}`);
        chip.style.setProperty("--c", st.color);
        chip.textContent = `${st.emoji} ${st.label}`;
        chip.title = on ? `hide ${st.label}` : `show ${st.label}`;
        chip.addEventListener("click", () => {
          if (hidden.has(type)) hidden.delete(type);
          else hidden.add(type);
          render();
        });
        return chip;
      }),
    );
  };

  return {
    el: root,
    update(snap) {
      const active = snap.panels.includes("feed");
      root.style.display = active ? "" : "none";
      if (!active) return;
      const items = snap.feed;

      const render = (): void => {
        const types = [...new Set(items.map((i) => (i.source ?? "scan").toLowerCase()))];
        // drop stale hidden entries for types no longer present
        for (const h of [...hidden]) if (!types.includes(h)) hidden.delete(h);
        renderFilters(types, render);

        const shown = items.filter((i) => !hidden.has((i.source ?? "scan").toLowerCase()));
        (header.querySelector(".sub") as HTMLElement).textContent = `${shown.length}${shown.length !== items.length ? `/${items.length}` : ""} hits`;
        empty.style.display = shown.length ? "none" : "";

        const nextKnown = new Set<string>();
        const rows = shown.map((item) => {
          nextKnown.add(item.recordId);
          const st = sourceStyle(item.source);
          const li = el("li");
          li.style.setProperty("--c", st.color);
          if (!first && !known.has(item.recordId)) li.classList.add("new");
          if (item.state === "error") li.classList.add("err");
          if (item.state === "needs_credentials") li.classList.add("cred");

          const head = el("div", "head");
          const src = el("span", "src", `${st.emoji} ${st.label}`);
          src.style.color = st.color;
          head.append(src);
          const who = formatAuthor(item.source, item.author);
          if (who) {
            const a = el("span", "who", who);
            head.append(a);
          }
          const when = item.published ?? item.time;
          head.append(el("span", "when", when ? `${fmtAge(ageOf(when))} ago` : ""));
          li.append(head);

          const row = el("div", "thumbrow");
          const body = el("div");
          body.style.minWidth = "0";
          if (item.url) {
            const a = el("a", "title", item.title);
            a.setAttribute("href", item.url);
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener noreferrer");
            body.append(a);
          } else {
            body.append(el("span", "title", item.title));
          }
          if (item.error) body.append(el("div", "snippet", item.error));
          else if (item.snippet) body.append(el("div", "snippet", item.snippet));
          row.append(body);
          const thumb = mediaSrc(item.thumbUrl);
          if (thumb) {
            const img = el("img", "thumb");
            img.loading = "lazy";
            img.src = thumb;
            img.alt = "";
            img.addEventListener("error", () => img.remove());
            row.append(img);
          }
          li.append(row);
          return li;
        });
        list.replaceChildren(...rows);
        known = nextKnown;
        first = false;
      };

      render();
    },
  };
}
