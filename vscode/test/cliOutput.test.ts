// Pure-logic tests for lib/cliOutput.ts (no vscode import — plain node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failureFor,
  firstLine,
  htmlPathsInPayload,
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

test("htmlPathsInPayload: finds nested local html, skips remote", () => {
  const payload = {
    viewer: "/case/.overcast/media/map.html",
    nested: { view: "/case/.overcast/media/tiny_grid_board.html" },
    remote: "https://example.com/page.html",
    other: "/case/media/clip.mp4",
  };
  assert.deepEqual(htmlPathsInPayload(payload), [
    "/case/.overcast/media/map.html",
    "/case/.overcast/media/tiny_grid_board.html",
  ]);
});
