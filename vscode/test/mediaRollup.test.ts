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
    // ready-only, like pulse's sensedRefs: an analysis that didn't run yet
    // (or couldn't) must not mark its media analyzed
    row({ id: "rec_7", verb: "listen", media: "/case/d.mp4", state: "pending" }),
    row({ id: "rec_8", verb: "watch", media: "/case/d.mp4", state: "needs_credentials" }),
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

test("mdToHtml: emphasis never restyles URLs or code contents (evidence URLs byte-exact)", () => {
  // underscore-bearing handle URL — the emphasis pass must not corrupt the href
  const link = mdToHtml("see https://x.com/_kdr_/status/1 now");
  assert.ok(link.includes('<a href="https://x.com/_kdr_/status/1">https://x.com/_kdr_/status/1</a>'));
  assert.ok(!link.includes("<em>"));
  // markdown-link URL with underscores — same guarantee for the explicit form
  const mdLink = mdToHtml("[report](https://x.com/_a_/b)");
  assert.ok(mdLink.includes('<a href="https://x.com/_a_/b">report</a>'));
  // *…* inside inline code stays literal
  const code = mdToHtml("run `*args*` here");
  assert.ok(code.includes("<code>*args*</code>"));
  // plain digits must never be mistaken for a stash placeholder
  const digits = mdToHtml("call 911 now");
  assert.ok(digits.includes("call 911 now"));
});

test("mdToHtml: autolink hands trailing punctuation back, keeps balanced parens", () => {
  const dot = mdToHtml("see http://example.com/report.");
  assert.ok(dot.includes('<a href="http://example.com/report">http://example.com/report</a>.'));
  const wiki = mdToHtml("map at https://en.wikipedia.org/wiki/Z%C3%BCrich_(city) today");
  assert.ok(wiki.includes('href="https://en.wikipedia.org/wiki/Z%C3%BCrich_(city)"'));
  const wrapped = mdToHtml("(see http://example.com/a)");
  assert.ok(wrapped.includes('<a href="http://example.com/a">http://example.com/a</a>)'));
});
