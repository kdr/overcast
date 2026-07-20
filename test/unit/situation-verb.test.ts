import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { situationVerb } from "../../src/verbs/situation.ts";
import { findVerb } from "../../src/registry/verbs.ts";
import { OPERATIONAL_VERBS } from "../../src/record.ts";
import { readControl, readRuntime, writeRuntime, writeControl, situationDir } from "../../src/situation/state.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function tmpCase() {
  const dir = mkdtempSync(join(tmpdir(), "oc-situation-verb-"));
  const c = openCase(dir);
  c.ensure();
  return { dir, c };
}

function ctx(dir: string, over: Partial<VerbContext> = {}): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return {
    input: undefined,
    rest: [],
    opts: {},
    case: c,
    profile: defaultProfile(),
    home: dir,
    profileName: "default",
    surface: "cli",
    ...over,
  };
}

// chmod 0o000 does NOT make a file unreadable for root (DAC is bypassed), so the
// blocker branch never fires in a root sandbox/CI. A DIRECTORY at the patch path
// makes readFileSync throw EISDIR — the same non-ENOENT "genuinely unreadable"
// branch the control fold treats as a blocker — deterministically for every uid.
function makeUnreadable(path: string): void {
  rmSync(path, { force: true, recursive: true });
  mkdirSync(path);
}

/** seed a case whose control log is held by an unreadable patch */
function blockedCase(): { dir: string; blocker: string } {
  const dir = mkdtempSync(join(tmpdir(), "oc-sitblocked-"));
  const c = openCase(dir);
  c.ensure();
  writeControl(c, { limit: 2 });
  const cdir = join(situationDir(c), "control.d");
  const firstMs = Number(readdirSync(cdir)[0].split("-")[0]);
  const blocker = join(cdir, `${String(firstMs + 1).padStart(15, "0")}-000001-0-blocked.json`);
  makeUnreadable(blocker);
  return { dir, blocker };
}

