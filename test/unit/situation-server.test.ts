import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { SituationServer, parseRange } from "../../src/situation/server.ts";
import { writeControl, readRuntime, writeRuntime, clearRuntime, runtimeAlive } from "../../src/situation/state.ts";

function tmpCase() {
  const dir = mkdtempSync(join(tmpdir(), "oc-situation-"));
  const c = openCase(dir);
  c.ensure();
  return { dir, c };
}

function server(dir: string, over: Partial<ConstructorParameters<typeof SituationServer>[0]> = {}) {
  return new SituationServer({
    case: openCase(dir),
    version: "0.0.0-test",
    port: 0,
    posters: false,
    pollMs: 60_000, // we drive tick() by hand
    ...over,
  });
}

test("situation server: auth required on /api and /media; static shell open", async () => {
  const { dir } = tmpCase();
  const assets = mkdtempSync(join(tmpdir(), "oc-situation-assets-"));
  writeFileSync(join(assets, "index.html"), "<html>situation</html>", "utf8");
  const s = server(dir, { assetsDir: assets });
  const { url, pairingUrl } = await s.start();
  const token = pairingUrl.split("#t=")[1];
  try {
    assert.equal((await fetch(`${url}api/state`)).status, 401);
    assert.equal((await fetch(`${url}media/deadbeef/x.mp4`)).status, 401);
    const good = await fetch(`${url}api/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(good.status, 200);
    const snap = (await good.json()) as Record<string, unknown>;
    assert.equal(snap.version, "0.0.0-test");
    assert.ok(Array.isArray(snap.panels));
    // static shell served without auth, never leaks the token
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes(token));
  } finally {
    await s.stop();
    rmSync(assets, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation server: /media serves only allowlisted case media (Range 206), 404 otherwise", async () => {
  const { dir, c } = tmpCase();
  // a capture whose media the wall will surface
  mkdirSync(c.mediaDir, { recursive: true });
  const clip = join(c.mediaDir, "a.mp4");
  writeFileSync(clip, Buffer.from("0123456789ABCDEF"));
  c.writeRecord({
    id: "rec_a",
    verb: "capture",
    format: "json",
    payload: { capture_id: "cap_a", path: clip, source: "youtube" },
    media: { ref: clip },
    meta: { time: "2026-07-10T10:00:00Z" },
    state: "ready",
  });
  const s = server(dir);
  const { url, pairingUrl } = await s.start();
  const token = pairingUrl.split("#t=")[1];
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const snap = (await (await fetch(`${url}api/state`, { headers: auth })).json()) as { tiles: { ref: string; mediaUrl: string | null }[] };
    const tile = snap.tiles.find((t) => t.ref === clip);
    assert.ok(tile?.mediaUrl, "tile carries a /media URL");
    // full fetch
    const full = await fetch(url.replace(/\/$/, "") + tile!.mediaUrl, { headers: auth });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(await full.text(), "0123456789ABCDEF");
    // range fetch → 206
    const ranged = await fetch(url.replace(/\/$/, "") + tile!.mediaUrl, { headers: { ...auth, Range: "bytes=2-5" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 2-5/16");
    assert.equal(await ranged.text(), "2345");
    // an unknown media id (not in the allowlist) 404s even with a valid token
    assert.equal((await fetch(`${url}media/0000000000000000000000000000000000000000/x.mp4`, { headers: auth })).status, 404);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation server: tick() applies control.json and fires onStopRequested on stop", async () => {
  const { dir, c } = tmpCase();
  let stopReason: string | undefined;
  const s = server(dir, { onStopRequested: (r) => (stopReason = r) });
  await s.start();
  try {
    // a set patch is applied to the active config on the next tick
    writeControl(c, { limit: 4, theme: "plain", source: "web" });
    await s.tick();
    assert.equal(s.activeConfig.limit, 4);
    assert.equal(s.activeConfig.theme, "plain");
    assert.equal(s.activeConfig.source, "web");
    // a stop patch fires the owner callback
    writeControl(c, { stop: true });
    await s.tick();
    assert.equal(stopReason, "control");
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation server: a store append triggers a refresh event", async () => {
  const { dir, c } = tmpCase();
  const s = server(dir);
  const { url, pairingUrl } = await s.start();
  const token = pairingUrl.split("#t=")[1];
  try {
    const es = await fetch(`${url}events?token=${token}`);
    const reader = es.body!.getReader();
    const decoder = new TextDecoder();
    // drain the hello
    await reader.read();
    // append a record, then tick — expect a refresh frame
    c.writeRecord({
      id: "rec_scan",
      verb: "scan",
      format: "json",
      payload: { title: "new hit", url: "https://e.com/x", source: "web" },
      meta: { time: "2026-07-10T11:00:00Z" },
      state: "ready",
    });
    await s.tick();
    const deadline = Date.now() + 2000;
    let sawRefresh = false;
    while (Date.now() < deadline && !sawRefresh) {
      const { value, done } = await reader.read();
      if (done) break;
      if (decoder.decode(value).includes('"type":"refresh"')) sawRefresh = true;
    }
    await reader.cancel().catch(() => {});
    assert.ok(sawRefresh, "a store change publishes a refresh event");
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation server: POST /api/refresh forces a rebuild + returns fresh snapshot", async () => {
  const { dir, c } = tmpCase();
  const s = server(dir);
  const { url, pairingUrl } = await s.start();
  const token = pairingUrl.split("#t=")[1];
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const before = (await (await fetch(`${url}api/state`, { headers: auth })).json()) as { hud: { records: number } };
    c.writeRecord({ id: "rec_x", verb: "scan", format: "json", payload: { title: "t", url: "https://e.com/z", source: "web" }, meta: { time: "2026-07-10T11:00:00Z" }, state: "ready" });
    const refreshed = (await (await fetch(`${url}api/refresh`, { method: "POST", headers: auth })).json()) as { hud: { records: number } };
    assert.equal(refreshed.hud.records, before.hud.records + 1, "force-refresh reflects the new record without waiting for a tick");
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation server: /media refuses a record ref outside the case dir (containment)", async () => {
  const { dir, c } = tmpCase();
  const outside = mkdtempSync(join(tmpdir(), "oc-situation-outside-"));
  const secret = join(outside, "secret.mp4");
  writeFileSync(secret, Buffer.from("SECRET-BYTES"));
  // a record referencing a file OUTSIDE the case dir — must never become servable
  c.writeRecord({ id: "rec_out", verb: "capture", format: "json", payload: { capture_id: "cap_out", path: secret, source: "youtube" }, media: { ref: secret }, meta: { time: "2026-07-10T10:00:00Z" }, state: "ready" });
  const s = server(dir);
  const { url, pairingUrl } = await s.start();
  const token = pairingUrl.split("#t=")[1];
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const snap = (await (await fetch(`${url}api/state`, { headers: auth })).json()) as { tiles: { ref: string; mediaUrl: string | null }[] };
    const tile = snap.tiles.find((t) => t.ref === secret);
    assert.ok(tile, "the out-of-case tile still appears");
    assert.equal(tile!.mediaUrl, null, "but its media is not servable (no /media URL minted)");
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("parseRange: standard, open-ended, suffix, and unsatisfiable", () => {
  assert.deepEqual(parseRange("bytes=2-5", 16), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=10-", 16), { start: 10, end: 15 });
  assert.deepEqual(parseRange("bytes=-4", 16), { start: 12, end: 15 });
  assert.deepEqual(parseRange("bytes=0-999", 16), { start: 0, end: 15 }, "end clamps to size-1");
  assert.equal(parseRange("bytes=20-30", 16), null, "start past EOF → 416");
  assert.equal(parseRange("bytes=5-2", 16), null, "inverted → 416");
  assert.equal(parseRange("bytes=-", 16), null);
  assert.equal(parseRange("nonsense", 16), null);
});

test("situation state: runtime round-trips; a live pid reads alive, a dead one stale", () => {
  const { dir, c } = tmpCase();
  try {
    assert.equal(readRuntime(c), undefined);
    // this process IS alive → a runtime stamped with our pid reads as running
    writeRuntime(c, {
      pid: process.pid,
      port: 7374,
      bind: "127.0.0.1",
      url: "http://127.0.0.1:7374/",
      displayUrl: "http://127.0.0.1:7374/",
      startedAt: "2026-07-10T12:00:00Z",
      caseDir: dir,
      every: "5m",
      mode: "cli",
    });
    const rt = readRuntime(c);
    assert.equal(rt?.port, 7374);
    assert.equal(rt?.every, "5m");
    assert.equal(runtimeAlive(rt), true);
    // a pid that can't exist → stale (a crashed serve leaves a dead runtime.json)
    writeRuntime(c, { ...rt!, pid: 2_000_000_000 });
    assert.equal(runtimeAlive(readRuntime(c)), false);
    clearRuntime(c);
    assert.equal(readRuntime(c), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
