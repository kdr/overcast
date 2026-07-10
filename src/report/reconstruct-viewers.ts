// Interactive viewers for `reconstruct` records — self-contained HTML docs with
// inline JS, following the `view` player precedent (senses.ts buildPlayerHtml:
// standalone page, no report CSP) and the qrcodegen precedent (no CDN, no deps:
// the GLB renderer below is a compact hand-rolled WebGL implementation, not a
// vendored three.js — it covers exactly what the mesh providers emit: GLB 2.0,
// triangles, optional interleaved attributes, baseColor texture / factor /
// vertex color; Draco/KTX2-compressed assets degrade to an explicit message).
//
// Both pages lead with the speculative caveat banner — synthesized imagery must
// never read as a capture (same posture as the reconstruct gallery).

import { readFileSync, existsSync, statSync } from "node:fs";
import { escapeHtml, imageSrc } from "./html.js";

export interface ReconstructViewerOpts {
  title: string;
  subtitle?: string;
  /** the non-negotiable speculative banner */
  caveat: string;
}

/** Embedded GLBs above this size make the page unusable; degrade honestly. */
const MAX_EMBED_GLB_BYTES = 64 * 1024 * 1024;

const SHELL_CSS = `
  html,body{margin:0;height:100%;background:#050708;color:#d8ffe4;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
  .banner{position:fixed;top:0;left:0;right:0;z-index:10;background:rgba(20,14,2,.92);border-bottom:1px solid #ffd166;color:#ffd166;padding:8px 14px;text-transform:uppercase;letter-spacing:.4px}
  .title{position:fixed;top:44px;left:14px;z-index:10;color:#5cff96;text-transform:uppercase;font-weight:700}
  .subtitle{color:#8aa69d;font-weight:400;text-transform:none}
  .hud{position:fixed;left:14px;bottom:14px;z-index:10;color:#38e8ff;background:rgba(5,10,10,.7);border:1px solid #1f3a3b;border-radius:6px;padding:8px 10px;white-space:pre;line-height:1.5}
  .hint{position:fixed;right:14px;bottom:14px;z-index:10;color:#8aa69d;background:rgba(5,10,10,.7);border:1px solid #1f3a3b;border-radius:6px;padding:8px 10px}
  .fail{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#ff6b6b;padding:40px;text-align:center;white-space:pre-wrap}
  canvas{display:block;width:100vw;height:100vh;touch-action:none;cursor:grab}
  .controls{position:fixed;right:14px;top:44px;z-index:10;color:#8aa69d;background:rgba(5,10,10,.7);border:1px solid #1f3a3b;border-radius:6px;padding:8px 10px}
  .controls label{display:block;margin:4px 0}
  input[type=range]{width:140px;accent-color:#5cff96;vertical-align:middle}
`;

