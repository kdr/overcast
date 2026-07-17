// PURE rewriting pipeline for overcast's generated HTML artifacts (view player,
// grid board, map, graph, wall, brief export) so they render inside a VS Code
// webview. NO vscode imports — the URI mapper is injected so `node --test` can
// exercise this directly (see ../../test/htmlRewrite.test.ts).
//
// What the artifacts look like (verified against real fixture output):
//   - map/graph/wall bake in a strict <meta> CSP built for file:// browsing
//     (src/report/html.ts reportCsp; map.ts builds its own with the OSM tile
//     host in online mode). view.html and grid *_board.html ship NO meta CSP.
//   - Local media is referenced as file:// URLs — in attributes (src, poster,
//     data-src, data-open) AND inside inline <script> strings — sometimes with
//     media fragments (wall uses ...mp4#t=0).
//   - Small images are data: URIs; remote links are plain https:. Both are
//     left untouched.
//
// The pipeline: strip the baked CSP → rewrite every file:// URL through the
// injected mapper (fragment preserved) → inject a webview CSP → append a
// bridge script that forwards external links to the host (openExternal) and
// stores serializer state. Inline scripts have no nonces upstream, so the
// injected CSP allows 'unsafe-inline' script — the accepted trade-off noted in
// the plan (no connect-src, so the exfil surface stays minimal).

export interface RewriteOptions {
  /** map an absolute fs path → webview URI string (webview.asWebviewUri) */
  toWebviewUri(fsPath: string): string;
  /** webview.cspSource */
  cspSource: string;
  /** allow OSM raster tiles (map online mode) */
  allowOsmTiles?: boolean;
  /**
   * JSON for acquireVsCodeApi().setState(...) — the WebviewPanelSerializer
   * reads this back to restore the panel across window reloads.
   */
  stateJson?: string;
}

export interface RewriteResult {
  html: string;
  /** absolute directories the webview needs as localResourceRoots */
  localRoots: string[];
}

const META_CSP_RE = /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi;
const FILE_URL_RE = /file:\/\/[^"'\s)<>]+/g;

/** file:///path%20x.mp4#t=0 → { fsPath: "/path x.mp4", suffix: "#t=0" } */
export function fileUrlToPath(fileUrl: string): { fsPath: string; suffix: string } {
  const cut = fileUrl.search(/[#?]/);
  const base = cut === -1 ? fileUrl : fileUrl.slice(0, cut);
  const suffix = cut === -1 ? "" : fileUrl.slice(cut);
  let p = base.replace(/^file:\/\//i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep the raw path if the encoding is malformed */
  }
  // windows file URLs look like file:///C:/x — strip the leading slash
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  return { fsPath: p, suffix };
}

function parentDir(fsPath: string): string {
  const norm = fsPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx <= 0 ? "/" : norm.slice(0, idx);
}

function buildCsp(opts: RewriteOptions): string {
  const osm = opts.allowOsmTiles ? " https://*.tile.openstreetmap.org" : "";
  return [
    "default-src 'none'",
    `img-src ${opts.cspSource} data:${osm}`,
    `media-src ${opts.cspSource} data:`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `script-src 'unsafe-inline' ${opts.cspSource}`,
    `font-src ${opts.cspSource} data:`,
  ].join("; ");
}

function bridgeScript(stateJson?: string): string {
  const setState = stateJson ? `try { vs.setState(${stateJson}); } catch (e) {}` : "";
  // Forwards external (http/https) navigation to the host — webviews can't
  // open browser tabs themselves — and neutralizes window.open.
  return [
    "<script>",
    "(function () {",
    "  var vs; try { vs = acquireVsCodeApi(); } catch (e) { return; }",
    `  ${setState}`,
    '  function ext(url) { vs.postMessage({ type: "openExternal", url: String(url) }); }',
    '  document.addEventListener("click", function (ev) {',
    "    var t = ev.target;",
    "    var el = t && t.closest ? t.closest('a[href]') : null;",
    "    if (!el) return;",
    "    var href = el.getAttribute('href') || '';",
    "    if (/^https?:\\/\\//i.test(href)) { ev.preventDefault(); ev.stopPropagation(); ext(href); }",
    "  }, true);",
    "  window.open = function (url) { if (url && /^https?:\\/\\//i.test(String(url))) ext(url); return null; };",
    "})();",
    "</script>",
  ].join("\n");
}

export function rewriteArtifactHtml(html: string, opts: RewriteOptions): RewriteResult {
  // 1. strip the artifact's own CSP (view/grid board ship none — fine)
  let out = html.replace(META_CSP_RE, "");

  // 2. rewrite every unique file:// URL (attributes AND inline-script strings)
  const roots = new Set<string>();
  const urls = new Set(out.match(FILE_URL_RE) ?? []);
  for (const url of urls) {
    const { fsPath, suffix } = fileUrlToPath(url);
    roots.add(parentDir(fsPath));
    out = out.split(url).join(opts.toWebviewUri(fsPath) + suffix);
  }

  // 3. inject the webview CSP right after <head> (prepend if no head tag)
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(opts)}">`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  } else {
    out = meta + out;
  }

  // 4. append the openExternal/state bridge
  const bridge = bridgeScript(opts.stateJson);
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${bridge}\n</body>`);
  } else {
    out += `\n${bridge}`;
  }

  return { html: out, localRoots: [...roots].sort() };
}
