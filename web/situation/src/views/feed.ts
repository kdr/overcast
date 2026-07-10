// Feed panel: reverse-chron scan/monitor hits — "latest results / latest posts
// on the topic". Rebuilt wholesale per refresh (no media state to preserve);
// records unseen on the previous render get a landing flash.

import type { SituationSnapshot } from "../../../../src/situation/wire.js";
import { mediaSrc } from "../api.js";
import { ageOf, el, fmtAge } from "../util.js";

export interface FeedView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
}

export function createFeed(): FeedView {
  const root = el("section", "panel panel-feed");
  const header = el("header");
  header.append(el("span", "", "◉ FEED"), el("span", "sub"));
  const list = el("ul", "feedlist");
  const empty = el("div", "empty", "NO HITS YET — scan/monitor feeds this panel");
  root.append(header, list, empty);

  let known = new Set<string>();
  let first = true;

  return {
    el: root,
    update(snap) {
      const active = snap.panels.includes("feed");
      root.style.display = active ? "" : "none";
      if (!active) return;
      const items = snap.feed;
      (header.querySelector(".sub") as HTMLElement).textContent = `${items.length} hits`;
      empty.style.display = items.length ? "none" : "";

      const nextKnown = new Set<string>();
      const rows = items.map((item) => {
        nextKnown.add(item.recordId);
        const li = el("li");
        if (!first && !known.has(item.recordId)) li.classList.add("new");
        if (item.state === "error") li.classList.add("err");
        if (item.state === "needs_credentials") li.classList.add("cred");

        const head = el("div", "head");
        head.append(el("span", "src", item.source ?? "scan"));
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
        if (item.author) body.append(el("div", "author", item.author));
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
    },
  };
}