function shell(opts: ReconstructViewerOpts, extraHead: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>overcast reconstruct — ${escapeHtml(opts.title)}</title>
<style>${SHELL_CSS}</style>${extraHead}</head><body>
<div class="banner">⚠ ${escapeHtml(opts.caveat)}</div>
<div class="title">◈ ${escapeHtml(opts.title)}${opts.subtitle ? ` <span class="subtitle">— ${escapeHtml(opts.subtitle)}</span>` : ""}</div>
${body}
</body></html>`;
}

// ---- 3D orbit viewer ---------------------------------------------------------

/** The GLB parse + WebGL orbit renderer. Plain ES5-ish JS, no backticks and no
 *  "$"+"{" sequences (it is emitted inside a TS template literal). */
const ORBIT_JS = String.raw`
(function(){
'use strict';
var failBox=document.getElementById('fail');
function fail(msg){failBox.style.display='flex';failBox.textContent=msg;var c=document.getElementById('gl');if(c)c.style.display='none';}
var canvas=document.getElementById('gl');
var gl=canvas.getContext('webgl',{antialias:true})||canvas.getContext('experimental-webgl');
if(!gl){fail('WebGL is unavailable in this browser.');return;}
gl.getExtension('OES_standard_derivatives');
gl.getExtension('OES_element_index_uint');

// ---- decode + parse the embedded GLB
var bytes;
try{
  var raw=atob(GLB_B64);
  bytes=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
}catch(e){fail('embedded model failed to decode: '+e.message);return;}
var dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
if(dv.getUint32(0,true)!==0x46546C67){fail('not a GLB file (bad magic).');return;}
var total=dv.getUint32(8,true),off=12,json=null,bin=null;
while(off+8<=total){
  var clen=dv.getUint32(off,true),ctype=dv.getUint32(off+4,true);
  var chunk=bytes.subarray(off+8,off+8+clen);
  if(ctype===0x4E4F534A)json=JSON.parse(new TextDecoder().decode(chunk));
  else if(ctype===0x004E4942)bin=chunk;
  off+=8+clen;
}
if(!json){fail('GLB has no JSON chunk.');return;}
var required=(json.extensionsRequired||[]).join(', ');
if(/draco|ktx|meshopt|quantization/i.test(required)){
  fail('this GLB requires unsupported extensions ('+required+').\nRe-export uncompressed, or open the .glb in an external viewer.');return;
}

// ---- mat4 helpers (column-major, WebGL layout)
function m4ident(){return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];}
function m4mul(a,b){var o=new Array(16);for(var c=0;c<4;c++)for(var r=0;r<4;r++){var s=0;for(var k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;}
function m4persp(fovy,aspect,near,far){var f=1/Math.tan(fovy/2),nf=1/(near-far);return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];}
function m4lookAt(eye,c,up){
  var zx=eye[0]-c[0],zy=eye[1]-c[1],zz=eye[2]-c[2];var zl=Math.hypot(zx,zy,zz)||1;zx/=zl;zy/=zl;zz/=zl;
  var xx=up[1]*zz-up[2]*zy,xy=up[2]*zx-up[0]*zz,xz=up[0]*zy-up[1]*zx;var xl=Math.hypot(xx,xy,xz)||1;xx/=xl;xy/=xl;xz/=xl;
  var yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
  return [xx,yx,zx,0, xy,yy,zy,0, xz,yz,zz,0, -(xx*eye[0]+xy*eye[1]+xz*eye[2]),-(yx*eye[0]+yy*eye[1]+yz*eye[2]),-(zx*eye[0]+zy*eye[1]+zz*eye[2]),1];
}
function quatMat(q){var x=q[0],y=q[1],z=q[2],w=q[3];
  return [1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w),0, 2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w),0, 2*(x*z+y*w),2*(y*z-x*w),1-2*(x*x+y*y),0, 0,0,0,1];}
function nodeMatrix(n){
  if(n.matrix)return n.matrix.slice();
  var m=m4ident();
  if(n.scale){var s=n.scale;m=m4mul([s[0],0,0,0, 0,s[1],0,0, 0,0,s[2],0, 0,0,0,1],m);}
  if(n.rotation)m=m4mul(quatMat(n.rotation),m);
  if(n.translation){var t=n.translation;m=m4mul([1,0,0,0, 0,1,0,0, 0,0,1,0, t[0],t[1],t[2],1],m);}
  return m;
}
function xform(m,v){return [m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12], m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13], m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]];}

// ---- GL buffers per (bufferView, target): attributes stay interleaved and are
// addressed with vertexAttribPointer stride/offset, no CPU repacking.
var glBuffers={};
function bufferFor(bvIdx,target){
  var key=bvIdx+'/'+target;
  if(glBuffers[key])return glBuffers[key];
  var bv=json.bufferViews[bvIdx];
  if(!bin){fail('GLB has no binary chunk.');return null;}
  var data=bin.subarray(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength);
  var buf=gl.createBuffer();
  gl.bindBuffer(target,buf);
  gl.bufferData(target,data,gl.STATIC_DRAW);
  glBuffers[key]=buf;
  return buf;
}
var COMP_COUNT={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};

