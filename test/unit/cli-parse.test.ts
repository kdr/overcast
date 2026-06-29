import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerbArgs } from "../../src/registry/to-cli.ts";
import { runCli, exitCodeForRecords, type CliIO } from "../../src/cli.ts";
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

test("exitCodeForRecords: state maps to 0/1/3 and non_fatal is subsumed by a summary", () => {
  const rec = (state: string, nonFatal = false) =>
    makeRecord({ verb: "scan", payload: {}, state, meta: nonFatal ? { non_fatal: true } : undefined });

  assert.equal(exitCodeForRecords([]), 0);
  assert.equal(exitCodeForRecords([rec("ready")]), 0);
  // a hard error fails the run; needs_credentials is a distinct setup-gap code
  assert.equal(exitCodeForRecords([rec("error")]), 1);
  assert.equal(exitCodeForRecords([rec("needs_credentials")]), 3);
  // partial scan --pull: subsumed per-hit failures are non_fatal, the ready summary wins
  assert.equal(exitCodeForRecords([rec("error", true), rec("ready")]), 0);
  assert.equal(exitCodeForRecords([rec("needs_credentials", true), rec("ready")]), 0);
  // a non-subsumed credential gap still surfaces as exit 3 even alongside a non_fatal error
  assert.equal(exitCodeForRecords([rec("error", true), rec("needs_credentials")]), 3);
  // a hard (non_fatal-less) error outranks a subsumed credential gap
  assert.equal(exitCodeForRecords([rec("error"), rec("needs_credentials", true)]), 1);
});

test("runCli: loads launcher cwd dotenv as a base before the case overlay", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oc-cli-env-cwd-"));
  const caseDir = mkdtempSync(join(tmpdir(), "oc-cli-env-case-"));
  const baseKey = `OC_TEST_CLI_BASE_${Date.now()}`;
  const sharedKey = `OC_TEST_CLI_SHARED_${Date.now()}`;
  const origCwd = process.cwd();
  try {
    writeFileSync(join(cwd, ".env"), `${baseKey}=from-cwd\n${sharedKey}=from-cwd\n`);
    writeFileSync(join(caseDir, ".env"), `${sharedKey}=from-case\n`);
    process.chdir(cwd);
    const cap = capture();
    const code = await runCli(["commands", "--json", "--case", caseDir], cap.io);
    assert.equal(code, 0);
    // cwd-only secret survives the case overlay (base load ran inside runCli)
    assert.equal(process.env[baseKey], "from-cwd");
    // case .env overlays the shared key on top of the cwd base
    assert.equal(process.env[sharedKey], "from-case");
  } finally {
    process.chdir(origCwd);
    delete process.env[baseKey];
    delete process.env[sharedKey];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(caseDir, { recursive: true, force: true });
  }
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