test("situation stop: a --force SIGTERM is not reported as blocked", async () => {
  // `delivered` reads "control+signal" when the SIGTERM lands, and one of the
  // force-IGNORED variants literally contains the word "signal" — so gating the
  // blocked flag on any substring of it is a trap. A stop that already killed
  // the process must never be reported as stuck behind the queue.
  const dir = mkdtempSync(join(tmpdir(), "oc-sitforce-"));
  let blocker: string | undefined;
  const srv = createServer(() => {});
  // a DISPOSABLE process to receive the SIGTERM — using our own pid here makes
  // the verb kill the test runner, which is a silent, detail-free failure
  const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    const port = (srv.address() as AddressInfo).port;
    const c = openCase(dir);
    c.ensure();
    writeRuntime(c, {
      pid: victim.pid as number, port, bind: "127.0.0.1", url: `http://127.0.0.1:${port}/`,
      displayUrl: `http://127.0.0.1:${port}/`, startedAt: new Date(0).toISOString(),
      caseDir: dir, every: null, mode: "cli",
    });
    writeControl(c, { limit: 2 });
    const cdir = join(situationDir(c), "control.d");
    const firstMs = Number(readdirSync(cdir)[0].split("-")[0]);
    blocker = join(cdir, `${String(firstMs + 1).padStart(15, "0")}-000001-0-blocked.json`);
    writeFileSync(blocker, JSON.stringify({ limit: 9 }), "utf8");
    chmodSync(blocker, 0o000);

    const [rec] = await situationVerb.run(ctx(dir, { input: "stop", surface: "cli", opts: { force: true } }));
    const p = rec.payload as Record<string, unknown>;
    const delivered = String(p.delivered);
    assert.match(delivered, /signal/, "the force path was exercised (a live pid on a served port)");
    assert.ok(!delivered.includes("ignored"), `expected a delivered signal, got: ${delivered}`);
    assert.equal(p.blocked, undefined, "a delivered SIGTERM must not be reported as stuck behind the queue");
  } finally {
    try { victim.kill("SIGKILL"); } catch { /* already gone */ }
    srv.close();
    if (blocker) { try { chmodSync(blocker, 0o600); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation: a LEGACY control.json blocker is named, not hidden behind control.d", async () => {
  // the legacy file is folded as the OLDEST patch, so an unreadable one blocks
  // everything after it. A note pointing only at control.d/ sends the operator
  // looking in the wrong place during exactly the upgrade that produced it.
  const dir = mkdtempSync(join(tmpdir(), "oc-sitlegacy-"));
  let legacy: string | undefined;
  try {
    const c = openCase(dir);
    c.ensure();
    writeControl(c, { limit: 3 }); // a normal patch under control.d/
    legacy = join(situationDir(c), "control.json");
    makeUnreadable(legacy);

    const [status] = await situationVerb.run(ctx(dir, { input: "status", surface: "agent" }));
    const sp = status.payload as Record<string, unknown>;
    assert.equal(sp.blocked, true);
    assert.equal(sp.blocked_path, legacy, "points at control.json, not the control.d directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation status and stop BOTH surface a blocked control log", async () => {
  // surfacing this only on `set` (as the first pass did) leaves the two surfaces
  // an operator actually checks reporting a clean, possibly empty view of a
  // queue that is going nowhere
  const { dir, blocker } = blockedCase();
  try {
    const [status] = await situationVerb.run(ctx(dir, { input: "status", surface: "agent" }));
    const sp = status.payload as Record<string, unknown>;
    assert.equal(sp.blocked, true, "status reports the blocked queue");
    assert.match(String(sp.blocked_note), /cannot be read/i);
    assert.equal(sp.blocked_path, blocker, "names the file that is actually blocking");

    const [stop] = await situationVerb.run(ctx(dir, { input: "stop", surface: "agent" }));
    const tp = stop.payload as Record<string, unknown>;
    assert.equal(tp.blocked, true, "a queued stop reports that it will not be honored yet");
    assert.match(String(tp.note), /NOT be honored/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation set reports a BLOCKED control log instead of a clean apply", async () => {
  // an unreadable patch earlier in the log holds everything behind it. Telling
  // the operator "applied within ~2s" there is a lie — the server cannot take it.
  const dir = mkdtempSync(join(tmpdir(), "oc-sitblocked-"));
  let blocker: string | undefined;
  try {
    const c = openCase(dir);
    c.ensure();
    writeControl(c, { limit: 2 });
    const cdir = join(situationDir(c), "control.d");
    const firstMs = Number(readdirSync(cdir)[0].split("-")[0]);
    blocker = join(cdir, `${String(firstMs + 1).padStart(15, "0")}-000001-0-blocked.json`);
    makeUnreadable(blocker);

    const recs = await situationVerb.run(ctx(dir, { input: "set", surface: "agent", opts: { limit: 5 } }));
    const p = recs[0].payload as Record<string, unknown>;
    assert.equal(p.blocked, true, "the blocked queue is surfaced");
    assert.match(String(p.note), /cannot be read/i, "the note explains why nothing applies");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation is registered + operational (out of ask/brief evidence)", () => {
  assert.equal(findVerb("situation")?.name, "situation");
  assert.ok(OPERATIONAL_VERBS.has("situation"));
});

test("situation with no action: CLI defaults to serve, agent/slash default to status", async () => {
  const { dir } = tmpCase();
  try {
    // agent/slash with no action → status (a useful read-only op), NOT a serve error
    for (const surface of ["agent", "slash"] as const) {
      const [rec] = await situationVerb.run(ctx(dir, { input: undefined, surface }));
      assert.equal(rec.state, "ready", `${surface} defaults to a non-error op`);
      assert.equal((rec.payload as Record<string, unknown>).op, "status", `${surface} defaults to status`);
    }
    // CLI with no action still means serve → hits the port bind path (occupied → error,
    // proving it routed to serve, not status)
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as AddressInfo).port;
    const [cli] = await situationVerb.run(ctx(dir, { input: undefined, surface: "cli", opts: { port, "no-open": true } }));
    assert.equal(cli.state, "error");
    assert.match(String(cli.error), /already in use/, "CLI no-action routed to serve");
    await new Promise<void>((r) => blocker.close(() => r()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation serve is operator-only: the agent tool surface is refused", async () => {
  const { dir } = tmpCase();
  try {
    const [rec] = await situationVerb.run(ctx(dir, { input: "serve", surface: "agent" }));
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /operator action/i);
    // and it did NOT open a listener / write a runtime file
    assert.equal(readRuntime(openCase(dir)), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation set writes a validated control patch (agent-safe)", async () => {
  const { dir, c } = tmpCase();
  try {
    const [rec] = await situationVerb.run(ctx(dir, { input: "set", surface: "agent", opts: { panels: "wall,map", theme: "plain" } }));
    assert.equal(rec.state, "ready");
    const ctl = readControl(c);
    assert.deepEqual(ctl?.panels, ["wall", "map"]);
    assert.equal(ctl?.theme, "plain");
    // an invalid panel is rejected with an error record, no control written
    const { dir: dir2 } = tmpCase();
    const [bad] = await situationVerb.run(ctx(dir2, { input: "set", opts: { panels: "wall,bogus" } }));
    assert.equal(bad.state, "error");
    assert.match(String(bad.error), /unknown panel/);
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation status reports offline / stale runtime; stop writes a stop control", async () => {
  const { dir, c } = tmpCase();
  try {
    const [offline] = await situationVerb.run(ctx(dir, { input: "status" }));
    assert.equal((offline.payload as Record<string, unknown>).running, false);

    // a stale runtime (dead pid) reads as not running
    writeRuntime(c, {
      pid: 2_000_000_000,
      port: 7374,
      bind: "127.0.0.1",
      url: "http://127.0.0.1:7374/",
      displayUrl: "http://127.0.0.1:7374/",
      startedAt: "2026-07-10T12:00:00Z",
      caseDir: dir,
      every: null,
      mode: "cli",
    });
    const [stale] = await situationVerb.run(ctx(dir, { input: "status" }));
    assert.equal((stale.payload as Record<string, unknown>).running, false);

    // stop on a not-running case is a clean ready record, sweeps the stale
    // runtime, and QUEUES the stop — a server mid-start on this case (the TUI
    // page rebinding after a session case switch) honors it on its first tick,
    // while a genuinely fresh serve clears it at start.
    const [stopped] = await situationVerb.run(ctx(dir, { input: "stop" }));
    assert.equal(stopped.state, "ready");
    assert.equal((stopped.payload as Record<string, unknown>).running, false);
    assert.equal(readRuntime(openCase(dir)), undefined);
    assert.equal(readControl(c)?.stop, true, "stop queued as a control patch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation serve losing a port race leaves runtime.json untouched", async () => {
  const { dir } = tmpCase();
  // occupy a port so a serve bind fails (the pre-check passes: no serving runtime)
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  const port = (blocker.address() as AddressInfo).port;
  try {
    const [rec] = await situationVerb.run(ctx(dir, { input: "serve", surface: "cli", opts: { port, "no-open": true } }));
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /already in use/);
    // the loser must NOT have written (or cleared) runtime.json — that write is
    // deferred until AFTER a successful bind, so it can't clobber a winner.
    assert.equal(readRuntime(openCase(dir)), undefined, "loser wrote no runtime");
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation set with no flags is an error (nothing to set)", async () => {
  const { dir } = tmpCase();
  try {
    const [rec] = await situationVerb.run(ctx(dir, { input: "set" }));
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /nothing to set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