// ---- shader (single program; missing attrs use constant fallbacks; missing
// normals use screen-space derivatives when the extension is present)
var hasDeriv=!!gl.getExtension('OES_standard_derivatives');
var VS='attribute vec3 aPos;attribute vec3 aNormal;attribute vec2 aUV;attribute vec4 aColor;'+
'uniform mat4 uMVP,uModel;varying vec3 vN;varying vec2 vUV;varying vec4 vC;varying vec3 vW;'+
'void main(){vec4 w=uModel*vec4(aPos,1.0);vW=w.xyz;vN=mat3(uModel[0].xyz,uModel[1].xyz,uModel[2].xyz)*aNormal;vUV=aUV;vC=aColor;gl_Position=uMVP*vec4(aPos,1.0);}';
var FS=(hasDeriv?'#extension GL_OES_standard_derivatives : enable\n':'')+
'precision mediump float;varying vec3 vN;varying vec2 vUV;varying vec4 vC;varying vec3 vW;'+
'uniform sampler2D uTex;uniform vec4 uBase;uniform vec3 uEye;uniform float uHasTex,uHasNormal;'+
'void main(){vec4 base=uBase*vC;if(uHasTex>0.5)base*=texture2D(uTex,vUV);'+
'vec3 N;if(uHasNormal>0.5){N=normalize(vN);}else{'+(hasDeriv?'N=normalize(cross(dFdx(vW),dFdy(vW)));':'N=vec3(0.0,0.0,1.0);')+'}'+
'vec3 L=normalize(uEye-vW);float d=abs(dot(N,L));float light=0.42+0.58*d;'+
'gl_FragColor=vec4(base.rgb*light,base.a);}';
function compile(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)||'shader error');return s;}
var prog;
try{
  prog=gl.createProgram();
  gl.attachShader(prog,compile(gl.VERTEX_SHADER,VS));
  gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,FS));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(prog)||'link error');
}catch(e){fail('shader failed: '+e.message);return;}
gl.useProgram(prog);
var loc={pos:gl.getAttribLocation(prog,'aPos'),normal:gl.getAttribLocation(prog,'aNormal'),uv:gl.getAttribLocation(prog,'aUV'),color:gl.getAttribLocation(prog,'aColor'),
  mvp:gl.getUniformLocation(prog,'uMVP'),model:gl.getUniformLocation(prog,'uModel'),tex:gl.getUniformLocation(prog,'uTex'),base:gl.getUniformLocation(prog,'uBase'),
  eye:gl.getUniformLocation(prog,'uEye'),hasTex:gl.getUniformLocation(prog,'uHasTex'),hasNormal:gl.getUniformLocation(prog,'uHasNormal')};

// ---- textures (async decode; frames render with baseColor until they land)
function isPow2(v){return (v&(v-1))===0;}
var glTextures={};
function textureFor(texIdx){
  if(texIdx in glTextures)return glTextures[texIdx];
  glTextures[texIdx]=null;
  var t=json.textures&&json.textures[texIdx];if(!t||t.source==null)return null;
  var img=json.images&&json.images[t.source];if(!img||img.bufferView==null)return null;
  var bv=json.bufferViews[img.bufferView];
  var data=bin.subarray(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength);
  var blob=new Blob([data],{type:img.mimeType||'image/png'});
  var url=URL.createObjectURL(blob);
  var el=new Image();
  el.onload=function(){
    var tex=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,el);
    if(isPow2(el.width)&&isPow2(el.height)){
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    }else{
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    }
    glTextures[texIdx]=tex;
    URL.revokeObjectURL(url);
  };
  el.src=url;
  return null;
}

