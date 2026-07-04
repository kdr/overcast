import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChairBridge, type ChairAgent } from "../../src/chair/bridge.ts";
import type { CaseGlance } from "../../src/chair/wire.ts";

const GLANCE: CaseGlance = {
  caseName: "tc",
  dir: "/tmp/tc",
  records: 0,
  counts: {},
  targets: [],
  sources: [],
  openFindings: [],
  latest: [],
};

function fakeAgent(overrides: Partial<ChairAgent> = {}) {
  const calls = {
    sent: [] as { text: string; opts?: { deliverAs?: string } }[],
    aborts: 0,
    notified: [] as string[],
  };
  const agent: ChairAgent = {
    isIdle: () => true,
    hasPending: () => false,
    abort: () => {
      calls.aborts++;
    },
    sendUserMessage: (text, opts) => {
      calls.sent.push({ text, opts });
    },
    model: () => "test-model",
    sessionName: () => "case session",
    caseName: () => "tc",
    caseDir: () => "/tmp/tc",
    transcript: () => [{ role: "user", text: "hello", source: "desk" }],
    caseGlance: () => GLANCE,
    onRemotePrompt: (info) => {
      calls.notified.push(info.mode);
    },
    ...overrides,
  };
  return { agent, calls };
}

function makeBridge(agent: ChairAgent, extra: Partial<ConstructorParameters<typeof ChairBridge>[0]> = {}) {
  return new ChairBridge({
    agent,
    profile: "default",
    version: "0.0.0-test",
    port: 0,
    ...extra,
  });
}

interface SseFrame {
  id?: number;
  data: Record<string, unknown>;
}

