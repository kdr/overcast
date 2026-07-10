// Situation console boot: pair (token from the URL fragment), fetch the full
// snapshot, render the panels, then follow the SSE stream. The wire is
// snapshot-shaped by design — a `refresh` event just refetches /api/state and
// each panel diffs by record id, so there is no incremental state machine to
// drift. Any panel can go fullscreen (⤢ / Esc). Auth failure (token rotated /
// server restarted) tears down to the pairing gate; anything else retries.

import "./theme.css";
import type { SituationPanel, SituationSnapshot, SituationWireEvent } from "../../../src/situation/wire.js";
import { clearToken, forceSync, getState, pairToken } from "./api.js";
import { connectStream } from "./stream.js";
import { createHud } from "./views/hud.js";
import { createWall } from "./views/wall.js";
import { createFeed } from "./views/feed.js";
import { createMap } from "./views/map.js";
import { createStills } from "./views/stills.js";
import { el } from "./util.js";

const RETRY_MS = 8000;
const ERROR_RESYNC_MS = 3000;

const app = document.getElementById("app")!;

function gate(message: string): void {
  app.innerHTML = `<div class="gate"><div class="mark">◉ SITUATION</div><p>${message}</p></div>`;
}

async function boot(): Promise<void> {
  if (!pairToken()) {
    gate(
      "not paired — open the pairing link from <code>overcast situation</code> (or scan its QR / <code>/situation qr</code> in the TUI). The token rides in the URL fragment.",
    );
    return;
  }

  const hud = createHud(() => void syncNow());
  const wall = createWall();
  const feed = createFeed();
  const map = createMap();
  const stills = createStills();
  const panels = { wall, feed, map, stills } as const;
  const main = document.createElement("main");
  main.className = "panels";
  app.replaceChildren(hud.el, main);

  // --- fullscreen: any panel can fill the viewport (⤢ button / Esc) ----------
  let fsKey: SituationPanel | null = null;
  const fsBtns: Partial<Record<SituationPanel, HTMLButtonElement>> = {};
  const setFullscreen = (key: SituationPanel | null): void => {
    fsKey = key;
    main.classList.toggle("has-fs", !!key);
    for (const k of Object.keys(panels) as SituationPanel[]) {
      panels[k].el.classList.toggle("fs", k === key);
      const btn = fsBtns[k];
      if (btn) {
        btn.textContent = k === key ? "⤡" : "⤢";
        btn.title = k === key ? "exit fullscreen (Esc)" : "fullscreen";
      }
    }
    // let panels react (wall enables video controls; the map re-renders at size)
    window.dispatchEvent(new CustomEvent("situation-fs", { detail: { key: fsKey } }));
    window.dispatchEvent(new Event("resize"));
  };
  for (const k of Object.keys(panels) as SituationPanel[]) {
    const hdr = panels[k].el.querySelector("header");
    if (!hdr) continue;
    const btn = el("button", "fsbtn", "⤢");
    btn.title = "fullscreen";
    btn.addEventListener("click", () => setFullscreen(fsKey === k ? null : k));
    hdr.append(btn);
    fsBtns[k] = btn;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && fsKey) setFullscreen(null);
  });

  let gated = false;
  let offAir = false;
  let lastSeq = 0;
  let panelOrder = "";
  let disconnect: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshToken = 0;

  const isAuthError = (e: unknown): boolean => (e as Error)?.message === "unauthorized";
  const teardown = (): void => {
    gated = true;
    disconnect?.();
    disconnect = undefined;
    if (retryTimer) clearTimeout(retryTimer);
    if (errorTimer) clearTimeout(errorTimer);
    retryTimer = errorTimer = undefined;
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* history API unavailable */
    }
  };
  const onAuthFailure = (): void => {
    teardown();
    clearToken();
    gate("unauthorized — the pairing token was rotated. Re-open the pairing link from the desk.");
  };

  const render = (snap: SituationSnapshot): void => {
    document.body.dataset.theme = snap.config.theme;
    document.title = `situation — ${snap.caseName}`;
    hud.update(snap);
    // if the fullscreen'd panel dropped out of the active set, exit fullscreen
    if (fsKey && !snap.panels.includes(fsKey)) setFullscreen(null);
    // (re)order the panel sections only when the active set changed — moving a
    // node with playing <video>s pauses them.
    const order = snap.panels.join(",");
    if (order !== panelOrder) {
      panelOrder = order;
      main.replaceChildren(...snap.panels.map((p) => panels[p].el));
    }
    wall.update(snap);
    feed.update(snap);
    map.update(snap);
    stills.update(snap);
  };

  // "sync to now": force the server to rebuild from the current store and render
  // the fresh snapshot immediately (don't wait for the ≤pollSeconds tick).
  async function syncNow(): Promise<void> {
    if (gated || offAir) return;
    hud.syncing(true);
    try {
      const snap = await forceSync();
      render(snap);
      lastSeq = snap.seq;
    } catch (e) {
      if (isAuthError(e)) onAuthFailure();
    } finally {
      hud.syncing(false);
    }
  }

  /** Refetch + render the snapshot. Pass reopen to also (re)connect the stream. */
  const refresh = async (reopen: boolean): Promise<void> => {
    if (gated || offAir) return;
    const token = ++refreshToken;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    try {
      const snap = await getState();
      if (token !== refreshToken || gated || offAir) return;
      render(snap);
      lastSeq = snap.seq;
      if (reopen) openStream(snap.seq);
    } catch (e) {
      if (token !== refreshToken || gated) return;
      if (isAuthError(e)) return onAuthFailure();
      hud.setConnected(false);
      retryTimer = setTimeout(() => void refresh(true), RETRY_MS);
    }
  };

  const onEvent = (evt: SituationWireEvent): void => {
    if (evt.type === "hello") {
      lastSeq = evt.seq;
      return;
    }
    if (evt.seq <= lastSeq) return; // replay dedupe belt
    lastSeq = evt.seq;
    switch (evt.type) {
      case "refresh":
        void refresh(false);
        break;
      case "monitor":
        hud.monitorPulse(evt);
        break;
      case "stopping":
        offAir = true;
        disconnect?.();
        disconnect = undefined;
        hud.setOffAir(evt.reason);
        break;
      case "notice":
      default:
        break;
    }
  };

  const openStream = (since?: number): void => {
    disconnect?.();
    disconnect = connectStream(
      {
        onEvent,
        onResync: () => void refresh(true),
        onStatus: (connected) => {
          if (offAir) return;
          hud.setConnected(connected);
          if (connected) {
            if (errorTimer) clearTimeout(errorTimer);
            errorTimer = undefined;
            void refresh(false); // catch anything missed while down
          } else if (!errorTimer) {
            errorTimer = setTimeout(() => {
              errorTimer = undefined;
              void refresh(true);
            }, ERROR_RESYNC_MS);
          }
        },
      },
      since,
    );
  };

  document.addEventListener("visibilitychange", () => {
    if (!gated && !offAir && document.visibilityState === "visible") void refresh(true);
  });

  await refresh(true);
}

void boot();
