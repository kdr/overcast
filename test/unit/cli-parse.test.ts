import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerbArgs } from "../../src/registry/to-cli.ts";
import { runCli, type CliIO } from "../../src/cli.ts";
import { watchVerb } from "../../src/registry/verbs.ts";
import { openCase } from "../../src/case.ts";
import { makeRecord } from "../../src/record.ts";

function capture(): { io: CliIO; out: () => string; err: () => string } {
  let o = "";
  let e = "";
  return { io: { out: (s) => (o += s), err: (s) => (e += s) }, out: () => o, err: () => e };
}

test("parseVerbArgs: a known string flag with no value is an error, not boolean true", () => {
  const p = parseVerbArgs(watchVerb, ["v.mp4", "--format"]);
  assert.ok(p.errors.some((e) => /--format requires a value/.test(e)));
  assert.notEqual(p.opts.format, true);
});

test("parseVerbArgs: invalid choice is rejected", () => {
  const p = parseVerbArgs(watchVerb, ["v.mp4", "--format=xml"]);
  assert.ok(p.errors.some((e) => /must be one of/.test(e)));
  const okp = parseVerbArgs(watchVerb, ["v.mp4", "--format=md"]);
  assert.equal(okp.errors.length, 0);
  assert.equal(okp.opts.format, "md");
});

test("runCli: invalid --format exits 2 and prints an error (no silent fallback)", async () => {
  const c = capture();
  const code = await runCli(["watch", "v.mp4", "--format", "xml"], c.io);
  assert.equal(code, 2);
  assert.match(c.err(), /must be one of/);
});

test("runCli: --case with no value exits 2 (missing global value)", async () => {
  const c = capture();
  const code = await runCli(["watch", "v.mp4", "--case"], c.io);
  assert.equal(code, 2);
  assert.match(c.err(), /--case requires a value/);
});

test("runCli: commands --json lists watch (offline, no cloud)", async () => {
  const c = capture();
  const code = await runCli(["commands", "--json"], c.io);
  assert.equal(code, 0);
  const parsed = JSON.parse(c.out());
  assert.ok(parsed.verbs.some((v: { name: string }) => v.name === "watch"));
});

test("runCli: case clear --yes does not leave a new case record behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-cli-clear-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "hi" } }));
    const cap = capture();
    const code = await runCli(["case", "clear", "--yes", "--case", dir, "--json"], cap.io);
    assert.equal(code, 0);
    assert.equal(openCase(dir).records().length, 0);
    assert.equal(JSON.parse(cap.out()).payload.cleared, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
