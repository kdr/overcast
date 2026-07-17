// Pure-logic tests for lib/argAssembly.ts (no vscode import — plain node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleArgs } from "../src/lib/argAssembly.ts";
import type { VerbSpecJSON } from "../src/types.ts";

const spec = (over: Partial<VerbSpecJSON>): VerbSpecJSON => ({
  name: "demo",
  summary: "",
  args: [],
  flags: [],
  outputKind: "demo",
  providerKey: "demo",
  group: "sense",
  ...over,
});

test("verb name leads; positional order preserved", () => {
  const s = spec({
    args: [
      { name: "action", summary: "", required: true },
      { name: "input", summary: "" },
    ],
  });
  assert.deepEqual(
    assembleArgs(s, { args: { action: "match", input: "/a.mp4" }, flags: {} }),
    ["demo", "match", "/a.mp4"],
  );
});

test("missing required positional throws with the arg name", () => {
  const s = spec({ args: [{ name: "input", summary: "", required: true }] });
  assert.throws(() => assembleArgs(s, { args: {}, flags: {} }), /<input>/);
});

test("positional after an omitted optional positional throws (order shift)", () => {
  const s = spec({
    args: [
      { name: "action", summary: "", required: true },
      { name: "input", summary: "" },
      { name: "reference", summary: "" },
    ],
  });
  assert.throws(
    () => assembleArgs(s, { args: { action: "match", reference: "/b.mp4" }, flags: {} }),
    /after omitted <input>/,
  );
});

test("variadic positional expands string[]", () => {
  const s = spec({ args: [{ name: "refs", summary: "", required: true, variadic: true }] });
  assert.deepEqual(assembleArgs(s, { args: { refs: ["a", "b", "c"] }, flags: {} }), [
    "demo",
    "a",
    "b",
    "c",
  ]);
});

test("boolean flags: true → bare flag, false/undefined → omitted", () => {
  const s = spec({
    flags: [
      { name: "view", summary: "", type: "boolean" },
      { name: "no-open", summary: "", type: "boolean" },
      { name: "deep", summary: "", type: "boolean" },
    ],
  });
  assert.deepEqual(
    assembleArgs(s, { args: {}, flags: { view: true, "no-open": false } }),
    ["demo", "--view"],
  );
});

test("string/number flags emit --flag value; empty string skipped", () => {
  const s = spec({
    flags: [
      { name: "count", summary: "", type: "number" },
      { name: "prompt", summary: "", type: "string" },
      { name: "index", summary: "", type: "string" },
    ],
  });
  assert.deepEqual(
    assembleArgs(s, { args: {}, flags: { count: 4, prompt: "crane barge", index: "" } }),
    ["demo", "--count", "4", "--prompt", "crane barge"],
  );
});

test("values strictly equal to the spec default are skipped", () => {
  const s = spec({
    flags: [
      { name: "count", summary: "", type: "number", default: 16 },
      { name: "cols", summary: "", type: "number", default: 4 },
    ],
  });
  assert.deepEqual(assembleArgs(s, { args: {}, flags: { count: 16, cols: 2 } }), [
    "demo",
    "--cols",
    "2",
  ]);
});

test("choices flags pass through as plain values", () => {
  const s = spec({
    flags: [{ name: "granularity", summary: "", type: "string", choices: ["video", "frame"] }],
  });
  assert.deepEqual(assembleArgs(s, { args: {}, flags: { granularity: "frame" } }), [
    "demo",
    "--granularity",
    "frame",
  ]);
});
