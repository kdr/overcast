// /situation (TUI extension) — the case-switch rebind behavior (Bugbot #98):
// the in-process page must FOLLOW the session's case, honor a stop queued on
// the new case instead of restarting over it, and drop the old case's
// view-config (panels/source are case-scoped) on rebind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSituation } from "../../src/extension/situation.ts";
import { openCase } from "../../src/case.ts";
import { readControl, readRuntime, writeControl } from "../../src/situation/state.ts";

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

    assert.equal(readControl(openCase(dirB))?.control.stop, undefined, "pending stop consumed");
    assert.equal(readRuntime(openCase(dirB)), undefined, "no server restarted on case B");
  } finally {
    await emit("session_shutdown", {}, fakeCtx(dirB));
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
