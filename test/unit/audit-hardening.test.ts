// Regression tests for the audit-remediation hardening batch: record-store
// resilience, record-id entropy, exec buffer cap + utf-8 decode, the media-fetch
// SSRF guard, atomic state writes, and the skill-referenced-asset shipping guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readRecordsJSONL, newRecordId, makeRecord } from "../../src/record.ts";
import { execCapture } from "../../src/providers/exec.ts";
import { assertFetchHostAllowed, readBodyCapped, fetchMediaToCase } from "../../src/media/fetch.ts";
import { writeFileAtomic } from "../../src/fs-atomic.ts";
import { redactSecrets } from "../../src/env.ts";
import { quoteCommandArg } from "../../src/verbs/case.ts";

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

// --- stdoutToFile: the tinycloud bun-flush workaround -------------------------

test("execCapture stdoutToFile captures output past the 64 KiB pipe buffer", async () => {
  // tinycloud's embedded bun exits without draining a >64 KiB pipe write, so
  // tinycloud call sites capture stdout via a temp FILE instead of a pipe.
  const n = 200 * 1024;
  const r = await execCapture(
    process.execPath,
    ["-e", `process.stdout.write('y'.repeat(${n}))`],
    { stdoutToFile: true },
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, n, "whole write captured, nothing severed at 65536");
});

test("execCapture stdoutToFile still enforces maxBuffer", async () => {
  await assert.rejects(
    execCapture(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1024*1024))"],
      { maxBuffer: 1000, stdoutToFile: true },
    ),
    /output exceeded 1000 bytes/,
  );
});

test("execCapture stdoutToFile kills an over-cap child MID-RUN (not at exit)", async () => {
  // pipe mode SIGKILLs on the data event; file mode must not let a child that
  // blew the cap keep running (and growing the file) until it exits on its own.
  const started = Date.now();
  await assert.rejects(
    execCapture(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(64*1024)); setTimeout(() => {}, 30_000)"],
      { maxBuffer: 1000, stdoutToFile: true },
    ),
    /output exceeded 1000 bytes/,
  );
  assert.ok(Date.now() - started < 10_000, "killed by the size poll, not the child's own 30s exit");
});

test("execCapture stdoutToFile keeps stderr on the pipe and utf-8 intact", async () => {
  const s = "café — 日本語 — 🎥";
  const r = await execCapture(
    process.execPath,
    ["-e", `process.stderr.write('warn'); process.stdout.write(${JSON.stringify(s)})`],
    { stdoutToFile: true },
  );
  assert.equal(r.stdout, s);
  assert.equal(r.stderr, "warn");
});

// --- C5: media-fetch SSRF guard ---------------------------------------------

// a resolver that must never be consulted (literals skip DNS)
const noLookup = async () => {
  throw new Error("literal host must not trigger DNS");
};

test("assertFetchHostAllowed blocks private/loopback/link-local host literals (C5)", async () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://localhost/x.jpg",
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x", // 172.16/12 lower bound
    "http://172.31.255.1/x", // 172.16/12 upper bound
    "http://[::1]/x",
    // shorthand / alternate IP encodings that resolve to loopback/private (Bugbot)
    "http://127.1/x", // 2-part short form → 127.0.0.1
    "http://2130706433/x", // decimal integer → 127.0.0.1
    "http://0x7f.0.0.1/x", // hex octet
    "http://017700000001/x", // octal integer → 127.0.0.1
    "http://0177.0.0.1/x", // octal first octet
    "http://127.0.0.1./x", // trailing dot
    "http://0/x", // 0 → 0.0.0.0
    "http://[::ffff:169.254.169.254]/x", // IPv4-mapped IPv6 metadata
    "http://[::127.0.0.1]/x", // IPv4-compatible IPv6 (normalizes to ::7f00:1) — Bugbot
    "http://[0:0:0:0:0:0:0:1]/x", // fully-expanded loopback
    "http://[fe80::1]/x", // link-local
    "http://[fc00::1]/x", // unique-local
  ];
  for (const u of blocked) await assert.rejects(assertFetchHostAllowed(u, { lookup: noLookup }), /private\/loopback/, u);
});

test("assertFetchHostAllowed allows public IP literals (no DNS)", async () => {
  const ok = ["https://8.8.8.8/x", "https://1.1.1.1/x", "https://172.32.0.1/x", "https://11.0.0.1/x", "https://[2001:db8::1]/x"];
  for (const u of ok) await assert.doesNotReject(assertFetchHostAllowed(u, { lookup: noLookup }), u);
});

test("assertFetchHostAllowed blocks multicast / reserved / broadcast / 192.0.0.0/24", async () => {
  const blocked = [
    "http://224.0.0.1/x", // multicast 224/4 lower
    "http://239.255.255.250/x", // SSDP multicast
    "http://240.0.0.1/x", // reserved 240/4
    "http://255.255.255.255/x", // limited broadcast
    "http://192.0.0.1/x", // 192.0.0.0/24 IETF protocol assignments
  ];
  for (const u of blocked) await assert.rejects(assertFetchHostAllowed(u, { lookup: noLookup }), /private\/loopback/, u);
});

test("assertFetchHostAllowed resolves a hostname and blocks a private DNS answer (rebinding)", async () => {
  await assert.rejects(
    assertFetchHostAllowed("http://rebind.example/x", { lookup: async () => [{ address: "10.0.0.7" }] }),
    /rebind\.example → 10\.0\.0\.7/,
  );
  await assert.doesNotReject(
    assertFetchHostAllowed("http://cdn.example/x", { lookup: async () => [{ address: "93.184.216.34" }] }),
  );
});

