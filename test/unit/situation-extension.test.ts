// /situation (TUI extension) — the case-switch rebind behavior (Bugbot #98):
// the in-process page must FOLLOW the session's case, honor a stop queued on
// the new case instead of restarting over it, and drop the old case's
// view-config (panels/source are case-scoped) on rebind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSituation } from "../../src/extension/situation.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { situationVerb } from "../../src/verbs/situation.ts";
import { readControl, readRuntime, writeControl, situationDir } from "../../src/situation/state.ts";
import type { VerbContext } from "../../src/registry/types.ts";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
type EventHandler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler[]>();
  const messages: string[] = [];
  const flags = new Map<string, boolean | string>();
  const pi = {
    registerMessageRenderer: () => {},
    registerCommand: (name: string, o: { handler: CommandHandler }) => {
      commands.set(name, o.handler);
    },
    registerFlag: () => {},
    getFlag: (name: string) => flags.get(name),
    on: (event: string, handler: EventHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    sendMessage: (message: { details?: { text?: string }; content?: string }) => {
      messages.push(message.details?.text ?? message.content ?? "");
    },
  };
  const emit = async (event: string, payload: unknown, ctx: unknown): Promise<void> => {
    for (const handler of events.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi, commands, messages, flags, emit };
}

function fakeCtx(dir: string) {
  return {
    mode: "tui",
    cwd: dir,
    ui: { setWidget: () => {}, notify: () => {} },
  };
}

function tmpCase(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  openCase(dir).ensure();
  return dir;
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function verbCtx(dir: string, over: Partial<VerbContext> = {}): VerbContext {
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
    surface: "agent",
    ...over,
  };
}

test("situation rebind honors a stop it can SEE, even with a blocked patch behind it", () => {
  // readControl returns the applyable prefix; a stop inside it is one the
  // server's tick can also see. Gating on "is anything further down unreadable"
  // makes the page start and get stopped a moment later — a flash-start.
  const dir = mkdtempSync(join(tmpdir(), "oc-sitrebind-"));
  let blocker: string | undefined;
  try {
    const c = openCase(dir);
    c.ensure();
    writeControl(c, { stop: true }); // visible in the prefix
    const cdir = join(situationDir(c), "control.d");
    const firstMs = Number(readdirSync(cdir)[0].split("-")[0]);
    blocker = join(cdir, `${String(firstMs + 1).padStart(15, "0")}-000001-0-blocked.json`);
    writeFileSync(blocker, JSON.stringify({ limit: 9 }), "utf8");
    chmodSync(blocker, 0o000); // unreadable, but AFTER the stop

    assert.equal(readControl(c)?.stop, true, "the stop is still visible in the applyable prefix");
  } finally {
    if (blocker) { try { chmodSync(blocker, 0o600); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case-switch rebind honors a stop queued on the new case (no restart over it)", async () => {
  const dirA = tmpCase("oc-situation-ext-a-");
  const dirB = tmpCase("oc-situation-ext-b-");
  const prevCase = process.env.OVERCAST_CASE;
  delete process.env.OVERCAST_CASE; // the case must follow ctx.cwd
  const { pi, commands, emit } = fakePi();
  const handle = registerSituation(pi as never);
  try {
    await commands.get("situation")?.("on --port 0 --no-open", fakeCtx(dirA));
    assert.ok(handle.server()?.running, "page up on case A");
    assert.ok(readRuntime(openCase(dirA)), "runtime stamped in case A");

    // a `situation stop` landed on case B BEFORE the extension noticed the
    // switch (the desync window) — the rebind must honor it, not restart.
    writeControl(openCase(dirB), { stop: true });
    await emit("turn_start", {}, fakeCtx(dirB));
    // runtime clears only AFTER the listener closes (deliberate ordering), so
    // wait for that — the last step of the stop — not just server() clearing.
    await until(() => handle.server() === undefined && readRuntime(openCase(dirA)) === undefined);

    assert.equal(readControl(openCase(dirB))?.stop, undefined, "pending stop consumed");
    assert.equal(readRuntime(openCase(dirB)), undefined, "no server restarted on case B");
  } finally {
    await emit("session_shutdown", {}, fakeCtx(dirB));
    if (prevCase !== undefined) process.env.OVERCAST_CASE = prevCase;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("agent-tool set/stop steer the in-process page's BOUND case, not the session case", async () => {
  const dirA = tmpCase("oc-situation-ext-a-");
  const dirB = tmpCase("oc-situation-ext-b-");
  const prevCase = process.env.OVERCAST_CASE;
  delete process.env.OVERCAST_CASE;
  const { pi, commands, emit } = fakePi();
  const handle = registerSituation(pi as never);
  try {
    await commands.get("situation")?.("on --port 0 --no-open", fakeCtx(dirA));
    assert.ok(handle.server()?.running, "page up on case A");

    // the agent runs `situation set` with the SESSION case (B) in the desync
    // window — the in-process seam must steer the bound case (A) instead.
    const [setRec] = await situationVerb.run(verbCtx(dirB, { input: "set", opts: { source: "webcam" } }));
    assert.equal(setRec.state, "ready");
    assert.equal((setRec.payload as Record<string, unknown>).steered_case, openCase(dirA).dir, "set reports the steered case");
    assert.equal(readControl(openCase(dirA))?.source, "webcam", "control written to the bound case");
    assert.equal(readControl(openCase(dirB)), undefined, "nothing written to the session case");
    assert.equal((setRec.payload as Record<string, unknown>).running, true, "set sees the live page");

    // `situation stop` from the agent (session case B) reaches the live page too
    const [stopRec] = await situationVerb.run(verbCtx(dirB, { input: "stop" }));
    assert.equal((stopRec.payload as Record<string, unknown>).running, true, "stop sees the live page");
    await until(() => handle.server() === undefined && readRuntime(openCase(dirA)) === undefined);
  } finally {
    await emit("session_shutdown", {}, fakeCtx(dirA));
    if (prevCase !== undefined) process.env.OVERCAST_CASE = prevCase;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("case-switch rebind follows the session case and resets the case-scoped view config", async () => {
  const dirA = tmpCase("oc-situation-ext-a-");
  const dirB = tmpCase("oc-situation-ext-b-");
  const prevCase = process.env.OVERCAST_CASE;
  delete process.env.OVERCAST_CASE;
  const { pi, commands, emit } = fakePi();
  const handle = registerSituation(pi as never);
  try {
    await commands.get("situation")?.("on --port 0 --no-open --panels wall --source youtube", fakeCtx(dirA));
    assert.ok(handle.server()?.running, "page up on case A");
    assert.deepEqual(handle.server()?.activeConfig.panels, ["wall"]);
    assert.equal(handle.server()?.activeConfig.source, "youtube");
    const first = handle.server();

    await emit("tool_execution_end", {}, fakeCtx(dirB));
    await until(() => handle.server() !== undefined && handle.server() !== first && handle.server()!.running);

    // rebound to case B: runtime moved, and the OLD case's panels/source
    // filters did not leak onto the new case's page (config reset to auto).
    assert.equal(readRuntime(openCase(dirA)), undefined, "case A runtime cleared");
    assert.equal(readRuntime(openCase(dirB))?.pid, process.pid, "runtime stamped in case B");
    assert.equal(handle.server()?.activeConfig.panels, undefined, "panels reset on rebind");
    assert.equal(handle.server()?.activeConfig.source, undefined, "source filter reset on rebind");
  } finally {
    await emit("session_shutdown", {}, fakeCtx(dirB));
    if (prevCase !== undefined) process.env.OVERCAST_CASE = prevCase;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});
