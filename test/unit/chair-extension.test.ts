import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { registerChair } from "../../src/extension/chair.ts";
import { openCase } from "../../src/case.ts";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
type EventHandler = (event: unknown, ctx: unknown) => unknown;

function fakePi(opts: { throwOnSend?: boolean } = {}) {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler[]>();
  const messages: string[] = [];
  const sent: { text: string; opts?: { deliverAs?: string } }[] = [];
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
    sendUserMessage: (content: string, o?: { deliverAs?: string }) => {
      if (opts.throwOnSend) throw new Error("send failed");
      sent.push({ text: content, opts: o });
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

    // livePartial holds the published in-flight text, then clears on finalize.
    // Real ordering is message_end(assistant) → agent_end.
    assert.equal(bridge["agent"].livePartial?.(), "the van returns");
    await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "the van returns" }] } }, ctx);
    await emit("agent_end", { messages: [] }, ctx);
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

test("remote injection is prefixed so it can never be a slash command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-slashguard-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, sent } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);
    await commands.get("chair")?.("on --port 0", ctx);

    // even a phone prompt that looks exactly like a slash command…
    handle.bridge()!["agent"].sendUserMessage("/brief --export x.html");
    handle.bridge()!["agent"].sendUserMessage("/model opus");
    // …is prefixed, so the text handed to pi never starts with "/" (and pi's
    // sendUserMessage forces expandPromptTemplates:false regardless)
    assert.deepEqual(
      sent.map((s) => s.text),
      ["[chair] /brief --export x.html", "[chair] /model opus"],
    );
    for (const s of sent) assert.ok(!s.text.startsWith("/"), "injected text must not start with /");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed chair injection does not inflate the pending count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-sendfail-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, emit } = fakePi({ throwOnSend: true });
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

    // the injection throws (pi.sendUserMessage fails) → count must roll back
    assert.throws(() => bridge["agent"].sendUserMessage("dropped remote prompt"));
    // so a desk message that starts with the marker is NOT misattributed as chair
    await emit("message_start", { message: { role: "user", content: "[chair] typed at the desk" } }, ctx);
    const user = published.find((e) => e.type === "message" && e.role === "user");
    assert.equal(user?.source, "desk");
    assert.equal(user?.text, "[chair] typed at the desk");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy + running tools reflect an active loop even when ctx.isIdle() is true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-busy-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, emit } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir); // fakeCtx.isIdle() always returns true
    await commands.get("chair")?.("on --port 0", ctx);
    const bridge = handle.bridge()!;
    const agent = bridge["agent"];
    const published: Record<string, unknown>[] = [];
    const orig = bridge.publish.bind(bridge);
    (bridge as unknown as { publish: typeof bridge.publish }).publish = (evt) => {
      published.push(evt as Record<string, unknown>);
      orig(evt);
    };

    // truly idle
    assert.equal(agent.isIdle(), true);

    // agent loop is active (tools may run while ctx.isIdle() is still true)
    await emit("agent_start", { messages: [] }, ctx);
    await emit("tool_execution_start", { toolCallId: "t1", toolName: "watch", args: { clip: "n.mp4" } }, ctx);
    assert.equal(agent.isIdle(), false, "an active loop reads as busy");
    assert.deepEqual(agent.runningTools?.(), [{ toolCallId: "t1", name: "watch", argsSummary: "clip=n.mp4" }]);

    // a model change mid-run must publish busy=true (not raw ctx.isIdle())
    await emit("model_select", { model: { id: "claude-x" } }, ctx);
    const stateEvt = published.filter((e) => e.type === "state").at(-1);
    assert.equal(stateEvt?.busy, true, "model_select busy reflects the active loop");

    // a remote auto prompt during the run must steer, not start a fresh turn
    const res = await fetch(`${handle.bridge()!.url}api/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.bridge()!.pairingUrl.split("#t=")[1]}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "focus the plate" }),
    });
    assert.deepEqual(await res.json(), { delivered: "steer" });

    // run ends → idle again, running tools cleared
    await emit("tool_execution_end", { toolCallId: "t1", toolName: "watch", isError: false }, ctx);
    await emit("agent_end", { messages: [] }, ctx);
    assert.equal(agent.isIdle(), true);
    assert.deepEqual(agent.runningTools?.(), []);

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reload reuses the pairing token (phone stays paired) and rotates it only on /chair off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-tokenreuse-"));
  const prev = { chair: process.env.OVERCAST_CHAIR, port: process.env.OVERCAST_CHAIR_PORT, kase: process.env.OVERCAST_CASE };
  try {
    process.env.OVERCAST_CASE = dir;
    process.env.OVERCAST_CHAIR = "1";
    process.env.OVERCAST_CHAIR_PORT = "0";
    const { pi, emit, commands } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);
    const tok = () => handle.bridge()!.pairingUrl.split("#t=")[1];

    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const t1 = tok();

    // a reload restarts the bridge with the SAME token → the phone stays paired
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.equal(tok(), t1, "token reused across a reload");

    // /chair off rotates it: the next /chair on mints a different token
    await commands.get("chair")?.("off", ctx);
    await commands.get("chair")?.("on --port 0", ctx);
    assert.notEqual(tok(), t1, "token rotated after /chair off");

    await commands.get("chair")?.("off", ctx);
  } finally {
    for (const [k, v] of [["OVERCAST_CHAIR", prev.chair], ["OVERCAST_CHAIR_PORT", prev.port], ["OVERCAST_CASE", prev.kase]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed rebind restores the previous bridge (control not lost)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-rebindfail-"));
  const prevCase = process.env.OVERCAST_CASE;
  const prevChair = process.env.OVERCAST_CHAIR;
  let blocker: Server | undefined;
  try {
    process.env.OVERCAST_CASE = dir;
    delete process.env.OVERCAST_CHAIR;
    const { pi, commands, messages } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await commands.get("chair")?.("on --port 0", ctx);
    const port1 = handle.bridge()!.port;
    const token1 = handle.bridge()!.pairingUrl.split("#t=")[1];

    // occupy a port so a rebind to it collides (EADDRINUSE)
    blocker = createServer();
    await new Promise<void>((r) => blocker!.listen(0, "127.0.0.1", () => r()));
    const taken = (blocker.address() as { port: number }).port;

    // rebind to the taken port fails → the previous listener must be restored
    await commands.get("chair")?.(`on --port ${taken}`, ctx);
    assert.ok(handle.bridge()?.running, "bridge is still online after a failed rebind");
    assert.equal(handle.bridge()!.port, port1, "restored to the previous port");
    assert.equal(handle.bridge()!.pairingUrl.split("#t=")[1], token1, "same token (phone stays paired)");
    assert.match(messages.at(-1) ?? "", /rebind failed.*kept the previous bind/);

    await commands.get("chair")?.("off", ctx);
  } finally {
    blocker?.close();
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    if (prevChair === undefined) delete process.env.OVERCAST_CHAIR;
    else process.env.OVERCAST_CHAIR = prevChair;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reload that races shutdown against start does not EADDRINUSE (stays online)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-race-"));
  const prev = { chair: process.env.OVERCAST_CHAIR, port: process.env.OVERCAST_CHAIR_PORT, kase: process.env.OVERCAST_CASE };
  try {
    process.env.OVERCAST_CASE = dir;
    process.env.OVERCAST_CHAIR = "1";
    // pin a fixed port so a racing rebind would collide if not serialized
    const fixed = 8100 + Math.floor(process.pid % 400);
    process.env.OVERCAST_CHAIR_PORT = String(fixed);
    const { pi, emit, commands } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(handle.bridge()!.port, fixed);

    // fire session_start WITHOUT awaiting session_shutdown's stop — the restart
    // must wait for the port to be released rather than binding a still-held port
    const shutdownP = emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    await shutdownP;

    assert.ok(handle.bridge()?.running, "bridge is online after a raced reload");
    assert.equal(handle.bridge()!.port, fixed, "rebound to the same fixed port");

    await commands.get("chair")?.("off", ctx);
  } finally {
    for (const [k, v] of [["OVERCAST_CHAIR", prev.chair], ["OVERCAST_CHAIR_PORT", prev.port], ["OVERCAST_CASE", prev.kase]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload keeps the concrete bound port (ephemeral 0 doesn't drift)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-ephport-"));
  const prevCase = process.env.OVERCAST_CASE;
  const prevChair = process.env.OVERCAST_CHAIR;
  try {
    process.env.OVERCAST_CASE = dir;
    delete process.env.OVERCAST_CHAIR;
    const { pi, emit, commands } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await commands.get("chair")?.("on --port 0", ctx); // ephemeral
    const port1 = handle.bridge()!.port;
    assert.ok(port1 > 0, "got a real ephemeral port");

    // a reload must rebind to that SAME port (the phone's URL still works),
    // not replay port 0 and land on a fresh ephemeral port
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.equal(handle.bridge()!.port, port1, "reload reuses the concrete port");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    if (prevChair === undefined) delete process.env.OVERCAST_CHAIR;
    else process.env.OVERCAST_CHAIR = prevChair;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a port-only rebind keeps the current bind (tailnet/explicit not reset to localhost)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-bindkeep-"));
  const prevCase = process.env.OVERCAST_CASE;
  const prevChair = process.env.OVERCAST_CHAIR;
  try {
    process.env.OVERCAST_CASE = dir;
    delete process.env.OVERCAST_CHAIR;
    const { pi, emit, commands } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    // explicit non-default bind (0.0.0.0 stands in for a tailnet address)
    await commands.get("chair")?.("on --bind 0.0.0.0 --port 0", ctx);
    assert.equal(handle.bridge()!.bind, "0.0.0.0");

    // a later port-only rebind must NOT drop back to 127.0.0.1
    await commands.get("chair")?.("on --port 0", ctx);
    assert.equal(handle.bridge()!.bind, "0.0.0.0", "port-only rebind keeps the bind");

    // and a reload keeps it too
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.equal(handle.bridge()!.bind, "0.0.0.0", "reload keeps the bind");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    if (prevChair === undefined) delete process.env.OVERCAST_CHAIR;
    else process.env.OVERCAST_CHAIR = prevChair;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a manually-started /chair on survives a reload (no env/flag)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-manualreload-"));
  const prevCase = process.env.OVERCAST_CASE;
  const prevChair = process.env.OVERCAST_CHAIR;
  try {
    process.env.OVERCAST_CASE = dir;
    delete process.env.OVERCAST_CHAIR; // desk-only start, no autostart config
    const { pi, emit, commands } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.equal(handle.bridge(), undefined, "no autostart without env/flag");

    // operator starts it manually…
    await commands.get("chair")?.("on --port 0", ctx);
    const t1 = handle.bridge()!.pairingUrl.split("#t=")[1];

    // …and a reload keeps it running with the same token (was previously lost)
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.ok(handle.bridge()?.running, "manual /chair on survives a reload");
    assert.equal(handle.bridge()!.pairingUrl.split("#t=")[1], t1, "same token after reload");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    if (prevChair === undefined) delete process.env.OVERCAST_CHAIR;
    else process.env.OVERCAST_CHAIR = prevChair;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mid-run reload does not carry ghost busy/runningTools into the next session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-midreload-"));
  const prev = { chair: process.env.OVERCAST_CHAIR, port: process.env.OVERCAST_CHAIR_PORT, kase: process.env.OVERCAST_CASE };
  try {
    process.env.OVERCAST_CASE = dir;
    process.env.OVERCAST_CHAIR = "1";
    process.env.OVERCAST_CHAIR_PORT = "0";
    const { pi, emit } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    // a run is in progress with a tool executing…
    await emit("agent_start", { messages: [] }, ctx);
    await emit("tool_execution_start", { toolCallId: "t9", toolName: "scan", args: {} }, ctx);
    assert.equal(handle.bridge()!["agent"].isIdle(), false);

    // …then the session reloads mid-run (agent_end / tool end never fire)
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);

    // the new autostarted bridge must report a clean, idle session
    const agent = handle.bridge()!["agent"];
    assert.equal(agent.isIdle(), true, "no ghost busy after mid-run reload");
    assert.deepEqual(agent.runningTools?.(), [], "no ghost running tools after reload");

    // and a remote auto prompt now correctly starts a fresh turn, not a steer
    const res = await fetch(`${handle.bridge()!.url}api/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.bridge()!.pairingUrl.split("#t=")[1]}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "start fresh" }),
    });
    assert.deepEqual(await res.json(), { delivered: "turn" });

    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    for (const [k, v] of [["OVERCAST_CHAIR", prev.chair], ["OVERCAST_CHAIR_PORT", prev.port], ["OVERCAST_CASE", prev.kase]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desk [chair] message interleaved with a pending injection stays desk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-interleave-"));
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

    // a real chair injection is pending its message_start…
    bridge["agent"].sendUserMessage("scan the north gate");
    // …but a desk message that also starts with the marker arrives FIRST. With a
    // blind counter it would steal the slot; content-matching keeps it desk.
    await emit("message_start", { message: { role: "user", content: "[chair] not from the phone" } }, ctx);
    // then the actual injected message arrives and matches exactly → chair
    await emit("message_start", { message: { role: "user", content: "[chair] scan the north gate" } }, ctx);

    const users = published.filter((e) => e.type === "message" && e.role === "user");
    assert.deepEqual(
      users.map((u) => [u.source, u.text]),
      [
        ["desk", "[chair] not from the phone"],
        ["chair", "scan the north gate"],
      ],
    );
    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/chair off keeps the bridge off across reloads until an explicit /chair on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-optout-"));
  const prev = { chair: process.env.OVERCAST_CHAIR, port: process.env.OVERCAST_CHAIR_PORT, kase: process.env.OVERCAST_CASE };
  try {
    process.env.OVERCAST_CASE = dir;
    process.env.OVERCAST_CHAIR = "1";
    process.env.OVERCAST_CHAIR_PORT = "0";
    const { pi, emit, commands } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    assert.ok(handle.bridge()?.running, "autostart on launch");

    // operator explicitly turns it off
    await commands.get("chair")?.("off", ctx);
    assert.equal(handle.bridge(), undefined);

    // a reload must NOT reopen remote control despite OVERCAST_CHAIR=1
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.equal(handle.bridge(), undefined, "off intent survives reload");

    // an explicit /chair on re-enables (and clears the opt-out for future reloads)
    await commands.get("chair")?.("on --port 0", ctx);
    assert.ok(handle.bridge()?.running, "explicit /chair on restarts");
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
    await emit("session_start", { type: "session_start", reason: "reload" }, ctx);
    assert.ok(handle.bridge()?.running, "autostart resumes after re-enable");

    await commands.get("chair")?.("off", ctx);
  } finally {
    for (const [k, v] of [["OVERCAST_CHAIR", prev.chair], ["OVERCAST_CHAIR_PORT", prev.port], ["OVERCAST_CASE", prev.kase]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aborted run (agent_end without message_end) leaves no ghost live", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-abort-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, emit } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);
    await commands.get("chair")?.("on --port 0", ctx);
    const agent = handle.bridge()!["agent"];

    await emit("message_start", { message: { role: "assistant", content: [] } }, ctx);
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "half a thought" } }, ctx);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(agent.livePartial?.(), "half a thought");

    // abort: agent_end fires but the assistant message_end never does
    await emit("agent_end", { messages: [] }, ctx);
    assert.equal(agent.livePartial?.(), "", "aborted run must not leave a partial live line");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pending chair injection does not carry across /chair off → on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-pendreset-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, emit } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await commands.get("chair")?.("on --port 0", ctx);
    // inject a remote prompt but stop before its message_start arrives
    handle.bridge()!["agent"].sendUserMessage("in-flight prompt");
    await commands.get("chair")?.("off", ctx);
    await commands.get("chair")?.("on --port 0", ctx);

    const bridge = handle.bridge()!;
    const published: Record<string, unknown>[] = [];
    const orig = bridge.publish.bind(bridge);
    (bridge as unknown as { publish: typeof bridge.publish }).publish = (evt) => {
      published.push(evt as Record<string, unknown>);
      orig(evt);
    };
    // the stale count was cleared on stop → this desk message stays desk
    await emit("message_start", { message: { role: "user", content: "[chair] desk after restart" } }, ctx);
    const user = published.find((e) => e.type === "message" && e.role === "user");
    assert.equal(user?.source, "desk");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream buffers reset across a mid-stream /chair off → on (no stale/ghost text)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-reset-"));
  const prevCase = process.env.OVERCAST_CASE;
  try {
    process.env.OVERCAST_CASE = dir;
    const { pi, commands, emit } = fakePi();
    const handle = registerChair(pi as never);
    const { ctx } = fakeCtx(dir);

    await commands.get("chair")?.("on --port 0", ctx);
    // an assistant streams, we flush, so livePartial holds published text
    await emit("message_start", { message: { role: "assistant", content: [] } }, ctx);
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "stale text" } }, ctx);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(handle.bridge()!["agent"].livePartial?.(), "stale text");

    // stop mid-stream: livePartial + buffers must be dropped
    await commands.get("chair")?.("off", ctx);

    // deltas that arrive while offline must NOT be buffered
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: " LEAK" } }, ctx);
    await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "stale text LEAK" }] } }, ctx);

    // a fresh bridge must not surface a ghost `live`, and a new stream is clean
    await commands.get("chair")?.("on --port 0", ctx);
    const bridge = handle.bridge()!;
    assert.equal(bridge["agent"].livePartial?.(), "", "no ghost live after restart");
    await emit("message_start", { message: { role: "assistant", content: [] } }, ctx);
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "fresh" } }, ctx);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(bridge["agent"].livePartial?.(), "fresh", "new stream carries only new text");

    await commands.get("chair")?.("off", ctx);
  } finally {
    if (prevCase === undefined) delete process.env.OVERCAST_CASE;
    else process.env.OVERCAST_CASE = prevCase;
    rmSync(dir, { recursive: true, force: true });
  }
});
