// Pure-logic tests: the Sources view's analyzed-media rollup and the record
// viewer's note-markdown renderer (both vscode-free; plain node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzedMedia } from "../src/lib/analyzedMedia.ts";
import { mdToHtml } from "../webview/src/views/markdown.ts";
import type { RecordRow } from "../src/types.ts";

const row = (over: Partial<RecordRow> & { id: string; verb: string }): RecordRow => ({
  media: null,
  state: "ready",
  at: null,
  ...over,
});

test("analyzedMedia: groups verbs per ref, newest-first, skips errors + non-analysis", () => {
  const rows: RecordRow[] = [
    row({ id: "rec_1", verb: "watch", media: "/case/a.mp4" }),
    row({ id: "rec_2", verb: "listen", media: "/case/a.mp4" }),
    row({ id: "rec_3", verb: "see", media: "/case/b.jpg" }),
    row({ id: "rec_4", verb: "capture", media: "/case/c.mp4" }), // grabbed ≠ analyzed
    row({ id: "rec_5", verb: "face", media: "/case/a.mp4", state: "error" }), // failed run
    row({ id: "rec_6", verb: "note" }), // no media
  ];
  const out = analyzedMedia(rows);
  assert.equal(out.length, 2);
  // newest-analyzed first: b.jpg was touched after a.mp4's first record set
  assert.deepEqual(out[0], { ref: "/case/b.jpg", verbs: ["see"], recordId: "rec_3" });
  assert.deepEqual(out[1], { ref: "/case/a.mp4", verbs: ["listen", "watch"], recordId: "rec_2" });
});

test("mdToHtml: headings, lists, emphasis, code, links", () => {
  const html = mdToHtml(
    "# Title\n\nSaw **the van** at *dawn* — `plate ABC123`.\n\n- one\n- two\n\n1. first\n\n> quoted\n\n[report](https://example.com/r)",
  );
  assert.ok(html.includes("<h3>Title</h3>"));
  assert.ok(html.includes("<strong>the van</strong>"));
  assert.ok(html.includes("<em>dawn</em>"));
  assert.ok(html.includes("<code>plate ABC123</code>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
  assert.ok(html.includes("<ol><li>first</li></ol>"));
  assert.ok(html.includes("<blockquote>quoted</blockquote>"));
  assert.ok(html.includes('<a href="https://example.com/r">report</a>'));
});

test("mdToHtml: escapes HTML and refuses non-http link schemes", () => {
  const html = mdToHtml('<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>hi</script>');
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("mdToHtml: fenced code blocks pass through verbatim (escaped, unstyled)", () => {
  const html = mdToHtml("```\nnot **bold**\n```");
  assert.ok(html.includes("<pre><code>not **bold**\n</code></pre>"));
});
