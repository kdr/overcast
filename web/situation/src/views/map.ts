// Live map panel — the runtime twin of report/map.ts's inline slippy renderer
// (hand-rolled OSM raster tiles, no Leaflet/CDN): pan/drag/wheel-zoom, fit-to-
// bounds. Markers are colour-coded + emoji'd by source type (a legend + a filter
// bar match the feed). Aircraft render as a plane glyph rotated to their ADS-B
// heading; points sharing a track (same icao24 across monitor passes) are joined
// by a trajectory polyline with historical positions as breadcrumb dots.

import type { SituationPoint, SituationSnapshot } from "../../../../src/situation/wire.js";
import { sourceStyle } from "../sources.js";
import { el, fmtAge, ageOf } from "../util.js";

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

const SVGNS = "http://www.w3.org/2000/svg";

export function createMap(): MapView {
  const root = el("section", "panel panel-map");
  const header = el("header");
  header.append(el("span", "", "◉ MAP"), el("span", "sub"));
  const filterbar = el("div", "filterbar");
  const wrap = el("div", "mapwrap");
  const tiles = el("div", "tiles");
  const markers = el("div", "markers");
  const tracks = document.createElementNS(SVGNS, "svg");
  tracks.setAttribute("class", "tracks");
  const ctl = el("div", "mapctl");
  const zin = el("button", "", "+");
  const zout = el("button", "", "−");
  ctl.append(zin, zout);
  const attrib = el("div", "attrib", "© OpenStreetMap contributors");
  const legend = el("div", "legend");
  const info = el("div", "mapinfo");
  wrap.append(tiles, tracks, markers, ctl, attrib, legend, info);
  const empty = el("div", "empty", "NO LOCATED RECORDS — gps-bearing hits plot here");
  root.append(header, filterbar, wrap, empty);

  let points: SituationPoint[] = [];
  let bounds: Bounds | null = null;
  let zoom = 13;
  let center = { lat: 0, lng: 0 };
  let fitted = false;
  let activeId: string | null = null;
  let panning: { x: number; y: number } | null = null;
  const hidden = new Set<string>();

  const lon2t = (lon: number, z: number): number => ((lon + 180) / 360) * Math.pow(2, z);
  const lat2t = (lat: number, z: number): number => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  };
  const unwrap = (lng: number): number => (bounds && lng < bounds.minLng ? lng + 360 : lng);
  const typeOf = (p: SituationPoint): string => (p.source ?? p.verb ?? "scan").toLowerCase();
  const visible = (): SituationPoint[] => points.filter((p) => !hidden.has(typeOf(p)));

  function fit(): void {
    const pts = visible();
    if (!bounds || pts.length < 2) {
      if (pts.length === 1) center = { lat: pts[0].lat, lng: pts[0].lng };
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

  // newest recordId per track key → its plane shows the current position/heading;
  // older positions in the same track render as breadcrumb dots.
  function newestPerTrack(pts: SituationPoint[]): Set<string> {
    const best = new Map<string, SituationPoint>();
    for (const p of pts) {
      if (!p.track) continue;
      const cur = best.get(p.track);
      if (!cur || (p.time ?? "") >= (cur.time ?? "")) best.set(p.track, p);
    }
    return new Set([...best.values()].map((p) => p.recordId));
  }

  function render(): void {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return;
    const pts = visible();
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

    // trajectory polylines (oldest→newest per track), coloured by source
    tracks.setAttribute("viewBox", `0 0 ${w} ${h}`);
    tracks.setAttribute("width", String(w));
    tracks.setAttribute("height", String(h));
    const byTrack = new Map<string, SituationPoint[]>();
    for (const p of pts) {
      if (!p.track) continue;
      const arr = byTrack.get(p.track) ?? [];
      arr.push(p);
      byTrack.set(p.track, arr);
    }
    const lines: SVGElement[] = [];
    for (const arr of byTrack.values()) {
      if (arr.length < 2) continue;
      const sorted = [...arr].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
      const line = document.createElementNS(SVGNS, "polyline");
      line.setAttribute("points", sorted.map((p) => { const c = px(p, ox, oy); return `${c.x},${c.y}`; }).join(" "));
      line.setAttribute("stroke", sourceStyle(typeOf(arr[0])).color);
      lines.push(line);
    }
    tracks.replaceChildren(...lines);

    // markers
    const heads = newestPerTrack(pts);
    const mks = pts.map((p) => {
      const c = px(p, ox, oy);
      const type = typeOf(p);
      const st = sourceStyle(type);
      const isFlight = type === "flights";
      const isHead = !p.track || heads.has(p.recordId);
      let b: HTMLElement;
      if (isFlight && isHead) {
        // current aircraft position: a plane glyph rotated to the ADS-B heading
        b = el("button", "mk plane");
        const g = el("span", "glyph", "✈︎"); // ✈ text-presentation (colourable)
        if (p.heading != null) g.style.transform = `rotate(${p.heading - 45}deg)`;
        g.style.color = st.color;
        b.append(g);
      } else if (p.track && !isHead) {
        b = el("button", "mk dot"); // historical breadcrumb along the track
        b.style.background = st.color;
      } else {
        // static point (camera / fire / exif): a coloured pin with the source emoji
        b = el("button", "mk pin");
        b.style.background = st.color;
        b.append(el("span", "e", st.emoji));
      }
      b.style.left = `${c.x}px`;
      b.style.top = `${c.y}px`;
      b.dataset.id = p.recordId;
      if (p.recordId === activeId) b.classList.add("active");
      b.title = p.label ?? p.place ?? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
      return b;
    });
    markers.replaceChildren(...mks);

    // legend: types present
    const present = [...new Set(pts.map(typeOf))];
    legend.replaceChildren(
      ...present.map((t) => {
        const st = sourceStyle(t);
        const row = el("span", "lrow");
        const dot = el("span", "ldot");
        dot.style.background = st.color;
        row.append(dot, el("span", "", `${st.emoji} ${st.label}`));
        return row;
      }),
    );
  }

  function focusPoint(id: string): void {
    const p = points.find((x) => x.recordId === id);
    if (!p) return;
    activeId = id;
    center = { lat: p.lat, lng: unwrap(p.lng) };
    if (zoom < 12) zoom = 12;
    const st = sourceStyle(typeOf(p));
    info.replaceChildren();
    const t = el("div", "t");
    t.style.color = st.color;
    t.textContent = `${st.emoji} ${p.label ?? st.label}`;
    info.append(t);
    const meta: string[] = [p.place ?? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`];
    if (typeOf(p) === "flights") {
      meta.push(
        `${p.onGround ? "on ground" : "airborne"}${p.velocity != null ? ` · ${p.velocity.toFixed(0)} m/s` : ""}${p.heading != null ? ` · hdg ${p.heading.toFixed(0)}°` : ""}`,
      );
    }
    if (p.time) meta.push(`${fmtAge(ageOf(p.time))} ago`);
    info.append(el("div", "d", meta.join(" · ")));
    if (p.summary && typeOf(p) !== "flights") info.append(el("div", "d", p.summary.slice(0, 160)));
    if (p.url) {
      const a = el("a", "d src", `open source ↗`);
      a.href = p.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.color = st.color;
      info.append(a);
    }
    info.classList.add("on");
    render();
  }

  markers.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest(".mk") as HTMLElement | null;
    if (b?.dataset.id) focusPoint(b.dataset.id);
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

  const renderFilters = (types: string[]): void => {
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
          renderFilters(types);
        });
        return chip;
      }),
    );
  };

  return {
    el: root,
    update(snap) {
      const active = snap.panels.includes("map");
      root.style.display = active ? "" : "none";
      if (!active) return;
      points = snap.points;
      bounds = snap.bounds;
      const types = [...new Set(points.map(typeOf))];
      for (const h of [...hidden]) if (!types.includes(h)) hidden.delete(h);
      (header.querySelector(".sub") as HTMLElement).textContent = `${visible().length} located`;
      empty.style.display = points.length ? "none" : "";
      wrap.style.display = points.length ? "" : "none";
      renderFilters(types);
      if (!fitted && points.length) {
        fit();
        fitted = true;
      }
      render();
    },
  };
}
