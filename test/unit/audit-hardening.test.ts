// Regression tests for the audit-remediation hardening batch: record-store
// resilience, record-id entropy, exec buffer cap + utf-8 decode, the media-fetch
// SSRF guard, atomic state writes, and the skill-referenced-asset shipping guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecordsJSONL, newRecordId, makeRecord } from "../../src/record.ts";
import { execCapture } from "../../src/providers/exec.ts";
import { assertFetchHostAllowed } from "../../src/media/fetch.ts";
import { writeFileAtomic } from "../../src/fs-atomic.ts";

// --- C1: a torn JSONL line must not brick the whole store read ---------------

test("readRecordsJSONL skips a malformed line instead of throwing (C1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-rec-"));
  try {
    const f = join(dir, "watch.jsonl");
    const a = makeRecord({ id: "rec_a", verb: "watch", payload: { content: "ok" } });
    const b = makeRecord({ id: "rec_b", verb: "listen", payload: { transcript: "hi" } });
    // a good line, a torn/interleaved line, then another good line
    writeFileSync(f, `${JSON.stringify(a)}\n{"verb":"watch","payload":\n${JSON.stringify(b)}\n`, "utf8");
    const recs = readRecordsJSONL(f);
    assert.equal(recs.length, 2, "the two valid records survive, the torn line is skipped");
    assert.deepEqual(recs.map((r) => r.id), ["rec_a", "rec_b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- V4: record ids are wide enough to avoid birthday collisions -------------

test("record ids are 8 random bytes and collision-resistant (V4)", () => {
  assert.match(newRecordId(), /^rec_[0-9a-f]{16}$/);
  const ids = new Set(Array.from({ length: 5000 }, () => newRecordId()));
  assert.equal(ids.size, 5000, "no collisions across 5k ids (2^64 space)");
});

// --- C4 / C7: exec output is bounded and utf-8 decodes correctly -------------

test("execCapture rejects when output exceeds maxBuffer (C4)", async () => {
  await assert.rejects(
    execCapture(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024*1024))"], { maxBuffer: 1000 }),
    /output exceeded 1000 bytes/,
  );
});

test("execCapture returns output under the cap", async () => {
  const r = await execCapture(process.execPath, ["-e", "process.stdout.write('hello')"], { maxBuffer: 1000 });
  assert.equal(r.stdout, "hello");
  assert.equal(r.code, 0);
});

test("execCapture decodes multibyte utf-8 without mangling (C7)", async () => {
  const s = "café — 日本語 — 🎥 provenance";
  const r = await execCapture(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(s)})`], {});
  assert.equal(r.stdout, s);
});

// --- C5: media-fetch SSRF guard ---------------------------------------------

test("assertFetchHostAllowed blocks private/loopback/link-local hosts (C5)", () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://localhost/x.jpg",
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x", // 172.16/12 lower bound
    "http://172.31.255.1/x", // 172.16/12 upper bound
    "http://[::1]/x",
  ];
  for (const u of blocked) assert.throws(() => assertFetchHostAllowed(u), /private\/loopback/, u);
});

test("assertFetchHostAllowed allows public hosts", () => {
  const ok = [
    "https://example.com/x.jpg",
    "https://8.8.8.8/x",
    "https://172.32.0.1/x", // just outside 172.16/12
    "https://11.0.0.1/x", // just outside 10/8
  ];
  for (const u of ok) assert.doesNotThrow(() => assertFetchHostAllowed(u), u);
});

test("OVERCAST_ALLOW_PRIVATE_FETCH: only affirmative values opt out (0/false keep the guard on)", () => {
  try {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      process.env.OVERCAST_ALLOW_PRIVATE_FETCH = v;
      assert.doesNotThrow(() => assertFetchHostAllowed("http://169.254.169.254/"), `${v} should opt out`);
    }
    // 0/false/no/empty must NOT disable the guard — they're truthy strings, so a
    // bare `if (process.env.X)` check would wrongly open the SSRF hole.
    for (const v of ["0", "false", "no", "off", ""]) {
      process.env.OVERCAST_ALLOW_PRIVATE_FETCH = v;
      assert.throws(() => assertFetchHostAllowed("http://169.254.169.254/"), /private\/loopback/, `${v} must keep guard on`);
    }
  } finally {
    delete process.env.OVERCAST_ALLOW_PRIVATE_FETCH;
  }
});

// --- C2: atomic write leaves no partial/temp file ----------------------------

test("writeFileAtomic writes content and leaves no temp file (C2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-atomic-"));
  try {
    const f = join(dir, "nested", "state.json");
    writeFileAtomic(f, '{"a":1}\n'); // creates parent dir too
    assert.equal(readFileSync(f, "utf8"), '{"a":1}\n');
    const leftovers = readdirSync(join(dir, "nested")).filter((n) => n.includes(".tmp"));
    assert.equal(leftovers.length, 0, "no .tmp file lingers after rename");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- S1: every scripts/*.sh a skill instructs must ship in package.json -------

test("every scripts/*.sh referenced by a shipped skill is in package.json files[] (S1)", () => {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
  const files = pkg.files;
  const shipsScriptsDir = files.includes("scripts");
  const referenced = new Set<string>();
  const skillFiles = readdirSync(join(root, "skills"), { recursive: true }) as string[];
  for (const rel of skillFiles) {
    if (!rel.endsWith("SKILL.md")) continue;
    const body = readFileSync(join(root, "skills", rel), "utf8");
    for (const m of body.matchAll(/scripts\/[\w.-]+\.sh/g)) referenced.add(m[0]);
  }
  assert.ok(referenced.size > 0, "expected at least one scripts/*.sh reference to guard");
  for (const rel of referenced) {
    assert.ok(
      shipsScriptsDir || files.includes(rel),
      `skills reference ${rel} but package.json files[] does not ship it`,
    );
  }
});
