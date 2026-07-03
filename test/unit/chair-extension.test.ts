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

    // /chair qr toggles: hide on the first call, re-show on the second
    await commands.get("chair")?.("qr", ctx);
    assert.equal(widgets.get("chair-qr"), undefined, "first /chair qr hides");
    await commands.get("chair")?.("qr", ctx);
    assert.ok((widgets.get("chair-qr")?.length ?? 0) > 10, "second /chair qr re-shows");

    // bare `/chair on` while running keeps the same bridge (status only)…
    await commands.get("chair")?.("on", ctx);
    assert.equal(handle.bridge(), bridge, "bare on does not restart");
    // …but an explicit --port rebinds: new bridge, old port closed
    const oldUrl = bridge.url;
    await commands.get("chair")?.("on --port 0", ctx);
    const rebound = handle.bridge();
    assert.ok(rebound?.running && rebound !== bridge, "explicit opts restart the bridge");
    await assert.rejects(fetch(oldUrl), /fetch failed/);

    // /chair off closes the port, clears the QR, rotates state
    const url = rebound.url;
    await commands.get("chair")?.("off", ctx);
    assert.match(messages.at(-1) ?? "", /token rotated/);
    assert.equal(handle.bridge(), undefined);
    assert.equal(widgets.get("chair-qr"), undefined);
    assert.equal(handle.footerLabel(), undefined);
    await assert.rejects(fetch(url), /fetch failed/);

    // with a pinned token the off message must not claim rotation
    process.env.OVERCAST_CHAIR_TOKEN = "pinned-secret";
    try {
      await commands.get("chair")?.("on --port 0", ctx);
      await commands.get("chair")?.("off", ctx);
      assert.match(messages.at(-1) ?? "", /pinned via OVERCAST_CHAIR_TOKEN/);
    } finally {
      delete process.env.OVERCAST_CHAIR_TOKEN;
    }

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

    // a real chair injection goes through the agent (increments the pending
    // count); its message_start then classifies as chair and strips the marker
    bridge["agent"].sendUserMessage("check the alley cam");
    await emit("message_start", { message: { role: "user", content: "[chair] check the alley cam" } }, ctx);
    // a desk message that merely *starts with* the marker must NOT be faked as
    // chair (no pending injection) — it stays desk, marker intact
    await emit("message_start", { message: { role: "user", content: "[chair] i typed this at the desk" } }, ctx);
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
        ["desk", "[chair] i typed this at the desk"],
        ["desk", "typed at the desk"],
      ],
    );
    const deltas = published.filter((e) => e.type === "delta");
    assert.equal(deltas.length, 1, "per-token deltas must coalesce");
    assert.equal(deltas[0].text, "the van returns");

    // livePartial accumulates the in-flight assistant text and clears on finalize
    assert.equal(bridge["agent"].livePartial?.(), "the van returns");
    await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "the van returns" }] } }, ctx);
    assert.equal(bridge["agent"].livePartial?.(), "");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autostart is not latched when the bridge fails to bind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-fail-"));
  const prev = { chair: process.env.OVERCAST_CHAIR, bind: process.env.OVERCAST_CHAIR_BIND, port: process.env.OVERCAST_CHAIR_PORT, kase: process.env.OVERCAST_CASE };
  try {
    process.env.OVERCAST_CASE = dir;
    process.env.OVERCAST_CHAIR = "1";
    process.env.OVERCAST_CHAIR_BIND = "203.0.113.1"; // unassignable → EADDRNOTAVAIL
    process.env.OVERCAST_CHAIR_PORT = "0";
    const { pi, emit, commands, messages } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    // first session_start: bind fails, an error is surfaced, no bridge
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(handle.bridge(), undefined);
    assert.match(messages.join("\n"), /could not start/);

    // a later session_start (reload) must retry — the failed attempt didn't latch
    delete process.env.OVERCAST_CHAIR_BIND; // now bindable
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.ok(handle.bridge()?.running, "autostart retries after an earlier failure");
    await commands.get("chair")?.("off", ctx);
  } finally {
    for (const [k, v] of [["OVERCAST_CHAIR", prev.chair], ["OVERCAST_CHAIR_BIND", prev.bind], ["OVERCAST_CHAIR_PORT", prev.port], ["OVERCAST_CASE", prev.kase]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

    // a reload (session_shutdown → session_start) must re-autostart, not stay
    // offline because the first success latched the flag
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    assert.equal(handle.bridge(), undefined, "shutdown stops the bridge");
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.ok(handle.bridge()?.running, "bridge re-autostarts after reload");

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
