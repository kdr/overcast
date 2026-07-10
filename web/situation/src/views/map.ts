// Live map panel — the runtime twin of report/map.ts's inline slippy renderer
// (hand-rolled OSM raster tiles, no Leaflet/CDN): pan/drag/wheel-zoom, numbered
// markers, fit-to-bounds on first data, plus track polylines (points sharing a
// `track` key — flights icao24 — drawn oldest→newest as monitor passes land).
// Tiles are fetched by the viewer's browser at view time, matching the map
// verb's online mode.

import type { SituationPoint, SituationSnapshot } from "../../../../src/situation/wire.js";
import { el } from "../util.js";

export interface MapView {
  el: HTMLElement;
  update(snap: SituationSnapshot): void;
}

interface Bounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export function createMap(): MapView {
  const root = el("section", "panel panel-map");
  const header = el("header");
  header.append(el("span", "", "◉ MAP"), el("span", "sub"));
  const wrap = el("div", "mapwrap");
  const tiles = el("div", "tiles");
  const markers = el("div", "markers");
  const tracks = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  tracks.setAttribute("class", "tracks");
  const ctl = el("div", "mapctl");
  const zin = el("button", "", "+");
  const zout = el("button", "", "−");
  ctl.append(zin, zout);
  const attrib = el("div", "attrib", "© OpenStreetMap contributors");
  const info = el("div", "mapinfo");
  info.append(el("div", "t"), el("div", "d"));
  wrap.append(tiles, tracks, markers, ctl, attrib, info);
  const empty = el("div", "empty", "NO LOCATED RECORDS — gps-bearing hits plot here");
  root.append(header, wrap, empty);

  let points: SituationPoint[] = [];
  let bounds: Bounds | null = null;
  let zoom = 14;
  let center = { lat: 0, lng: 0 };
  let fitted = false;
  let activeId: string | null = null;
  let panning: { x: number; y: number } | null = null;

  const lon2t = (lon: number, z: number): number => ((lon + 180) / 360) * Math.pow(2, z);
  const lat2t = (lat: number, z: number): number => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  };
  // unwrap a point longitude into the (possibly antimeridian-shifted) bounds frame
  const unwrap = (lng: number): number => (bounds && lng < bounds.minLng ? lng + 360 : lng);

  function fit(): void {
    if (!bounds || points.length < 2) {
      if (points.length === 1) center = { lat: points[0].lat, lng: points[0].lng };
      return;
    }
    center = { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 };
    const w = wrap.clientWidth || 600;
    const h = wrap.clientHeight || 400;
    for (let z = 18; z >= 1; z--) {
      const dx = (lon2t(bounds.maxLng, z) - lon2t(bounds.minLng, z)) * 256;
      const dy = (lat2t(bounds.minLat, z) - lat2t(bounds.maxLat, z)) * 256;
      if (dx <= w * 0.85 && dy <= h * 0.85) {
        zoom = z;
        return;
      }
    }
    zoom = 1;
  }

  function px(p: { lat: number; lng: number }, ox: number, oy: number): { x: number; y: number } {
    return { x: lon2t(unwrap(p.lng), zoom) * 256 - ox, y: lat2t(p.lat, zoom) * 256 - oy };
  }

  function render(): void {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return;
    const cx = lon2t(center.lng, zoom) * 256;
    const cy = lat2t(center.lat, zoom) * 256;
    const ox = cx - w / 2;
    const oy = cy - h / 2;
    const n = Math.pow(2, zoom);
    // tiles
    const imgs: HTMLImageElement[] = [];
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + w) / 256); tx++) {
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + h) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const s = ["a", "b", "c"][Math.abs(tx + ty) % 3];
        const img = document.createElement("img");
        img.src = `https://${s}.tile.openstreetmap.org/${zoom}/${wx}/${ty}.png`;
        img.style.left = `${tx * 256 - ox}px`;
        img.style.top = `${ty * 256 - oy}px`;
        img.addEventListener("error", () => (img.style.visibility = "hidden"));
        imgs.push(img);
      }
    }
    tiles.replaceChildren(...imgs);
    // tracks (oldest→newest per key)
    tracks.setAttribute("viewBox", `0 0 ${w} ${h}`);
    tracks.setAttribute("width", String(w));
    tracks.setAttribute("height", String(h));
    const byTrack = new Map<string, SituationPoint[]>();
    for (const p of points) {
      if (!p.track) continue;
      const arr = byTrack.get(p.track) ?? [];
      arr.push(p);
      byTrack.set(p.track, arr);
    }
    const lines: SVGPolylineElement[] = [];
    for (const arr of byTrack.values()) {
      if (arr.length < 2) continue;
      const sorted = [...arr].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", sorted.map((p) => { const c = px(p, ox, oy); return `${c.x},${c.y}`; }).join(" "));
      lines.push(line);
    }
    tracks.replaceChildren(...lines);
    // markers
    const mks = points.map((p, i) => {
      const c = px(p, ox, oy);
      const b = el("button", `mk${p.recordId === activeId ? " active" : ""}`);
      b.style.left = `${c.x}px`;
      b.style.top = `${c.y}px`;
      b.dataset.i = String(i);
      b.title = p.place ?? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      b.append(el("span", "", String(i + 1)));
      return b;
    });
    markers.replaceChildren(...mks);
  }

  function focusPoint(i: number): void {
    const p = points[i];
    if (!p) return;
    activeId = p.recordId;
    center = { lat: p.lat, lng: unwrap(p.lng) };
    if (zoom < 12) zoom = 12;
    (info.querySelector(".t") as HTMLElement).textContent =
      `${p.verb.toUpperCase()} · ${p.place ?? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`}${p.time ? ` · ${p.time}` : ""}`;
    (info.querySelector(".d") as HTMLElement).textContent = p.summary;
    info.classList.add("on");
    render();
  }

  markers.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest(".mk") as HTMLElement | null;
    if (b?.dataset.i) focusPoint(Number(b.dataset.i));
  });
  wrap.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".mk") || (e.target as HTMLElement).closest(".mapctl")) return;
    panning = { x: e.clientX, y: e.clientY };
    wrap.classList.add("drag");
    info.classList.remove("on");
  });
  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    const dx = e.clientX - panning.x;
    const dy = e.clientY - panning.y;
    const n = Math.pow(2, zoom);
    center.lng += (-dx / 256 / n) * 360;
    center.lat += (dy / 256 / n) * 360 * Math.cos((center.lat * Math.PI) / 180);
    panning = { x: e.clientX, y: e.clientY };
    render();
  });
  window.addEventListener("mouseup", () => {
    panning = null;
    wrap.classList.remove("drag");
  });
  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.deltaY < 0 && zoom < 19) zoom++;
      else if (e.deltaY > 0 && zoom > 1) zoom--;
      render();
    },
    { passive: false },
  );
  zin.addEventListener("click", () => {
    if (zoom < 19) {
      zoom++;
      render();
    }
  });
  zout.addEventListener("click", () => {
    if (zoom > 1) {
      zoom--;
      render();
    }
  });
  window.addEventListener("resize", render);

  return {
    el: root,
    update(snap) {
      const active = snap.panels.includes("map");
      root.style.display = active ? "" : "none";
      if (!active) return;
      points = snap.points;
      bounds = snap.bounds;
      (header.querySelector(".sub") as HTMLElement).textContent = `${points.length} located`;
      empty.style.display = points.length ? "none" : "";
      wrap.style.display = points.length ? "" : "none";
      if (!fitted && points.length) {
        fit();
        fitted = true;
      }
      render();
    },
  };
}
