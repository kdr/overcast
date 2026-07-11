// The evidence map (`map` verb): every case record carrying GPS coordinates
// plotted on one self-contained HTML page. This module is model assembly + HTML
// rendering only — no ffmpeg/pi imports, so it stays offline-unit-testable;
// src/verbs/map.ts owns the file write + launching.
//
// Online mode fetches OSM raster tiles in the VIEWER's browser at view time (the
// map JS is inlined — no CDN dependency for the tool itself, honoring "No CDN");
// --offline degrades to a coordinate scatter with per-point openstreetmap.org
// links and zero network egress. Live tiles reveal the viewer's IP and the tile
// coordinates (≈ the investigated location) to OpenStreetMap — --offline avoids it.

import { basename } from "node:path";
import { isReady, recordCaptureTimeMs, type OvercastRecord } from "../record.js";
import { finiteNum, validLat, validLng } from "../geo.js";
import { escapeHtml, summarizePayload, imageSrc, reportCsp, type HtmlTheme } from "./html.js";

export interface MapPoint {
  recordId: string;
  verb: string;
  lat: number;
  lng: number;
  altitude: number | null;
  place: string | null;
  at: number | [number, number] | null;
  ref: string | null;
  /** local-image data URI, when the source media is a readable local image */
  thumb: string | null;
  summary: string;
  time: string | null;
}

export interface MapBounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface MapModel {
  caseName: string;
  caseDir: string;
  generatedAt: string;
  points: MapPoint[];
  /** gps-bearing points after --since, before --limit paging */
  total: number;
  /** ALL valid-gps-bearing records, before the --since filter — lets the empty
   *  case distinguish "no GPS at all" from "filtered out by --since". */
  gpsTotal: number;
  /** longitude span may be shifted past ±180 (maxLng>180) for a cluster that
   *  straddles the antimeridian; consumers unwrap point lng into [minLng,maxLng]. */
  bounds: MapBounds | null;
  /** point count by source verb */
  counts: Record<string, number>;
}

export interface BuildMapOptions {
  caseName: string;
  caseDir: string;
  limit?: number;
  sinceCutoff?: number;
  now?: number;
  /** false skips the data-URI thumbnail inlining (imageSrc reads each file) —
   *  the situation server rebuilds the model on every store change and serves
   *  thumbs over HTTP instead, so inlining would be pure wasted I/O there. */
  thumbs?: boolean;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function atOf(v: unknown): number | [number, number] | null {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]];
  return null;
}

/** Longitude bounds as the MINIMAL enclosing arc, so a cluster straddling the
 *  antimeridian (e.g. 170°E + 170°W) spans ~20° not ~340°. Returns [minLng,maxLng]
 *  where maxLng may exceed 180 (frame shifted past the antimeridian); consumers
 *  unwrap a point lng < minLng by +360 to place it in the same frame. */
function lngBounds(lngs: number[]): { minLng: number; maxLng: number } {
  const sorted = [...lngs].sort((a, b) => a - b);
  const n = sorted.length;
  // largest empty arc between consecutive longitudes (incl. the wrap-around gap);
  // the cluster occupies the complement of that gap.
  let gapStartIdx = n - 1;
  let maxGap = sorted[0] + 360 - sorted[n - 1]; // wrap gap (max → min going east)
  for (let i = 1; i < n; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      gapStartIdx = i - 1;
    }
  }
  const minLng = sorted[(gapStartIdx + 1) % n]; // point just after the gap
  let maxLng = sorted[gapStartIdx]; // point just before the gap
  if (maxLng < minLng) maxLng += 360; // cluster wraps the antimeridian
  return { minLng, maxLng };
}

/** Gather every case record carrying numeric `payload.gps{lat,lng}` (primarily
 *  `exif`, but any record qualifies) into map points. Skips error records; keeps
 *  undated records under --since (matching wall); most-recent first under --limit. */
