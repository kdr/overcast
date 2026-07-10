// The live wall panel — the runtime twin of report/wall.ts's WALL_JS: muted
// tiles looping their evidence window, IntersectionObserver play/pause,
// staggered src attach, NO SIGNAL/REMOTE OFF covers, hover intel. DOM is keyed
// by tile ref so a store refresh only touches tiles that actually changed —
// playing loops must not restart because a feed card landed.

import type { SituationSnapshot, SituationTile } from "../../../../src/situation/wire.js";
import { mediaSrc } from "../api.js";
import { sourceStyle, formatAuthor } from "../sources.js";
import { el, fmtAge, fmtTime } from "../util.js";

interface Cell {
  fig: HTMLElement;
  video: HTMLVideoElement | null;
  /** identity of the wired media (src+window) — a change forces a rebuild */
  sig: string;
}

export interface WallView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
}

const LIVE_LABEL: Record<SituationTile["mode"], string> = { video: "● LIVE", still: "● STILL", down: "● DOWN" };

export function createWall(): WallView {
  const root = el("section", "panel panel-wall");
  const header = el("header");
  header.append(el("span", "", "◉ WALL"), el("span", "sub"));
  const grid = el("div", "wallgrid");
  const empty = el("div", "empty", "NO FEEDS — capture/watch media to light the wall");
  const startBtn = el("button", "startbtn", "▶ CLICK TO START FEEDS");
  root.append(header, grid, empty, startBtn);

  const cells = new Map<string, Cell>();
  const io =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const v = e.target.querySelector("video");
              if (!v || !v.src) continue;
              if (e.intersectionRatio >= 0.25) {
                if (!document.body.classList.contains("stalled")) v.play().catch(() => {});
              } else v.pause();
            }
          },
          { threshold: [0, 0.25] },
        )
      : null;

  startBtn.addEventListener("click", () => {
    document.body.classList.remove("stalled");
    for (const cell of cells.values()) if (cell.video?.src) cell.video.play().catch(() => {});
  });

  // when the wall is fullscreen, enable native video controls so the operator
  // can scrub/see the whole clip; off otherwise (the wall is an ambient loop).
  window.addEventListener("situation-fs", (e) => {
    const fs = (e as CustomEvent<{ key: string | null }>).detail?.key === "wall";
    for (const cell of cells.values()) if (cell.video) cell.video.controls = fs;
  });

  function sigOf(t: SituationTile): string {
    return JSON.stringify([t.mediaUrl, t.posterUrl, t.mode, t.anchor.start, t.anchor.end]);
  }

  function teardown(ref: string, cell: Cell): void {
    if (cell.video) {
      cell.video.pause();
      cell.video.removeAttribute("src");
      try {
        cell.video.load();
      } catch {
        /* already detached */
      }
    }
    io?.unobserve(cell.fig);
    cell.fig.remove();
    cells.delete(ref);
  }

  function wireVideo(v: HTMLVideoElement, tile: SituationTile, fig: HTMLElement, delayMs: number): void {
    let start = tile.anchor.start;
    let end = tile.anchor.end;
    v.addEventListener("loadedmetadata", () => {
      // clamp the window to the REAL duration (the model's is advisory)
      if (isFinite(v.duration) && v.duration > 0) {
        end = Math.min(end, v.duration);
        if (end <= start) {
          start = 0;
          end = Math.min(8, v.duration);
        }
      }
      if (end > start) {
        v.addEventListener("timeupdate", () => {
          if (v.currentTime >= end || v.currentTime < start - 0.75) v.currentTime = start;
        });
        v.addEventListener("ended", () => {
          v.currentTime = start;
          v.play().catch(() => {});
        });
      }
      try {
        v.currentTime = start;
      } catch {
        /* not seekable yet */
      }
    });
    v.addEventListener("error", () => fig.classList.add("err"));
    // staggered attach avoids a simultaneous decode burst; only a real autoplay
    // block (NotAllowedError) shows the START button.
    setTimeout(() => {
      const src = v.getAttribute("data-src");
      if (!src) return;
      v.src = src;
      v.play().catch((err: unknown) => {
        if ((err as Error | undefined)?.name === "NotAllowedError") document.body.classList.add("stalled");
      });
    }, delayMs);
  }

  function buildTile(tile: SituationTile, index: number): Cell {
    const fig = el("figure", `tile ${tile.mode}`);
    fig.dataset.ref = tile.ref;

    let video: HTMLVideoElement | null = null;
    const src = mediaSrc(tile.mediaUrl);
    const posterSrc = mediaSrc(tile.posterUrl);
    if (tile.mode === "video" && src) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.loop = true;
      video.preload = "metadata";
      video.setAttribute("data-src", src);
      fig.append(video);
      const cover = el("div", "cover errcover");
      cover.append(el("span", "nosig-label", "NO SIGNAL"));
      fig.append(cover);
      wireVideo(video, tile, fig, index * 150);
    } else if (tile.mode !== "down" && !src) {
      // present media the desk chose not to serve (remote, embeds off)
      fig.append(el("div", "static"));
      const cover = el("div", "cover");
      cover.append(el("span", "nosig-label", "REMOTE OFF"));
      fig.append(cover);
    } else if (tile.mode === "still") {
      if (posterSrc) {
        const img = el("img", "poster");
        img.alt = tile.title;
        img.src = posterSrc;
        fig.append(img);
      } else {
        fig.append(el("div", "static"));
      }
      const cover = el("div", "cover");
      cover.append(el("span", "nosig-label", "STILL"));
      fig.append(cover);
    } else {
      fig.append(el("div", "static"));
      const cover = el("div", "cover");
      cover.append(el("span", "nosig-label", "NO SIGNAL"));
      fig.append(cover);
    }

    const top = el("div", "tile-top");
    top.append(el("span", "cam"), el("span", "at"), el("span", "live"));
    fig.append(top);

    const lower = el("figcaption", "lower");
    lower.append(el("span", "title"), el("span", "badges"), el("span", "faces"), el("span", "find"), el("span", "age"));
    fig.append(lower);

    const intel = el("div", "intel");
    intel.append(el("p", "sum"), el("div", "kv ref"), el("div", "kv anchor"), el("div", "kv source"), el("code"));
    fig.append(intel);

    // click-to-source badge (bottom-left): source emoji + @author + "↗". A real
    // <a> so it works over the video controls and opens the tweet/video page.
    const badge = el("a", "srcbadge");
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
    badge.style.display = "none";
    fig.append(badge);

    const cell: Cell = { fig, video, sig: sigOf(tile) };
    updateLabels(cell, tile, index);
    io?.observe(fig);
    return cell;
  }

  function updateLabels(cell: Cell, tile: SituationTile, index: number): void {
    const q = <T extends Element>(sel: string): T => cell.fig.querySelector(sel) as T;
    q<HTMLElement>(".cam").textContent = `CAM ${String(index + 1).padStart(2, "0")}`;
    q<HTMLElement>(".at").textContent = `@ ${fmtTime(tile.anchor.at)}`;
    q<HTMLElement>(".live").textContent = LIVE_LABEL[tile.mode];
    q<HTMLElement>(".lower .title").textContent = tile.title;
    const badges = q<HTMLElement>(".badges");
    badges.replaceChildren(
      ...(["watch", "listen", "see", "face"] as const).map((k) => {
        const b = document.createElement("b");
        b.className = tile.coverage[k] ? "on" : "";
        b.title = k;
        b.textContent = k[0].toUpperCase();
        return b;
      }),
    );
    q<HTMLElement>(".faces").textContent = tile.faceCount ? `FACES ${tile.faceCount}` : "";
    q<HTMLElement>(".find").textContent = tile.openFindings ? `FND ${tile.openFindings}` : "";
    q<HTMLElement>(".age").textContent = fmtAge(tile.ageSeconds);
    q<HTMLElement>(".intel .sum").textContent = tile.summary;
    q<HTMLElement>(".intel .ref").textContent = `ref ${tile.ref}`;
    q<HTMLElement>(".intel .anchor").textContent =
      `anchor ${tile.anchor.source} @ ${fmtTime(tile.anchor.at)} · loop ${fmtTime(tile.anchor.start)}–${fmtTime(tile.anchor.end)}${tile.duration ? ` · dur ${fmtTime(tile.duration)}` : ""}`;
    q<HTMLElement>(".intel .source").textContent = tile.sourceType ? `source ${tile.sourceType}` : "";
    q<HTMLElement>(".intel code").textContent = `overcast view ${tile.ref} --at ${tile.anchor.span ? `${tile.anchor.start}-${tile.anchor.end}` : Math.round(tile.anchor.at)}`;
    // source badge (click-to-source)
    const badge = q<HTMLAnchorElement>(".srcbadge");
    if (tile.sourceUrl) {
      const st = sourceStyle(tile.sourceType);
      const who = formatAuthor(tile.sourceType, tile.sourceAuthor);
      badge.href = tile.sourceUrl;
      badge.style.display = "";
      badge.style.color = st.color;
      badge.textContent = `${st.emoji} ${who ?? st.label} ↗`;
      badge.title = `open source — ${tile.sourceUrl}`;
    } else {
      badge.style.display = "none";
      badge.removeAttribute("href");
    }
  }

  return {
    el: root,
    update(snap) {
      const active = snap.panels.includes("wall");
      root.style.display = active ? "" : "none";
      if (!active) return;
      const tiles = snap.tiles;
      (header.querySelector(".sub") as HTMLElement).textContent = `${snap.hud.tilesShown}/${snap.hud.totalVideos} feeds`;
      empty.style.display = tiles.length ? "none" : "";

      const seen = new Set<string>();
      let orderChanged = false;
      tiles.forEach((tile, i) => {
        seen.add(tile.ref);
        const existing = cells.get(tile.ref);
        const sig = sigOf(tile);
        if (existing && existing.sig === sig) {
          updateLabels(existing, tile, i);
          return;
        }
        if (existing) teardown(tile.ref, existing);
        cells.set(tile.ref, buildTile(tile, i));
        orderChanged = true;
      });
      for (const [ref, cell] of [...cells]) if (!seen.has(ref)) { teardown(ref, cell); orderChanged = true; }

      // detect a pure reorder (rank shifts without media changes)
      const domOrder = [...grid.children].map((c) => (c as HTMLElement).dataset.ref);
      const wantOrder = tiles.map((t) => t.ref);
      if (!orderChanged && domOrder.join(" ") !== wantOrder.join(" ")) orderChanged = true;

      if (orderChanged) {
        // moving a <video> in the DOM pauses it — reorder, then nudge the
        // visible loops back to play (the observer handles offscreen ones).
        grid.replaceChildren(...tiles.map((t) => cells.get(t.ref)!.fig));
        if (!document.body.classList.contains("stalled")) {
          for (const cell of cells.values()) if (cell.video?.src && cell.video.paused) cell.video.play().catch(() => {});
        }
      }
      const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(tiles.length || 1))));
      grid.style.setProperty("--cols", String(cols));
    },
  };
}
