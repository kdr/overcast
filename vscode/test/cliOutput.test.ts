// Pure-logic tests for lib/cliOutput.ts (no vscode import — plain node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failureFor,
  firstLine,
  generatedViewerPaths,
  parseRecords,
} from "../src/lib/cliOutput.ts";

test("parseRecords: single pretty-printed record", () => {
  const out = parseRecords(JSON.stringify({ id: "r1", verb: "watch", payload: {} }, null, 2));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "r1");
});

test("parseRecords: concatenated records (multi-record verbs)", () => {
  const a = JSON.stringify({ id: "a", verb: "scan", payload: { n: 1 } }, null, 2);
  const b = JSON.stringify({ id: "b", verb: "capture", payload: { s: "}{" } }, null, 2);
  const out = parseRecords(`${a}\n${b}\n`);
  assert.deepEqual(
    out.map((r) => r.id),
    ["a", "b"],
  );
  assert.equal((out[1].payload as { s: string }).s, "}{");
});

test("parseRecords: braces inside strings don't split records", () => {
  const rec = { id: "x", verb: "note", payload: { text: 'quote " and {nested} \\ braces' } };
  const out = parseRecords(JSON.stringify(rec, null, 2));
  assert.equal(out.length, 1);
  assert.equal((out[0].payload as { text: string }).text, rec.payload.text);
});

test("parseRecords: tolerates stray non-JSON noise around records", () => {
  const rec = JSON.stringify({ id: "ok", verb: "see", payload: {} });
  const out = parseRecords(`some log line\n${rec}\ntrailing {not json`);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "ok");
});

test("failureFor: success and the three exit-code contracts", () => {
  assert.equal(failureFor(0, [], ""), undefined);
  assert.equal(failureFor(3, [], "")?.kind, "needs_credentials");
  assert.equal(failureFor(2, [], "usage: overcast …")?.kind, "usage");
  const errRec = [
    { id: "e", verb: "face", format: "json", payload: { error: "no provider bound" }, state: "error", error: "no provider bound" },
  ];
  const f = failureFor(1, errRec as never, "");
  assert.equal(f?.kind, "error");
  assert.equal(f?.message, "no provider bound");
});

test("firstLine: skips blank lines", () => {
  assert.equal(firstLine("\n\n  real message\nrest"), "real message");
});

test("generatedViewerPaths: reads the declared viewer fields, skips remote", () => {
  assert.deepEqual(generatedViewerPaths({ viewer: "/case/.overcast/media/map.html" }), [
    "/case/.overcast/media/map.html",
  ]);
  assert.deepEqual(generatedViewerPaths({ view: "/case/.overcast/media/tiny_grid_board.html" }), [
    "/case/.overcast/media/tiny_grid_board.html",
  ]);
  assert.deepEqual(generatedViewerPaths({ viewer: "https://example.com/page.html" }), []);
  assert.deepEqual(generatedViewerPaths({ viewer: "/case/media/clip.mp4" }), []);
});

test("generatedViewerPaths: a downloaded page is NOT an openable artifact", () => {
  // `capture <url>` on a generic host writes the remote page verbatim and puts
  // its path in payload.path — the old any-.html walk routed that into a
  // script-enabled webview. Only declared viewer fields count now.
  const capture = {
    capture_id: "cap_report_ab12cd34.html",
    path: "/case/.overcast/media/report_ab12cd34.html",
    kind: "page",
    source: "web",
    url: "https://attacker.example/report.html",
  };
  assert.deepEqual(generatedViewerPaths(capture), []);
  // nesting doesn't resurrect it either
  assert.deepEqual(generatedViewerPaths({ nested: { view: "/case/x.html" } }), []);
});