export function buildMapModel(records: OvercastRecord[], opts: BuildMapOptions): MapModel {
  const all: Array<{ point: MapPoint; t: number }> = [];
  const counts: Record<string, number> = {};

  for (const rec of records) {
    if (!isReady(rec)) continue;
    const p = asObj(rec.payload);
    const gps = asObj(p?.gps);
    if (!p || !gps) continue;
    const lat = validLat(gps.lat);
    const lng = validLng(gps.lng);
    if (lat === undefined || lng === undefined) continue;

    // recency for --since / sort / --limit uses the CAPTURE time (exif
    // payload.created) when present — an old geotagged photo ingested today must
    // not read as newest — falling back to the record's ingest time (meta.time).
    // NaN when neither is available (round-1 filter/sort keep undated points).
    const created = typeof p.created === "string" && p.created.trim() ? p.created.trim() : null;
    const t = recordCaptureTimeMs(rec);
    const ref = rec.media?.ref ?? null;
    const point: MapPoint = {
      recordId: rec.id,
      verb: rec.verb,
      lat,
      lng,
      altitude: finiteNum(gps.altitude) ?? null,
      place: typeof p.place === "string" && p.place.trim() ? p.place.trim() : null,
      at: atOf(rec.media?.at),
      ref,
      thumb: ref && opts.thumbs !== false ? imageSrc(ref) ?? null : null,
      summary: summarizePayload(rec.payload),
      time: created ?? (rec.meta?.time ? String(rec.meta.time) : null),
    };
    all.push({ point, t });
  }

  // --since: drop points older than the cutoff; KEEP undated points (NaN time),
  // matching wall.ts. `recordTimeMs` returns NaN for undated records, which `?? 0`
  // would NOT catch — so guard NaN explicitly here and in the sort.
  const filtered = opts.sinceCutoff != null ? all.filter((x) => Number.isNaN(x.t) || x.t >= opts.sinceCutoff!) : all;
  const total = filtered.length;
  // most-recent first; undated (NaN) points sort to the end.
  const sortKey = (t: number) => (Number.isNaN(t) ? -Infinity : t);
  filtered.sort((a, b) => sortKey(b.t) - sortKey(a.t));
  const limit = opts.limit != null && opts.limit > 0 ? opts.limit : filtered.length;
  const points = filtered.slice(0, limit).map((x) => x.point);

  for (const pt of points) counts[pt.verb] = (counts[pt.verb] ?? 0) + 1;

  let bounds: MapBounds | null = null;
  if (points.length) {
    const lat = points.map((p) => p.lat);
    bounds = {
      minLat: Math.min(...lat),
      maxLat: Math.max(...lat),
      ...lngBounds(points.map((p) => p.lng)),
    };
  }

  return {
    caseName: opts.caseName,
    caseDir: opts.caseDir,
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    points,
    total,
    gpsTotal: all.length,
    bounds,
    counts,
  };
}

interface Palette {
  bg: string;
  panel: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  marker: string;
}

function palette(theme: HtmlTheme): Palette {
  return theme === "csi"
    ? { bg: "#050708", panel: "#0b1214", line: "#1f3a3b", text: "#d8ffe4", muted: "#8aa69d", accent: "#38e8ff", marker: "#ff4fd8" }
    : { bg: "#f7f8fa", panel: "#ffffff", line: "#d9dee5", text: "#1a1f24", muted: "#5b6672", accent: "#2563eb", marker: "#e11d48" };
}

function osmLink(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
}

