// The case knowledge graph viewer (`graph` verb): one self-contained HTML page
// rendering the GraphModel as an interactive canvas force-graph. Model assembly
// lives in src/signals/graph.ts; src/verbs/graph.ts owns the file write +
// launching. All JS is hand-rolled and inlined (no CDN, no egress — the CSP is
// default-src 'none'); the layout is a small velocity-Verlet force simulation:
// link springs + pairwise repulsion (O(n²), fine at case scale) + center gravity
// + damping, stopped after stabilization.

import type { GraphModel, GraphNode } from "../signals/graph.js";
import { escapeHtml, reportCsp, type HtmlTheme } from "./html.js";

interface Palette {
  bg: string;
  panel: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  /** node fill per type */
  types: Record<GraphNode["type"], string>;
}

function palette(theme: HtmlTheme): Palette {
  return theme === "csi"
    ? {
        bg: "#050708",
        panel: "#0b1214",
        line: "#1f3a3b",
        text: "#d8ffe4",
        muted: "#8aa69d",
        accent: "#38e8ff",
        types: {
          record: "#38e8ff",
          media: "#4f8cff",
          target: "#ff4fd8",
          finding: "#ffd24f",
          person: "#ff8c4f",
          device: "#9d6bff",
          place: "#4fff9d",
          entity: "#8aa69d",
        },
      }
    : {
        bg: "#f7f8fa",
        panel: "#ffffff",
        line: "#d9dee5",
        text: "#1a1f24",
        muted: "#5b6672",
        accent: "#2563eb",
        types: {
          record: "#2563eb",
          media: "#0891b2",
          target: "#db2777",
          finding: "#d97706",
          person: "#ea580c",
          device: "#7c3aed",
          place: "#059669",
          entity: "#64748b",
        },
      };
}

/** Guard against `</script>` and JSON breaking out of the inline script tag
 *  (same rule as map.ts's jsonForScript). */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const NODE_TYPES: Array<GraphNode["type"]> = ["record", "media", "target", "finding", "person", "device", "place", "entity"];