// ---- flatten the scene into draw calls + a world-space bbox
var draws=[];var bboxMin=[Infinity,Infinity,Infinity],bboxMax=[-Infinity,-Infinity,-Infinity];
function addPrim(prim,world){
  if(prim.mode!=null&&prim.mode!==4)return; // triangles only
  var posIdx=prim.attributes&&prim.attributes.POSITION;
  if(posIdx==null)return;
  var posAcc=json.accessors[posIdx];
  if(posAcc.min&&posAcc.max){
    for(var xi=0;xi<2;xi++)for(var yi=0;yi<2;yi++)for(var zi=0;zi<2;zi++){
      var c=xform(world,[ (xi?posAcc.max:posAcc.min)[0],(yi?posAcc.max:posAcc.min)[1],(zi?posAcc.max:posAcc.min)[2] ]);
      for(var a=0;a<3;a++){if(c[a]<bboxMin[a])bboxMin[a]=c[a];if(c[a]>bboxMax[a])bboxMax[a]=c[a];}
    }
  }
  var mat=(prim.material!=null&&json.materials)?json.materials[prim.material]:null;
  var pbr=(mat&&mat.pbrMetallicRoughness)||{};
  draws.push({
    world:world,
    attrs:prim.attributes,
    indices:prim.indices,
    count:prim.indices!=null?json.accessors[prim.indices].count:posAcc.count,
    baseColor:pbr.baseColorFactor||[1,1,1,1],
    texIdx:pbr.baseColorTexture?pbr.baseColorTexture.index:null,
    doubleSided:!(mat&&mat.doubleSided===false)
  });
}
function walk(nodeIdx,parentM){
  var n=json.nodes[nodeIdx];if(!n)return;
  var m=m4mul(parentM,nodeMatrix(n));
  if(n.mesh!=null&&json.meshes[n.mesh]){
    var prims=json.meshes[n.mesh].primitives||[];
    for(var i=0;i<prims.length;i++)addPrim(prims[i],m);
  }
  (n.children||[]).forEach(function(c){walk(c,m);});
}
var scene=json.scenes&&json.scenes[json.scene||0];
if(scene&&scene.nodes)scene.nodes.forEach(function(n){walk(n,m4ident());});
else if(json.meshes){(json.meshes[0].primitives||[]).forEach(function(p){addPrim(p,m4ident());});}
if(!draws.length){fail('no renderable triangle meshes in this GLB.');return;}
if(bboxMin[0]===Infinity){bboxMin=[-1,-1,-1];bboxMax=[1,1,1];}
var center=[(bboxMin[0]+bboxMax[0])/2,(bboxMin[1]+bboxMax[1])/2,(bboxMin[2]+bboxMax[2])/2];
var radius=Math.max(0.001,Math.hypot(bboxMax[0]-bboxMin[0],bboxMax[1]-bboxMin[1],bboxMax[2]-bboxMin[2])/2);