/** Guard against `</script>` and JSON breaking out of the inline script tag. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function head(title: string, csp: string, style: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head>`;
}

function headerHtml(model: MapModel, pal: Palette, mode: string): string {
  const chips = Object.entries(model.counts)
    .map(([verb, n]) => `<span class="chip">${escapeHtml(verb)} ${n}</span>`)
    .join("");
  const paged = model.points.length < model.total ? ` (showing ${model.points.length} of ${model.total})` : "";
  return `<header class="top">
    <h1>${escapeHtml(model.caseName)} — evidence map</h1>
    <div class="sub">${model.points.length} located point${model.points.length === 1 ? "" : "s"}${paged} · ${escapeHtml(mode)} · ${escapeHtml(model.generatedAt)}</div>
    <div class="chips">${chips}</div>
  </header>`;
}

function pointRowHtml(p: MapPoint, i: number): string {
  const label = p.place ?? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  const when = p.time ? escapeHtml(p.time) : "";
  const ref = p.ref ? escapeHtml(basename(p.ref)) : "";
  return `<li class="prow" data-i="${i}">
    <span class="pin">${i + 1}</span>
    <div class="pmeta">
      <div class="ptitle">${escapeHtml(label)}</div>
      <div class="pdim">${escapeHtml(p.verb)}${ref ? ` · ${ref}` : ""}${when ? ` · ${when}` : ""}</div>
      <div class="pdim">${escapeHtml(p.summary).slice(0, 160)}</div>
      <a class="posm" href="${escapeHtml(osmLink(p.lat, p.lng))}" target="_blank" rel="noopener noreferrer">open in OpenStreetMap ↗</a>
    </div>
    ${p.thumb ? `<img class="pthumb" alt="${ref}" src="${escapeHtml(p.thumb)}">` : ""}
  </li>`;
}

function baseStyle(pal: Palette): string {
  return `*{box-sizing:border-box}body{margin:0;background:${pal.bg};color:${pal.text};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.4}
.top{padding:14px 18px;border-bottom:1px solid ${pal.line}}
h1{margin:0;font-size:20px;color:${pal.accent}}.sub{color:${pal.muted};margin-top:4px}.chips{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.chip{border:1px solid ${pal.line};border-radius:999px;padding:1px 8px;color:${pal.muted}}
.layout{display:grid;grid-template-columns:1fr 320px;gap:0;height:calc(100vh - 74px)}
.side{overflow:auto;border-left:1px solid ${pal.line};background:${pal.panel}}
ul.points{list-style:none;margin:0;padding:0}
.prow{display:grid;grid-template-columns:26px 1fr auto;gap:8px;padding:10px 12px;border-bottom:1px solid ${pal.line};cursor:pointer}
.prow:hover,.prow.active{background:${pal.bg}}
.pin{width:22px;height:22px;border-radius:50%;background:${pal.marker};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px}
.ptitle{color:${pal.text};font-weight:600;word-break:break-word}.pdim{color:${pal.muted};word-break:break-word}
.posm{color:${pal.accent};text-decoration:none;font-size:11px}
.pthumb{width:56px;height:56px;object-fit:cover;border:1px solid ${pal.line};border-radius:4px}
@media(max-width:720px){.layout{grid-template-columns:1fr;height:auto}.side{border-left:none;border-top:1px solid ${pal.line}}}`;
}

function renderOnline(model: MapModel, pal: Palette): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: file: https://*.tile.openstreetmap.org; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src data:">`;
  const style =
    baseStyle(pal) +
    `.mapwrap{position:relative;overflow:hidden;background:#0a0d0e;cursor:grab}.mapwrap.drag{cursor:grabbing}
.tiles,.markers{position:absolute;left:0;top:0}.tiles img{position:absolute;width:256px;height:256px;user-select:none;-webkit-user-drag:none}
.mk{position:absolute;transform:translate(-50%,-100%);width:22px;height:22px;border-radius:50% 50% 50% 0;background:${pal.marker};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;transform-origin:center;rotate:-45deg}
.mk span{rotate:45deg}.mk.active{background:${pal.accent}}
.ctl{position:absolute;top:10px;left:10px;z-index:5;display:flex;flex-direction:column;gap:4px}
.ctl button{width:30px;height:30px;font-size:18px;background:${pal.panel};color:${pal.text};border:1px solid ${pal.line};border-radius:4px;cursor:pointer}
.attrib{position:absolute;bottom:2px;right:4px;z-index:5;font-size:10px;color:${pal.muted};background:${pal.panel};padding:1px 5px;border-radius:3px;opacity:.85}`;
  const body = `<body>${headerHtml(model, pal, "live OSM tiles")}
<div class="layout">
  <div class="mapwrap" id="map">
    <div class="tiles" id="tiles"></div>
    <div class="markers" id="markers"></div>
    <div class="ctl"><button id="zin" title="zoom in">+</button><button id="zout" title="zoom out">−</button></div>
    <div class="attrib">© OpenStreetMap contributors</div>
  </div>
  <aside class="side"><ul class="points">${model.points.map(pointRowHtml).join("")}</ul></aside>
</div>
<script>
const POINTS=${jsonForScript(model.points.map((p, i) => ({ lat: p.lat, lng: p.lng, i })))};
const BOUNDS=${jsonForScript(model.bounds)};
const map=document.getElementById('map'),tiles=document.getElementById('tiles'),markers=document.getElementById('markers');
function lon2t(lon,z){return (lon+180)/360*Math.pow(2,z);}
function lat2t(lat,z){var r=lat*Math.PI/180;return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z);}
// unwrap a point longitude into the (possibly antimeridian-shifted) BOUNDS frame
function unwrap(lng){return (BOUNDS && lng < BOUNDS.minLng) ? lng+360 : lng;}
let zoom=14,panning=null,center=BOUNDS?{lat:(BOUNDS.minLat+BOUNDS.maxLat)/2,lng:(BOUNDS.minLng+BOUNDS.maxLng)/2}:{lat:POINTS[0]?POINTS[0].lat:0,lng:POINTS[0]?POINTS[0].lng:0};
// fit from the server-computed BOUNDS (single source of truth, antimeridian-aware)
function fit(){if(!BOUNDS||POINTS.length<2)return;const w=map.clientWidth,h=map.clientHeight;
  for(let z=18;z>=1;z--){const dx=(lon2t(BOUNDS.maxLng,z)-lon2t(BOUNDS.minLng,z))*256,dy=(lat2t(BOUNDS.minLat,z)-lat2t(BOUNDS.maxLat,z))*256;
    if(dx<=w*0.85&&dy<=h*0.85){zoom=z;return;}}zoom=1;}
function render(){const w=map.clientWidth,h=map.clientHeight;
  const cx=lon2t(center.lng,zoom)*256,cy=lat2t(center.lat,zoom)*256,ox=cx-w/2,oy=cy-h/2,n=Math.pow(2,zoom);
  let html='';for(let tx=Math.floor(ox/256);tx<=Math.floor((ox+w)/256);tx++)for(let ty=Math.floor(oy/256);ty<=Math.floor((oy+h)/256);ty++){
    if(ty<0||ty>=n)continue;const wx=((tx%n)+n)%n,s=['a','b','c'][Math.abs(tx+ty)%3];
    html+='<img src="https://'+s+'.tile.openstreetmap.org/'+zoom+'/'+wx+'/'+ty+'.png" style="left:'+(tx*256-ox)+'px;top:'+(ty*256-oy)+'px" onerror="this.style.visibility=\\'hidden\\'">';}
  tiles.innerHTML=html;let mk='';POINTS.forEach(p=>{const px=lon2t(unwrap(p.lng),zoom)*256-ox,py=lat2t(p.lat,zoom)*256-oy;
    mk+='<button class="mk" data-i="'+p.i+'" style="left:'+px+'px;top:'+py+'px"><span>'+(p.i+1)+'</span></button>';});
  markers.innerHTML=mk;}
function focusPoint(i){const p=POINTS[i];if(!p)return;center={lat:p.lat,lng:unwrap(p.lng)};if(zoom<15)zoom=15;render();
  document.querySelectorAll('.mk').forEach(m=>m.classList.toggle('active',m.dataset.i==i));
  document.querySelectorAll('.prow').forEach(r=>r.classList.toggle('active',r.dataset.i==i));
  const row=document.querySelector('.prow[data-i="'+i+'"]');if(row)row.scrollIntoView({block:'nearest'});}
markers.addEventListener('click',e=>{const b=e.target.closest('.mk');if(b)focusPoint(+b.dataset.i);});
document.querySelectorAll('.prow').forEach(r=>r.addEventListener('click',()=>focusPoint(+r.dataset.i)));
document.getElementById('zin').onclick=()=>{if(zoom<19){zoom++;render();}};
document.getElementById('zout').onclick=()=>{if(zoom>1){zoom--;render();}};
map.addEventListener('mousedown',e=>{if(e.target.closest('.mk')||e.target.closest('.ctl'))return;panning={x:e.clientX,y:e.clientY};map.classList.add('drag');});
window.addEventListener('mousemove',e=>{if(!panning)return;const dx=e.clientX-panning.x,dy=e.clientY-panning.y,n=Math.pow(2,zoom);
  center.lng+= -dx/256/n*360;center.lat+= dy/256/n*360*Math.cos(center.lat*Math.PI/180);panning={x:e.clientX,y:e.clientY};render();});
window.addEventListener('mouseup',()=>{panning=null;map.classList.remove('drag');});
map.addEventListener('wheel',e=>{e.preventDefault();if(e.deltaY<0&&zoom<19)zoom++;else if(e.deltaY>0&&zoom>1)zoom--;render();},{passive:false});
fit();render();window.addEventListener('resize',render);
</script></body></html>`;
  return head(`${model.caseName} — evidence map`, csp, style) + body;
}

function renderOffline(model: MapModel, pal: Palette): string {
  const b = model.bounds;
  const W = 900;
  const H = 520;
  const project = (lat: number, lng: number): { x: number; y: number } => {
    if (!b || b.maxLng === b.minLng || b.maxLat === b.minLat) return { x: W / 2, y: H / 2 };
    // unwrap into the bounds frame so an antimeridian-straddling point (lng < minLng)
    // sits at the correct end of the plot instead of the far side.
    const lngU = lng < b.minLng ? lng + 360 : lng;
    const x = 40 + ((lngU - b.minLng) / (b.maxLng - b.minLng)) * (W - 80);
    const y = 40 + ((b.maxLat - lat) / (b.maxLat - b.minLat)) * (H - 80); // north is up
    return { x, y };
  };
  const dots = model.points
    .map((p, i) => {
      const { x, y } = project(p.lat, p.lng);
      const label = p.place ?? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
      return `<a class="dot" style="left:${x}px;top:${y}px" href="${escapeHtml(osmLink(p.lat, p.lng))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}"><span>${i + 1}</span></a>`;
    })
    .join("");
  const style =
    baseStyle(pal) +
    `.mapwrap{position:relative;overflow:auto;background:${pal.panel};background-image:linear-gradient(${pal.line} 1px,transparent 1px),linear-gradient(90deg,${pal.line} 1px,transparent 1px);background-size:45px 45px}
.scatter{position:relative;width:${W}px;height:${H}px;margin:0 auto}
.dot{position:absolute;transform:translate(-50%,-50%);width:24px;height:24px;border-radius:50%;background:${pal.marker};border:2px solid #fff;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;text-decoration:none;box-shadow:0 1px 4px rgba(0,0,0,.4)}
.note{padding:8px 12px;color:${pal.muted}}`;
  const body = `<body>${headerHtml(model, pal, "offline scatter")}
<div class="layout">
  <div class="mapwrap"><div class="note">Offline scatter (no tiles) — points positioned by bounding box; click a pin to open its exact location in OpenStreetMap.</div><div class="scatter">${dots}</div></div>
  <aside class="side"><ul class="points">${model.points.map(pointRowHtml).join("")}</ul></aside>
</div></body></html>`;
  // reportCsp() (default-src 'none') is enough offline: openstreetmap.org links are
  // inert <a href> (a click navigates; CSP doesn't block top-level navigation).
  return head(`${model.caseName} — evidence map`, reportCsp(), style) + body;
}

export function renderMapHtml(model: MapModel, theme: HtmlTheme, opts: { offline: boolean }): string {
  const pal = palette(theme);
  return opts.offline ? renderOffline(model, pal) : renderOnline(model, pal);
}