export function renderGraphHtml(model: GraphModel, theme: HtmlTheme): string {
  const pal = palette(theme);
  const title = `${model.caseName} — knowledge graph`;

  const typeChips = NODE_TYPES.filter((t) => (model.stats.byType[t] ?? 0) > 0)
    .map(
      (t) =>
        `<label class="tchip"><input type="checkbox" data-type="${t}" checked><span class="dot" style="background:${pal.types[t]}"></span>${t} <span class="n">${model.stats.byType[t]}</span></label>`,
    )
    .join("");

  const style = `*{box-sizing:border-box}body{margin:0;background:${pal.bg};color:${pal.text};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.4;overflow:hidden}
.top{padding:10px 16px;border-bottom:1px solid ${pal.line};display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{margin:0;font-size:16px;color:${pal.accent};white-space:nowrap}
.sub{color:${pal.muted};white-space:nowrap}
.tchip{display:inline-flex;align-items:center;gap:5px;border:1px solid ${pal.line};border-radius:999px;padding:2px 9px;color:${pal.muted};cursor:pointer;user-select:none}
.tchip .dot{width:9px;height:9px;border-radius:50%}
.tchip .n{opacity:.7}
.tchip input{margin:0}
#filter{background:${pal.panel};border:1px solid ${pal.line};color:${pal.text};border-radius:4px;padding:4px 8px;min-width:180px;font:inherit}
.layout{display:grid;grid-template-columns:1fr 340px;height:calc(100vh - 49px)}
#wrap{position:relative;overflow:hidden;cursor:grab}
#wrap.drag{cursor:grabbing}
canvas{display:block}
#tip{position:absolute;pointer-events:none;background:${pal.panel};border:1px solid ${pal.line};color:${pal.text};padding:4px 8px;border-radius:4px;display:none;max-width:340px;word-break:break-word;z-index:5}
.side{overflow:auto;border-left:1px solid ${pal.line};background:${pal.panel};padding:12px 14px}
.side h2{margin:0 0 4px;font-size:14px;color:${pal.accent};word-break:break-word}
.side .kv{color:${pal.muted};margin-bottom:10px}
.side ul{list-style:none;margin:0 0 12px;padding:0}
.side li{padding:5px 0;border-bottom:1px solid ${pal.line};word-break:break-word}
.side .ek{color:${pal.muted}}
.side code{background:${pal.bg};border:1px solid ${pal.line};border-radius:3px;padding:1px 5px;display:inline-block;margin-top:3px;word-break:break-all}
.side .hint{color:${pal.muted};font-size:12px}
.caveat{border:1px solid ${pal.line};border-radius:4px;padding:6px 9px;color:${pal.muted};margin-bottom:10px}`;

  const nodesJs = model.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.label,
    recordId: n.recordId ?? null,
    ref: n.ref ?? null,
    entityType: n.entityType ?? null,
    degree: n.degree,
    component: n.component,
    extracted: n.extracted === true,
  }));
  const edgesJs = model.edges.map((e) => ({ s: e.source, t: e.target, kind: e.kind, label: e.label ?? null, recordId: e.recordId ?? null }));

  const extractedCount = model.nodes.filter((n) => n.extracted).length;
  const caveatHtml = extractedCount
    ? `<div class="caveat">⚠ ${extractedCount} node${extractedCount === 1 ? "" : "s"} carry LLM-extracted links — leads, not proof; verify against the cited records.</div>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8">${reportCsp({ script: true })}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head>
<body>
<header class="top">
  <h1>${escapeHtml(title)}</h1>
  <span class="sub" id="counts">${model.stats.nodes} nodes · ${model.stats.edges} edges · ${model.stats.components} component${model.stats.components === 1 ? "" : "s"}</span>
  <input id="filter" type="search" placeholder="filter nodes…" autocomplete="off">
  ${typeChips}
</header>
<div class="layout">
  <div id="wrap"><canvas id="cv"></canvas><div id="tip"></div></div>
  <aside class="side" id="side">${caveatHtml}<div class="hint">Click a node to inspect it. Drag nodes to untangle; drag the background to pan, wheel to zoom. Checkboxes toggle node types; the filter box dims non-matching nodes.</div></aside>
</div>
<script>
const NODES=${jsonForScript(nodesJs)};
const EDGES=${jsonForScript(edgesJs)};
const COLORS=${jsonForScript(pal.types)};
const PAL=${jsonForScript({ bg: pal.bg, line: pal.line, text: pal.text, muted: pal.muted, accent: pal.accent, panel: pal.panel })};
const byId=new Map(NODES.map(n=>[n.id,n]));
EDGES.forEach(e=>{e.a=byId.get(e.s);e.b=byId.get(e.t);});
const wrap=document.getElementById('wrap'),cv=document.getElementById('cv'),ctx=cv.getContext('2d'),tip=document.getElementById('tip'),side=document.getElementById('side');
let W=0,H=0,dpr=window.devicePixelRatio||1;
function resize(){W=wrap.clientWidth;H=wrap.clientHeight;cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+'px';cv.style.height=H+'px';draw();}
// --- init positions: one ring per connected component so components don't overlap
(function(){
  const comps=new Map();
  NODES.forEach(n=>{if(!comps.has(n.component))comps.set(n.component,[]);comps.get(n.component).push(n);});
  const k=comps.size,cols=Math.ceil(Math.sqrt(k));let i=0;
  for(const [,members] of comps){
    const cx=(i%cols-(cols-1)/2)*420,cy=(Math.floor(i/cols)-(Math.ceil(k/cols)-1)/2)*420;i++;
    members.forEach((n,j)=>{const a=j/members.length*Math.PI*2,r=40+Math.sqrt(members.length)*22;
      n.x=cx+Math.cos(a)*r;n.y=cy+Math.sin(a)*r;n.vx=0;n.vy=0;n.fixed=false;n.gx=cx;n.gy=cy;});
  }
})();
// --- velocity-Verlet force layout: springs + repulsion + gravity + damping
let alpha=1,ticking=true;
function tick(){
  const REP=2600,SPRING=0.04,LEN=90,GRAV=0.012,DAMP=0.82;
  for(let i=0;i<NODES.length;i++){const a=NODES[i];
    for(let j=i+1;j<NODES.length;j++){const b=NODES[j];
      if(a.component!==b.component)continue; // components repel only internally
      let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy;if(d2<1){dx=(Math.random()-0.5);dy=(Math.random()-0.5);d2=1;}
      if(d2>90000)continue;const f=REP/d2,d=Math.sqrt(d2);
      const fx=dx/d*f,fy=dy/d*f;a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}}
  EDGES.forEach(e=>{if(!e.a||!e.b)return;
    const dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,d=Math.max(1,Math.sqrt(dx*dx+dy*dy));
    const f=SPRING*(d-LEN),fx=dx/d*f,fy=dy/d*f;
    e.a.vx+=fx;e.a.vy+=fy;e.b.vx-=fx;e.b.vy-=fy;});
  let energy=0;
  NODES.forEach(n=>{
    // gravity toward the node's COMPONENT grid center — a global-origin pull
    // would slowly collapse disconnected components (which only repel
    // internally) into one overlapping pile.
    n.vx-=(n.x-n.gx)*GRAV*0.08;n.vy-=(n.y-n.gy)*GRAV*0.08;
    if(n.fixed){n.vx=0;n.vy=0;return;}
    n.vx*=DAMP;n.vy*=DAMP;
    n.x+=n.vx*alpha;n.y+=n.vy*alpha;
    energy+=n.vx*n.vx+n.vy*n.vy;});
  alpha=Math.max(0.06,alpha*0.995);
  if(energy/Math.max(1,NODES.length)<0.02)ticking=false; // stabilized
}
// --- view transform (pan/zoom)
let scale=1,tx=0,ty=0;
function fit(){
  if(!NODES.length)return;
  let minX=1/0,minY=1/0,maxX=-1/0,maxY=-1/0;
  NODES.forEach(n=>{minX=Math.min(minX,n.x);minY=Math.min(minY,n.y);maxX=Math.max(maxX,n.x);maxY=Math.max(maxY,n.y);});
  const w=Math.max(1,maxX-minX),h=Math.max(1,maxY-minY);
  scale=Math.min(2,Math.min(W/(w+160),H/(h+160)));
  tx=W/2-(minX+maxX)/2*scale;ty=H/2-(minY+maxY)/2*scale;
}
function toScreen(n){return {x:n.x*scale+tx,y:n.y*scale+ty};}
function toWorld(px,py){return {x:(px-tx)/scale,y:(py-ty)/scale};}
function radius(n){return 4+Math.min(14,Math.sqrt(n.degree)*2.4);}
// --- filters
const hiddenTypes=new Set();let filterText='';
function visible(n){return !hiddenTypes.has(n.type);}
function matches(n){return !filterText||n.label.toLowerCase().includes(filterText)||(n.entityType&&n.entityType.includes(filterText))||n.type.includes(filterText);}
let selected=null,hover=null;
function draw(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  ctx.lineWidth=1;
  const showEdgeLabels=scale>0.9;
  EDGES.forEach(e=>{
    if(!e.a||!e.b||!visible(e.a)||!visible(e.b))return;
    const A=toScreen(e.a),B=toScreen(e.b);
    const dim=filterText&&!(matches(e.a)||matches(e.b));
    const isSel=selected&&(e.a===selected||e.b===selected);
    const isHov=hover&&(e.a===hover||e.b===hover);
    ctx.strokeStyle=isSel||isHov?PAL.accent:PAL.line;
    ctx.globalAlpha=dim?0.12:(e.kind==='relation'?0.75:0.55);
    if(e.kind==='relation'){ctx.setLineDash([4,3]);}else{ctx.setLineDash([]);}
    ctx.beginPath();ctx.moveTo(A.x,A.y);ctx.lineTo(B.x,B.y);ctx.stroke();
    if(e.label&&(isSel||isHov||(showEdgeLabels&&e.kind==='relation'))&&!dim){
      ctx.globalAlpha=0.95;ctx.fillStyle=PAL.muted;ctx.font='10px ui-monospace,monospace';
      ctx.fillText(e.label,(A.x+B.x)/2+4,(A.y+B.y)/2-3);}
  });
  ctx.setLineDash([]);
  NODES.forEach(n=>{
    if(!visible(n))return;
    const p=toScreen(n),r=radius(n)*Math.max(0.6,Math.min(1.4,scale));
    const dim=filterText&&!matches(n);
    ctx.globalAlpha=dim?0.15:1;
    ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);
    ctx.fillStyle=COLORS[n.type]||PAL.muted;ctx.fill();
    if(n.extracted){ctx.strokeStyle=PAL.text;ctx.setLineDash([2,2]);ctx.stroke();ctx.setLineDash([]);}
    if(n===selected||n===hover){ctx.lineWidth=2;ctx.strokeStyle=PAL.accent;ctx.stroke();ctx.lineWidth=1;}
    if(scale>0.75&&(n.degree>2||n.type==='target'||n.type==='finding'||n===selected||!dim&&filterText)){
      ctx.fillStyle=dim?PAL.muted:PAL.text;ctx.font='10px ui-monospace,monospace';
      ctx.fillText(n.label.slice(0,28),p.x+r+3,p.y+3);}
  });
  ctx.globalAlpha=1;
}
function loop(){if(ticking){for(let i=0;i<3;i++)tick();fitOnce();draw();}requestAnimationFrame(loop);}
let fitted=false;function fitOnce(){if(!fitted&&alpha<0.5){fit();fitted=true;}}
// --- hit testing / interactions
function nodeAt(px,py){
  const w=toWorld(px,py);let best=null,bestD=1/0;
  NODES.forEach(n=>{if(!visible(n))return;const dx=n.x-w.x,dy=n.y-w.y,d=Math.sqrt(dx*dx+dy*dy);
    if(d<Math.max(10/scale,radius(n)/scale*1.6)&&d<bestD){best=n;bestD=d;}});
  return best;
}
let panning=null,dragging=null;
wrap.addEventListener('mousedown',e=>{
  const n=nodeAt(e.offsetX,e.offsetY);
  if(n){dragging=n;n.fixed=true;}
  else{panning={x:e.clientX,y:e.clientY};wrap.classList.add('drag');}
});
window.addEventListener('mousemove',e=>{
  if(dragging){const r=cv.getBoundingClientRect();const w=toWorld(e.clientX-r.left,e.clientY-r.top);
    dragging.x=w.x;dragging.y=w.y;ticking=true;alpha=Math.max(alpha,0.3);draw();return;}
  if(panning){tx+=e.clientX-panning.x;ty+=e.clientY-panning.y;panning={x:e.clientX,y:e.clientY};draw();return;}
  const n=nodeAt(e.offsetX,e.offsetY);
  if(e.target===cv){
    if(n!==hover){hover=n;draw();}
    if(n){tip.style.display='block';tip.style.left=(e.offsetX+14)+'px';tip.style.top=(e.offsetY+10)+'px';
      tip.textContent=n.label+' — '+n.type+(n.entityType?' ('+n.entityType+')':'')+' · degree '+n.degree;}
    else tip.style.display='none';
  }
});
window.addEventListener('mouseup',()=>{
  if(dragging){dragging.fixed=false;dragging=null;}
  panning=null;wrap.classList.remove('drag');
});
wrap.addEventListener('wheel',e=>{
  e.preventDefault();
  const f=e.deltaY<0?1.15:1/1.15,ns=Math.max(0.08,Math.min(6,scale*f));
  tx=e.offsetX-(e.offsetX-tx)*(ns/scale);ty=e.offsetY-(e.offsetY-ty)*(ns/scale);
  scale=ns;draw();
},{passive:false});
cv.addEventListener('click',e=>{
  if(dragging)return;
  const n=nodeAt(e.offsetX,e.offsetY);
  selected=n;renderSide(n);draw();
});
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function renderSide(n){
  if(!n){side.innerHTML='<div class="hint">Click a node to inspect it.</div>';return;}
  const edges=EDGES.filter(e=>e.a===n||e.b===n);
  const rows=edges.map(e=>{
    const other=e.a===n?e.b:e.a;if(!other)return '';
    return '<li><span class="ek">'+esc(e.kind)+(e.label?' · '+esc(e.label):'')+'</span><br>'+esc(other.label)+' <span class="ek">('+esc(other.type)+')</span>'+(e.recordId?'<br><span class="ek">via '+esc(e.recordId)+'</span>':'')+'</li>';
  }).join('');
  const recIds=new Set();
  if(n.recordId)recIds.add(n.recordId);
  edges.forEach(e=>{if(e.recordId)recIds.add(e.recordId);const o=e.a===n?e.b:e.a;if(o&&o.recordId&&(o.type==='record'||o.type==='finding'))recIds.add(o.recordId);});
  const cmds=[...recIds].slice(0,8).map(id=>'<code>overcast view '+esc(id)+'</code> <code>overcast case memory get '+esc(id)+'</code>').join('<br>');
  side.innerHTML='<h2>'+esc(n.label)+'</h2>'
    +'<div class="kv">'+esc(n.type)+(n.entityType?' · '+esc(n.entityType):'')+' · degree '+n.degree+(n.extracted?' · <b>LLM-extracted (lead, not proof)</b>':'')+(n.ref?'<br>'+esc(n.ref):'')+'</div>'
    +(rows?'<ul>'+rows+'</ul>':'<div class="hint">no edges</div>')
    +(cmds?'<div class="hint">inspect the linked records:</div><div>'+cmds+'</div>':'');
}
// --- top bar controls
document.querySelectorAll('.tchip input').forEach(cb=>cb.addEventListener('change',()=>{
  if(cb.checked)hiddenTypes.delete(cb.dataset.type);else hiddenTypes.add(cb.dataset.type);
  draw();
}));
document.getElementById('filter').addEventListener('input',e=>{filterText=e.target.value.trim().toLowerCase();draw();});
window.addEventListener('resize',resize);
resize();fit();draw();loop();
</script>
</body></html>`;
}