// ---- orbit state + input
var theta=Math.PI/4,phi=Math.PI/2.4,dist=radius*2.6,interacted=false;
var dragging=false,lastX=0,lastY=0,pinch=0;
canvas.addEventListener('pointerdown',function(e){dragging=true;interacted=true;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',function(e){if(!dragging)return;theta-=(e.clientX-lastX)*0.008;phi-=(e.clientY-lastY)*0.008;phi=Math.max(0.05,Math.min(Math.PI-0.05,phi));lastX=e.clientX;lastY=e.clientY;});
canvas.addEventListener('pointerup',function(){dragging=false;});
canvas.addEventListener('wheel',function(e){e.preventDefault();interacted=true;dist*=Math.exp(e.deltaY*0.0012);dist=Math.max(radius*0.4,Math.min(radius*10,dist));},{passive:false});
canvas.addEventListener('touchmove',function(e){
  if(e.touches.length===2){
    var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    if(pinch)dist=Math.max(radius*0.4,Math.min(radius*10,dist*pinch/d));
    pinch=d;interacted=true;e.preventDefault();
  }else{pinch=0;}
},{passive:false});
document.getElementById('reset').addEventListener('click',function(){theta=Math.PI/4;phi=Math.PI/2.4;dist=radius*2.6;});

// ---- attribute binding
function bindAttr(attrLoc,accIdx,fallback){
  if(attrLoc<0)return;
  if(accIdx==null){
    gl.disableVertexAttribArray(attrLoc);
    if(fallback.length===4)gl.vertexAttrib4f(attrLoc,fallback[0],fallback[1],fallback[2],fallback[3]);
    else if(fallback.length===3)gl.vertexAttrib3f(attrLoc,fallback[0],fallback[1],fallback[2]);
    else gl.vertexAttrib2f(attrLoc,fallback[0],fallback[1]);
    return;
  }
  var acc=json.accessors[accIdx];
  if(acc.bufferView==null){gl.disableVertexAttribArray(attrLoc);return;} // sparse unsupported
  var bv=json.bufferViews[acc.bufferView];
  var buf=bufferFor(acc.bufferView,gl.ARRAY_BUFFER);
  gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.enableVertexAttribArray(attrLoc);
  gl.vertexAttribPointer(attrLoc,COMP_COUNT[acc.type]||3,acc.componentType,!!acc.normalized,bv.byteStride||0,acc.byteOffset||0);
}
var INDEX_BYTES={5121:1,5123:2,5125:4};

var hud=document.getElementById('hud');
function frame(){
  var w=canvas.clientWidth,h=canvas.clientHeight;
  if(canvas.width!==w*devicePixelRatio||canvas.height!==h*devicePixelRatio){canvas.width=w*devicePixelRatio;canvas.height=h*devicePixelRatio;}
  gl.viewport(0,0,canvas.width,canvas.height);
  gl.clearColor(0.02,0.03,0.03,1);gl.enable(gl.DEPTH_TEST);
  gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  if(!interacted)theta+=0.004;
  var eye=[center[0]+dist*Math.sin(phi)*Math.cos(theta),center[1]+dist*Math.cos(phi),center[2]+dist*Math.sin(phi)*Math.sin(theta)];
  var view=m4lookAt(eye,center,[0,1,0]);
  var proj=m4persp(Math.PI/4,w/h,radius*0.01,radius*40);
  var vp=m4mul(proj,view);
  gl.uniform3f(loc.eye,eye[0],eye[1],eye[2]);
  for(var i=0;i<draws.length;i++){
    var d=draws[i];
    if(d.doubleSided)gl.disable(gl.CULL_FACE);else{gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);}
    gl.uniformMatrix4fv(loc.mvp,false,new Float32Array(m4mul(vp,d.world)));
    gl.uniformMatrix4fv(loc.model,false,new Float32Array(d.world));
    gl.uniform4fv(loc.base,d.baseColor);
    gl.uniform1f(loc.hasNormal,d.attrs.NORMAL!=null?1:0);
    var tex=d.texIdx!=null?textureFor(d.texIdx):null;
    gl.uniform1f(loc.hasTex,tex?1:0);
    if(tex){gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex);gl.uniform1i(loc.tex,0);}
    bindAttr(loc.pos,d.attrs.POSITION,[0,0,0]);
    bindAttr(loc.normal,d.attrs.NORMAL,[0,0,1]);
    bindAttr(loc.uv,d.attrs.TEXCOORD_0,[0,0]);
    bindAttr(loc.color,d.attrs.COLOR_0,[1,1,1,1]);
    if(d.indices!=null){
      var iacc=json.accessors[d.indices];
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,bufferFor(iacc.bufferView,gl.ELEMENT_ARRAY_BUFFER));
      gl.drawElements(gl.TRIANGLES,d.count,iacc.componentType,iacc.byteOffset||0);
    }else{
      gl.drawArrays(gl.TRIANGLES,0,d.count);
    }
  }
  var az=((theta*180/Math.PI)%360+360)%360;
  var el=90-phi*180/Math.PI;
  hud.textContent='AZ  '+az.toFixed(0)+'°\nEL  '+el.toFixed(0)+'°\nRNG '+(dist/radius).toFixed(2)+'x';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
