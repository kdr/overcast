import { test } from "node:test";
import assert from "node:assert/strict";
import { VERBS, findVerb, watchVerb } from "../../src/registry/verbs.ts";
import { toJSON } from "../../src/registry/types.ts";
import { parseVerbArgs, renderVerbHelp } from "../../src/registry/to-cli.ts";
import { renderCommand, parseFirstJson } from "../../src/providers/exec.ts";

test("registry exposes watch; findVerb resolves it", () => {
  assert.ok(VERBS.some((v) => v.name === "watch"));
  assert.equal(findVerb("watch")?.name, "watch");
  assert.equal(findVerb("nope"), undefined);
});

test("toJSON produces the commands --json shape with providerKey default", () => {
  const j = toJSON(watchVerb);
  assert.equal(j.name, "watch");
  assert.equal(j.outputKind, "video.analysis");
  assert.equal(j.providerKey, "watch");
  assert.equal(j.group, "sense");
});

test("parseVerbArgs: positional input, --flag value, --flag=value, --bool", () => {
  const p = parseVerbArgs(watchVerb, ["clip.mp4", "--format", "json"]);
  assert.equal(p.input, "clip.mp4");
  assert.equal(p.opts.format, "json");

  const p2 = parseVerbArgs(watchVerb, ["clip.mp4", "--format=md", "--json"]);
  assert.equal(p2.opts.format, "md");
  assert.equal(p2.opts.json, true);

  const p3 = parseVerbArgs(watchVerb, ["--help"]);
  assert.equal(p3.help, true);
});

test("renderVerbHelp mentions the verb and its required arg", () => {
  const h = renderVerbHelp(watchVerb);
  assert.match(h, /overcast watch <input>/);
  assert.match(h, /--format/);
});

test("renderCommand substitutes {{input}} as a single argv token", () => {
  const argv = renderCommand("tinycloud watch {{input}} --json", { input: "/a b/clip.mp4" });
  assert.deepEqual(argv, ["tinycloud", "watch", "/a b/clip.mp4", "--json"]);
  // unknown/empty placeholders are dropped
  assert.deepEqual(renderCommand("x {{missing}} y", {}), ["x", "y"]);
});

test("parseFirstJson handles whole-object and JSONL fallback", () => {
  assert.deepEqual(parseFirstJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseFirstJson('log line\n{"b":2}\ntrailer'), { b: 2 });
  assert.equal(parseFirstJson("no json here"), undefined);
});