/** Incremental SSE consumer: one persistent reader per connection. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pending: SseFrame[] = [];
  return {
    async next(n: number, timeoutMs = 2000): Promise<SseFrame[]> {
      const out: SseFrame[] = [];
      const deadline = Date.now() + timeoutMs;
      while (out.length < n && Date.now() < deadline) {
        while (pending.length && out.length < n) out.push(pending.shift()!);
        if (out.length >= n) break;
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sse timeout")), deadline - Date.now())),
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue; // comment/heartbeat
          const idLine = frame.split("\n").find((l) => l.startsWith("id: "));
          pending.push({
            id: idLine ? Number(idLine.slice(4)) : undefined,
            data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
          });
        }
      }
      while (pending.length && out.length < n) out.push(pending.shift()!);
      return out;
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => {});
    },
  };
}

test("chair bridge: auth is required everywhere except static assets", async () => {
  const { agent } = fakeAgent();
  const bridge = makeBridge(agent);
  const { url, pairingUrl } = await bridge.start();
  try {
    const token = pairingUrl.split("#t=")[1];
    // no token → 401 on api + events
    for (const path of ["api/state", "api/case", "events"]) {
      const res = await fetch(url + path);
      assert.equal(res.status, 401, path);
    }
    // wrong token → 401
    const bad = await fetch(`${url}api/state`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(bad.status, 401);
    // right token → 200 (header + query forms)
    const good = await fetch(`${url}api/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(good.status, 200);
    const viaQuery = await fetch(`${url}events?token=${token}`);
    assert.equal(viaQuery.status, 200);
    await viaQuery.body?.cancel();
    // static shell is served without auth but never contains the token
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(!html.includes(token), "token must not leak into the page");
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: snapshot + case glance shapes", async () => {
  const { agent } = fakeAgent();
  const bridge = makeBridge(agent);
  const { url, pairingUrl } = await bridge.start();
  const token = pairingUrl.split("#t=")[1];
  try {
    const auth = { Authorization: `Bearer ${token}` };
    const snap = (await (await fetch(`${url}api/state`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal(snap.caseName, "tc");
    assert.equal(snap.busy, false);
    assert.equal(snap.model, "test-model");
    assert.equal(snap.version, "0.0.0-test");
    assert.deepEqual(snap.transcript, [{ role: "user", text: "hello", source: "desk" }]);
    assert.equal("live" in snap, false, "no live field when idle");
    const glance = (await (await fetch(`${url}api/case`, { headers: auth })).json()) as CaseGlance;
    assert.equal(glance.caseName, "tc");
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: snapshot reflects a live case change (not frozen at start)", async () => {
  let name = "case-a";
  let dir = "/tmp/case-a";
  const { agent } = fakeAgent({ caseName: () => name, caseDir: () => dir });
  const bridge = makeBridge(agent);
  const { url, pairingUrl } = await bridge.start();
  const token = pairingUrl.split("#t=")[1];
  const state = () => fetch(`${url}api/state`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<Record<string, unknown>>);
  try {
    let snap = await state();
    assert.equal(snap.caseName, "case-a");
    assert.equal(snap.caseDir, "/tmp/case-a");
    // the desk switches case while the bridge keeps running
    name = "case-b";
    dir = "/tmp/case-b";
    snap = await state();
    assert.equal(snap.caseName, "case-b");
    assert.equal(snap.caseDir, "/tmp/case-b");
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: snapshot carries in-flight assistant text (live)", async () => {
  const { agent } = fakeAgent({ livePartial: () => "the van ret" });
  const bridge = makeBridge(agent);
  const { url, pairingUrl } = await bridge.start();
  const token = pairingUrl.split("#t=")[1];
  try {
    const snap = (await (await fetch(`${url}api/state`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>;
    assert.equal(snap.live, "the van ret");
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: snapshot carries in-flight tools (runningTools)", async () => {
  const running = [{ toolCallId: "t1", name: "watch", argsSummary: "clip=north.mp4" }];
  const { agent } = fakeAgent({ runningTools: () => running });
  const bridge = makeBridge(agent);
  const { url, pairingUrl } = await bridge.start();
  const token = pairingUrl.split("#t=")[1];
  try {
    const snap = (await (await fetch(`${url}api/state`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>;
    assert.deepEqual(snap.runningTools, running);
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: a dead SSE client can't break publish for others", async () => {
  const { agent } = fakeAgent();
  const bridge = makeBridge(agent);
  const { url, pairingUrl } = await bridge.start();
  const token = pairingUrl.split("#t=")[1];
  try {
    // one healthy client
    const live = sseReader(await fetch(`${url}events?token=${token}`));
    await live.next(1); // hello
    assert.equal(bridge.clientCount(), 1);

    // a client that connects then abruptly drops its socket mid-stream
    const controller = new AbortController();
    await fetch(`${url}events?token=${token}`, { signal: controller.signal }).then((r) => r.body?.getReader().read());
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));

    // publishing must not throw even if a half-closed client is still in the set
    assert.doesNotThrow(() => bridge.publish({ type: "notice", level: "info", text: "still alive" }));
    const frame = await live.next(1);
    assert.equal(frame[0].data.text, "still alive");
    await live.close();
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: prompt routing (idle turn, busy steer/followUp) + abort", async () => {
  let idle = true;
  let pending = false;
  const { agent, calls } = fakeAgent({ isIdle: () => idle, hasPending: () => pending });
  const bridge = makeBridge(agent);
  const { url, pairingUrl } = await bridge.start();
  const token = pairingUrl.split("#t=")[1];
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const prompt = (body: unknown) => fetch(`${url}api/prompt`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  try {
    // idle → fresh turn, no deliverAs
    let res = await prompt({ text: "look into the van" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { delivered: "turn" });
    assert.deepEqual(calls.sent[0], { text: "look into the van", opts: undefined });

    // idle BUT pending follow-ups queued → followUp, not a competing fresh turn
    pending = true;
    res = await prompt({ text: "and the plate too" });
    assert.deepEqual(await res.json(), { delivered: "followUp" });
    assert.deepEqual(calls.sent[1].opts, { deliverAs: "followUp" });
    pending = false;

    // idle + an EXPLICIT followUp mode → honored (not silently downgraded to turn)
    res = await prompt({ text: "queue this for after", mode: "followUp" });
    assert.deepEqual(await res.json(), { delivered: "followUp" });
    assert.deepEqual(calls.sent[2].opts, { deliverAs: "followUp" });

    // busy + auto → steer; busy + followUp → followUp
    idle = false;
    res = await prompt({ text: "wrong plate" });
    assert.deepEqual(await res.json(), { delivered: "steer" });
    assert.deepEqual(calls.sent[3].opts, { deliverAs: "steer" });
    res = await prompt({ text: "afterwards run a brief", mode: "followUp" });
    assert.deepEqual(await res.json(), { delivered: "followUp" });
    assert.deepEqual(calls.sent[4].opts, { deliverAs: "followUp" });
    assert.deepEqual(calls.notified, ["turn", "followUp", "followUp", "steer", "followUp"]);

    // validation
    assert.equal((await prompt({ text: "" })).status, 400);
    assert.equal((await prompt({ text: "x", mode: "bogus" })).status, 400);
    assert.equal((await prompt({ text: "y".repeat(17 * 1024) })).status, 413);

    // abort
    const abort = await fetch(`${url}api/abort`, { method: "POST", headers: auth });
    assert.equal(abort.status, 200);
    assert.equal(calls.aborts, 1);

    // cross-origin POST is rejected even with a valid token
    const forged = await fetch(`${url}api/abort`, { method: "POST", headers: { ...auth, Origin: "https://evil.example" } });
    assert.equal(forged.status, 403);
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: SSE stream, replay, and gap", async () => {
  const { agent } = fakeAgent();
  const bridge = makeBridge(agent, { ringSize: 3 });
  const { url, pairingUrl } = await bridge.start();
  const token = pairingUrl.split("#t=")[1];
  try {
    // live delivery: connect, then publish
    const live = sseReader(await fetch(`${url}events?token=${token}`));
    assert.equal((await live.next(1))[0].data.type, "hello");
    bridge.publish({ type: "notice", level: "info", text: "one" });
    const next = await live.next(1);
    assert.equal(next[0].data.text, "one");
    assert.equal(next[0].id, 1);
    await live.close();

    bridge.publish({ type: "notice", level: "info", text: "two" });
    bridge.publish({ type: "notice", level: "info", text: "three" });

    // reconnect with Last-Event-ID: 1 → replay 2..3, then hello
    const replay = sseReader(await fetch(`${url}events?token=${token}`, { headers: { "Last-Event-ID": "1" } }));
    const frames = await replay.next(3);
    assert.deepEqual(
      frames.map((f) => f.data.text ?? f.data.type),
      ["two", "three", "hello"],
    );
    await replay.close();

    // push the ring past its size, then ask for an evicted seq → gap
    for (const n of ["four", "five", "six"]) bridge.publish({ type: "notice", level: "info", text: n });
    const gapped = sseReader(await fetch(`${url}events?token=${token}`, { headers: { "Last-Event-ID": "1" } }));
    const gapFrames = await gapped.next(1);
    assert.equal(gapFrames[0].data.type, "gap");
    await gapped.close();

    // reconnect with a since ABOVE lastSeq (bridge restarted / seq reset under
    // the client) → gap, so a stale phone refetches instead of dropping events
    const ahead = sseReader(await fetch(`${url}events?token=${token}`, { headers: { "Last-Event-ID": "9999" } }));
    assert.equal((await ahead.next(1))[0].data.type, "gap");
    await ahead.close();
  } finally {
    await bridge.stop();
  }
});

test("chair bridge: static assets with traversal guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-chair-assets-"));
  const outside = mkdtempSync(join(tmpdir(), "oc-chair-secret-"));
  writeFileSync(join(outside, "secret.txt"), "topsecret", "utf8");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html>console</html>", "utf8");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)", "utf8");
  const { agent } = fakeAgent();
  const bridge = makeBridge(agent, { assetsDir: dir });
  const { url } = await bridge.start();
  try {
    assert.equal(await (await fetch(url)).text(), "<html>console</html>");
    const js = await fetch(`${url}assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    // traversal attempts must 404, encoded or not
    for (const path of ["../secret.txt", "..%2Fsecret.txt", "%2e%2e/%2e%2e/etc/passwd", "a/../../secret.txt"]) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 404, path);
    }
    assert.equal((await fetch(`${url}nope.js`)).status, 404);
    assert.equal((await fetch(url, { method: "PUT" })).status, 405);
  } finally {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("chair bridge: stop closes the port and start rejects a busy port", async () => {
  const { agent } = fakeAgent();
  const bridge = makeBridge(agent);
  const { url, port } = await bridge.start();
  const clash = makeBridge(agent, { port });
  await assert.rejects(clash.start(), /EADDRINUSE/);
  await bridge.stop();
  assert.equal(bridge.running, false);
  await assert.rejects(fetch(url), /fetch failed/);
});