`;

/**
 * Self-contained 3D orbit viewer for a reconstructed GLB mesh: the model is
 * embedded base64, parsed and rendered by the inline WebGL renderer above.
 * Drag to orbit, wheel/pinch to range; auto-orbits until first interaction;
 * HUD shows the live camera az/el like a tracking readout.
 */
export function buildOrbitViewerHtml(glbPath: string, opts: ReconstructViewerOpts): string {
  let body: string;
  let head = "";
  if (!existsSync(glbPath)) {
    body = `<div class="fail">mesh file missing: ${escapeHtml(glbPath)}</div>`;
  } else if (statSync(glbPath).size > MAX_EMBED_GLB_BYTES) {
    body = `<div class="fail">mesh is too large to embed (${Math.round(statSync(glbPath).size / 1024 / 1024)} MB &gt; 64 MB).\nOpen it in an external GLB viewer: ${escapeHtml(glbPath)}</div>`;
  } else {
    const b64 = readFileSync(glbPath).toString("base64");
    head = `<script>const GLB_B64=${JSON.stringify(b64)};</script>`;
    body = `<canvas id="gl"></canvas>
<div id="fail" class="fail" style="display:none"></div>
<div id="hud" class="hud">AZ —</div>
<div class="hint">drag orbit · wheel range · <button id="reset" style="background:#0d1f14;color:#5cff96;border:1px solid #1f9d57;border-radius:4px;cursor:pointer">reset</button></div>
<script>${ORBIT_JS}</script>`;
  }
  return shell(opts, head, body);
}

// ---- depth parallax viewer -----------------------------------------------------

const PARALLAX_JS = String.raw`
(function(){
'use strict';
var canvas=document.getElementById('gl');
var failBox=document.getElementById('fail');
function fail(msg){failBox.style.display='flex';failBox.textContent=msg;canvas.style.display='none';}
var gl=canvas.getContext('webgl')||canvas.getContext('experimental-webgl');
if(!gl){fail('WebGL is unavailable in this browser.');return;}
var VS='attribute vec2 aPos;varying vec2 vUV;void main(){vUV=vec2(aPos.x*0.5+0.5,0.5-aPos.y*0.5);gl_Position=vec4(aPos,0.0,1.0);}';
var FS='precision mediump float;varying vec2 vUV;uniform sampler2D uColor,uDepth;uniform vec2 uShift;uniform float uStrength,uInvert;'+
'void main(){vec2 uv=vUV*0.92+0.04;'+
'float d=texture2D(uDepth,uv).r;if(uInvert>0.5)d=1.0-d;'+
'vec2 off=uShift*uStrength*(d-0.5);'+
'gl_FragColor=texture2D(uColor,uv+off);}';
function compile(t,s){var sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);
  if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(sh)||'shader');return sh;}
