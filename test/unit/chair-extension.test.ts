import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChair } from "../../src/extension/chair.ts";
import { openCase } from "../../src/case.ts";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
type EventHandler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler[]>();
  const messages: string[] = [];
  const sent: { text: string; opts?: { deliverAs?: string } }[] = [];
  const flags = new Map<string, boolean | string>();
  const pi = {
    registerMessageRenderer: () => {},
    registerCommand: (name: string, opts: { handler: CommandHandler }) => {
      commands.set(name, opts.handler);
    },
    registerFlag: () => {},
    getFlag: (name: string) => flags.get(name),
    on: (event: string, handler: EventHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
    sendMessage: (message: { details?: { text?: string }; content?: string }) => {
      messages.push(message.details?.text ?? message.content ?? "");
    },
    sendUserMessage: (content: string, opts?: { deliverAs?: string }) => {
      sent.push({ text: content, opts });
    },
  };
  const emit = async (event: string, payload: unknown, ctx: unknown): Promise<void> => {
    for (const handler of events.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi, commands, messages, sent, flags, emit };
}

function fakeCtx(dir: string, overrides: Record<string, unknown> = {}) {
  const widgets = new Map<string, string[] | undefined>();
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    cwd: dir,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    model: { id: "test-model" },
    sessionManager: {
      getSessionName: () => undefined,
      getBranch: () => [],
    },
    ui: {
      notify: (text: string) => {
        notices.push(text);
      },
      setWidget: (key: string, lines: string[] | undefined) => {
        widgets.set(key, lines);
      },
    },
    ...overrides,
  };
  return { ctx, widgets, notices };
}

test("/chair on|status|off lifecycle: real listener, no token leak, no case records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-ext-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, messages, sent } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx, widgets, notices } = fakeCtx(dir);

    assert.equal(handle.footerLabel(), undefined);
    await commands.get("chair")?.("on --port 0", ctx);

    const bridge = handle.bridge();
    assert.ok(bridge?.running, "bridge should be listening");
    const token = bridge.pairingUrl.split("#t=")[1];
    // status text shows the URL but never the token; QR widget carries the pairing
    assert.match(messages.join("\n"), /chair: online at http:\/\/127\.0\.0\.1:/);
    assert.ok(!messages.join("\n").includes(token), "token must not appear in emitted text");
    const qr = widgets.get("chair-qr");
    assert.ok(qr && qr.length > 10, "QR widget shown");
    assert.equal(handle.footerLabel(), `127.0.0.1:${bridge.port} ·0`);

    // a remote prompt is injected with the [chair] attribution + desk notify
    const res = await fetch(`${bridge.url}api/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "run the plate again" }),
    });
    assert.equal(res.status, 202);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, "[chair] run the plate again");
    assert.match(notices.join("\n"), /remote prompt/);

    // /chair off closes the port, clears the QR, rotates state
    const url = bridge.url;
    await commands.get("chair")?.("off", ctx);
    assert.equal(handle.bridge(), undefined);
    assert.equal(widgets.get("chair-qr"), undefined);
    assert.equal(handle.footerLabel(), undefined);
    await assert.rejects(fetch(url), /fetch failed/);

    // chair is operational, not evidence: nothing persisted to the case store
    assert.equal(openCase(dir).records().length, 0);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("event translation: user attribution + coalesced deltas reach the wire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-evt-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, emit } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);
    await commands.get("chair")?.("on --port 0", ctx);
    const bridge = handle.bridge()!;

    const published: Record<string, unknown>[] = [];
    const orig = bridge.publish.bind(bridge);
    (bridge as unknown as { publish: typeof bridge.publish }).publish = (evt) => {
      published.push(evt as Record<string, unknown>);
      orig(evt);
    };

    await emit("message_start", { message: { role: "user", content: "[chair] check the alley cam" } }, ctx);
    await emit("message_start", { message: { role: "user", content: "typed at the desk" } }, ctx);
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "the van " } }, ctx);
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "returns" } }, ctx);
    await new Promise((r) => setTimeout(r, 80)); // > coalescer flush window
    await emit("agent_end", { messages: [] }, ctx);

    const users = published.filter((e) => e.type === "message" && e.role === "user");
    assert.deepEqual(
      users.map((u) => [u.source, u.text]),
      [
        ["chair", "check the alley cam"],
        ["desk", "typed at the desk"],
      ],
    );
    const deltas = published.filter((e) => e.type === "delta");
    assert.equal(deltas.length, 1, "per-token deltas must coalesce");
    assert.equal(deltas[0].text, "the van returns");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OVERCAST_CHAIR=1 auto-starts the bridge on session_start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-auto-"));
  const prev = { chair: process.env.OVERCAST_CHAIR, port: process.env.OVERCAST_CHAIR_PORT, kase: process.env.OVERCAST_CASE };
  try {
    process.env.OVERCAST_CASE = dir;
    process.env.OVERCAST_CHAIR = "1";
    process.env.OVERCAST_CHAIR_PORT = "0";
    const { pi, emit, commands } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.ok(handle.bridge()?.running, "bridge should auto-start");
    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prev.chair === undefined) delete process.env.OVERCAST_CHAIR;
    else process.env.OVERCAST_CHAIR = prev.chair;
    if (prev.port === undefined) delete process.env.OVERCAST_CHAIR_PORT;
    else process.env.OVERCAST_CHAIR_PORT = prev.port;
    if (prev.kase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prev.kase;
    rmSync(dir, { recursive: true, force: true });
  }
});