test("OVERCAST_ALLOW_PRIVATE_FETCH: only affirmative values opt out (0/false keep the guard on)", async () => {
  try {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      process.env.OVERCAST_ALLOW_PRIVATE_FETCH = v;
      await assert.doesNotReject(assertFetchHostAllowed("http://169.254.169.254/"), `${v} should opt out`);
    }
    // 0/false/no/empty must NOT disable the guard — they're truthy strings, so a
    // bare `if (process.env.X)` check would wrongly open the SSRF hole.
    for (const v of ["0", "false", "no", "off", ""]) {
      process.env.OVERCAST_ALLOW_PRIVATE_FETCH = v;
      await assert.rejects(assertFetchHostAllowed("http://169.254.169.254/", { lookup: noLookup }), /private\/loopback/, `${v} must keep guard on`);
    }
  } finally {
    delete process.env.OVERCAST_ALLOW_PRIVATE_FETCH;
  }
});

test("readBodyCapped: a null-body response returns empty WITHOUT calling arrayBuffer", async () => {
  let arrayBufferCalled = false;
  const fakeRes = {
    body: null,
    arrayBuffer: async () => {
      arrayBufferCalled = true;
      return new ArrayBuffer(100 * 1024 * 1024); // a hostile full-body allocation
    },
  } as unknown as Response;
  const buf = await readBodyCapped(fakeRes, 1024, "http://x/y");
  assert.equal(buf.byteLength, 0);
  assert.equal(arrayBufferCalled, false, "must not buffer the whole body");
});

test("readBodyCapped: a streamed body over the cap rejects (bounded memory)", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(2048));
      c.close();
    },
  });
  const res = { body } as unknown as Response;
  await assert.rejects(readBodyCapped(res, 1024, "http://x/y"), /exceeds cap/);
});

test("assertFetchHostAllowed fails CLOSED when DNS lookup throws (no rebinding bypass)", async () => {
  const throwingLookup = async () => {
    throw new Error("DNS down");
  };
  await assert.rejects(
    assertFetchHostAllowed("http://cdn.example/x", { lookup: throwingLookup }),
    /could not resolve host/,
  );
});

test("fetchMediaToCase runs the SSRF guard even on a cache hit (planted artifact)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-fetch-cache-"));
  try {
    // plant a cache artifact at the deterministic url-<hash> path for a blocked URL
    const url = "http://169.254.169.254/evil.jpg"; // literal metadata IP → blocked, no DNS
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
    writeFileSync(join(dir, `url-${hash}.jpg`), "planted-bytes");
    await assert.rejects(fetchMediaToCase(url, dir), /private\/loopback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertFetchHostAllowed refuses non-http(s) schemes (redirect-to-file SSRF)", async () => {
  for (const u of ["file:///etc/passwd", "gopher://127.0.0.1/", "data:text/plain,hi"]) {
    await assert.rejects(assertFetchHostAllowed(u, { lookup: noLookup }), /non-http\(s\)/, u);
  }
  // the scheme check applies even under the private-host opt-out
  process.env.OVERCAST_ALLOW_PRIVATE_FETCH = "1";
  try {
    await assert.rejects(assertFetchHostAllowed("file:///etc/passwd"), /non-http\(s\)/);
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

// --- quoteCommandArg: the memory-index job script must not be sh-injectable ---

test("quoteCommandArg neutralizes $()/backtick/space so a case path can't inject", () => {
  // a hostile case dir / --home / --profile carrying a command substitution
  const payload = "/tmp/case$(touch /tmp/pwned)";
  const q = quoteCommandArg(payload);
  // single-quoted → everything literal; the `$(` is inside single quotes, inert
  assert.equal(q, "'/tmp/case$(touch /tmp/pwned)'");
  assert.ok(!/^"/.test(q), "must NOT use double quotes (which keep $()/backtick live)");
  for (const bad of ["`id`", "a b", "$(id)", "x;y", "$HOME", "a'b"]) {
    const out = quoteCommandArg(bad);
    assert.ok(out.startsWith("'") && out.endsWith("'"), `${bad} → single-quoted`);
  }
  // an embedded single quote is closed/escaped/reopened, not left dangling
  assert.equal(quoteCommandArg("a'b"), "'a'\\''b'");
  // shell-safe tokens stay verbatim for a readable stored command line
  assert.equal(quoteCommandArg("/abs/path.mp4"), "/abs/path.mp4");
  assert.equal(quoteCommandArg("--json"), "--json");
});

// --- redactSecrets: added high-precision key prefixes are masked inline -------

test("redactSecrets masks hf_/AIza/AKIA/xox tokens even inline in prose", () => {
  const hf = "hf_" + "a".repeat(34);
  const aiza = "AIza" + "B".repeat(35);
  const akia = "AKIA" + "1234567890ABCDEF";
  const slack = "xoxb-" + "1111111111-abcdefghij";
  for (const secret of [hf, aiza, akia, slack]) {
    const out = redactSecrets(`error fetching https://api.example/?key=${secret}&x=1`);
    assert.ok(!out.includes(secret), `${secret.slice(0, 6)}… must be redacted`);
    assert.ok(out.includes("[REDACTED]"));
  }
  // a plain word / short id is NOT redacted (no false positives)
  assert.equal(redactSecrets("just a normal sentence with id 12345"), "just a normal sentence with id 12345");
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