var prog=gl.createProgram();
gl.attachShader(prog,compile(gl.VERTEX_SHADER,VS));
gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,FS));
gl.linkProgram(prog);gl.useProgram(prog);
var buf=gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER,buf);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),gl.STATIC_DRAW);
var aPos=gl.getAttribLocation(prog,'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);
var uShift=gl.getUniformLocation(prog,'uShift'),uStrength=gl.getUniformLocation(prog,'uStrength'),uInvert=gl.getUniformLocation(prog,'uInvert');
function makeTex(unit,uniName){
  var t=gl.createTexture();
  gl.activeTexture(gl.TEXTURE0+unit);
  gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(prog,uniName),unit);
  return t;
}
var texColor=makeTex(0,'uColor'),texDepth=makeTex(1,'uDepth');
var loaded=0,iw=16,ih=9;
function load(unit,tex,src,isColor){
  var img=new Image();
  img.onload=function(){
    gl.activeTexture(gl.TEXTURE0+unit);
    gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);
    if(isColor){iw=img.naturalWidth;ih=img.naturalHeight;}
    loaded++;
  };
  img.onerror=function(){fail('embedded image failed to decode.');};
  img.src=src;
}
load(0,texColor,COLOR_URI,true);
load(1,texDepth,DEPTH_URI,false);
var tx=0,ty=0,cx=0,cy=0,interacted=false,t0=performance.now();
function onMove(x,y){
  var r=canvas.getBoundingClientRect();
  tx=((x-r.left)/r.width-0.5)*2;ty=((y-r.top)/r.height-0.5)*2;interacted=true;
}
canvas.addEventListener('pointermove',function(e){onMove(e.clientX,e.clientY);});
canvas.addEventListener('touchmove',function(e){if(e.touches.length){onMove(e.touches[0].clientX,e.touches[0].clientY);e.preventDefault();}},{passive:false});
var strengthEl=document.getElementById('strength'),invertEl=document.getElementById('invert');
var hud=document.getElementById('hud');
function frame(){
  var box=canvas.parentElement.getBoundingClientRect();
  var maxW=box.width-28,maxH=window.innerHeight-140;
  var s=Math.min(maxW/iw,maxH/ih,1.6);
  var w=Math.max(200,Math.floor(iw*s)),h=Math.max(120,Math.floor(ih*s));
  canvas.style.width=w+'px';canvas.style.height=h+'px';
  if(canvas.width!==w*devicePixelRatio||canvas.height!==h*devicePixelRatio){canvas.width=w*devicePixelRatio;canvas.height=h*devicePixelRatio;}
  gl.viewport(0,0,canvas.width,canvas.height);
  if(!interacted){var t=(performance.now()-t0)/1000;tx=Math.sin(t*0.7)*0.6;ty=Math.cos(t*0.5)*0.35;}
  cx+=(tx-cx)*0.12;cy+=(ty-cy)*0.12;
  var strength=Number(strengthEl.value)/1000;
  gl.uniform2f(uShift,-cx*1.0,-cy*1.0);
  gl.uniform1f(uStrength,strength);
  gl.uniform1f(uInvert,invertEl.checked?1:0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  hud.textContent='PARALLAX '+(strength*1000).toFixed(0)+'\nDX '+cx.toFixed(2)+'  DY '+cy.toFixed(2);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
`;

/**
 * Self-contained "hologram" viewer for a depth reconstruction: the real frame +
 * its estimated depth map drive a WebGL parallax shader — move the pointer to
 * shift the virtual camera a few degrees and feel the estimated geometry.
 * Returns undefined when either image can't be inlined.
 */
export function buildParallaxViewerHtml(
  imagePath: string,
  depthPath: string,
  opts: ReconstructViewerOpts,
): string | undefined {
  const colorUri = imageSrc(imagePath);
  const depthUri = imageSrc(depthPath);
  if (!colorUri || !depthUri) return undefined;
  const head = `<script>const COLOR_URI=${JSON.stringify(colorUri)};const DEPTH_URI=${JSON.stringify(depthUri)};</script>`;
  const body = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;padding:70px 14px 14px;box-sizing:border-box">
<canvas id="gl"></canvas>
</div>
<div id="fail" class="fail" style="display:none"></div>
<div id="hud" class="hud">PARALLAX</div>
<div class="controls">
  <label>strength <input id="strength" type="range" min="0" max="120" value="45"></label>
  <label><input id="invert" type="checkbox"> invert depth</label>
</div>
<div class="hint">move pointer to shift the virtual camera</div>
<script>${PARALLAX_JS}</script>`;
  return shell(opts, head, body);
}
