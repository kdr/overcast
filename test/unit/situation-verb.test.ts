import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { situationVerb } from "../../src/verbs/situation.ts";
import { findVerb } from "../../src/registry/verbs.ts";
import { OPERATIONAL_VERBS } from "../../src/record.ts";
import { readControl, readRuntime, writeRuntime } from "../../src/situation/state.ts";
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
    const ctl = readControl(c)?.control;
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
    assert.equal(readControl(c)?.control.stop, true, "stop queued in control.json");
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
