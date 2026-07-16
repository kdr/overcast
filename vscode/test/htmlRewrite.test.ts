// Tests for the pure artifact-HTML rewrite pipeline (src/panels/htmlRewrite.ts)
// against REAL captured artifacts in ./fixtures (trimmed from a seeded fixture
// case: view player, grid board, wall, online map). Plain node --test — no
// vscode import; the URI mapper is injected.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fileUrlToPath, rewriteArtifactHtml } from "../src/panels/htmlRewrite.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

const CSP_SOURCE = "https://*.vscode-cdn.net";
const opts = (extra: Partial<Parameters<typeof rewriteArtifactHtml>[1]> = {}) => ({
  toWebviewUri: (p: string) => `vscode-webview://authority${p.replace(/\\/g, "/")}`,
  cspSource: CSP_SOURCE,
  ...extra,
});

const META_CSP_COUNT = (html: string): number =>
  (html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["']/gi) ?? []).length;

test("fileUrlToPath: decodes, strips fragment/query, handles windows drives", () => {
  assert.deepEqual(fileUrlToPath("file:///a/b%20c/d.mp4#t=3"), {
    fsPath: "/a/b c/d.mp4",
    suffix: "#t=3",
  });
  assert.deepEqual(fileUrlToPath("file:///a/plain.png"), { fsPath: "/a/plain.png", suffix: "" });
  assert.deepEqual(fileUrlToPath("file:///C:/x/y.mp4?q=1"), {
    fsPath: "C:/x/y.mp4",
    suffix: "?q=1",
  });
});

test("wall: baked CSP replaced, file:// refs (attrs + #t fragments) rewritten, roots deduped", () => {
  const src = fixture("wall.html");
  assert.equal(META_CSP_COUNT(src), 1);
  assert.ok(src.includes("#t=0"), "fixture keeps a media-fragment file URL");

  const { html, localRoots } = rewriteArtifactHtml(src, opts());
  assert.ok(!html.includes("file://"), "every file:// rewritten");
  assert.equal(META_CSP_COUNT(html), 1, "exactly one (injected) CSP remains");
  assert.ok(html.includes(`img-src ${CSP_SOURCE} data:`), "injected CSP uses cspSource");
  assert.ok(html.includes("vscode-webview://authority"), "mapper output present");
  assert.ok(/vscode-webview:\/\/[^"']+\.mp4#t=0/.test(html), "media fragment survives rewrite");
  // both wall videos live in the same media dir → exactly one root
  assert.equal(localRoots.length, 1);
  assert.ok(localRoots[0].endsWith("/.overcast/media"));
});

test("view + grid board (no baked CSP): CSP injected, scripts' file URLs rewritten", () => {
  for (const name of ["view.html", "board.html"]) {
    const src = fixture(name);
    assert.equal(META_CSP_COUNT(src), 0, `${name} ships no CSP`);
    const { html, localRoots } = rewriteArtifactHtml(src, opts());
    assert.equal(META_CSP_COUNT(html), 1, `${name}: injected exactly one CSP`);
    assert.ok(!html.includes("file://"), `${name}: no file:// left`);
    assert.ok(localRoots.length >= 1, `${name}: roots collected`);
    assert.ok(html.includes("openExternal"), `${name}: bridge injected`);
  }
});

test("map online: data: URIs untouched, remote links untouched, OSM toggle gates img-src", () => {
  const src = fixture("map-online.html");
  const dataUris = src.match(/data:image\/[a-z+]+;base64/g) ?? [];
  assert.ok(dataUris.length >= 1, "fixture carries a data: URI");

  const closed = rewriteArtifactHtml(src, opts());
  assert.ok(!closed.html.includes(`img-src ${CSP_SOURCE} data: https://*.tile.openstreetmap.org`));
  const open = rewriteArtifactHtml(src, opts({ allowOsmTiles: true }));
  assert.ok(open.html.includes(`img-src ${CSP_SOURCE} data: https://*.tile.openstreetmap.org`));

  for (const out of [closed.html, open.html]) {
    assert.equal((out.match(/data:image\/[a-z+]+;base64/g) ?? []).length, dataUris.length);
    assert.ok(out.includes("https://www.openstreetmap.org/?mlat"), "remote deep link untouched");
    assert.ok(out.includes("tile.openstreetmap.org"), "tile template in script untouched");
  }
});

test("bridge: setState carries serializer state; external-link interception present", () => {
  const { html } = rewriteArtifactHtml(fixture("view.html"), opts({
    stateJson: JSON.stringify({ artifactPath: "/x/y.html", title: "T" }),
  }));
  assert.ok(html.includes('vs.setState({"artifactPath":"/x/y.html","title":"T"})'));
  assert.ok(html.includes("acquireVsCodeApi"));
  assert.ok(html.includes('postMessage({ type: "openExternal"'));
  assert.ok(/window\.open = function/.test(html));
  // bridge sits before </body>
  assert.ok(html.lastIndexOf("</body>") > html.lastIndexOf("openExternal"));
});

test("synthetic: multiple dirs → multiple roots; http(s) urls never touched", () => {
  const src = `<html><head></head><body>
    <img src="file:///dirA/one%20file.png">
    <video src="file:///dirB/clip.mp4#t=2"></video>
    <a href="https://example.com/x.html">x</a>
    <script>var u = "file:///dirA/one%20file.png";</script>
  </body></html>`;
  const { html, localRoots } = rewriteArtifactHtml(src, opts());
  assert.deepEqual(localRoots, ["/dirA", "/dirB"]);
  assert.ok(html.includes("vscode-webview://authority/dirA/one file.png"));
  assert.ok(html.includes("vscode-webview://authority/dirB/clip.mp4#t=2"));
  assert.ok(html.includes("https://example.com/x.html"));
  assert.ok(!html.includes("file://"));
});
