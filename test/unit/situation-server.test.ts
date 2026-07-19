import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
import { openCase } from "../../src/case.ts";
import { SituationServer, parseRange } from "../../src/situation/server.ts";
import { writeControl, readControl, takeControl, controlFile, situationDir, clearStaleStop, readRuntime, writeRuntime, clearRuntime, runtimeAlive } from "../../src/situation/state.ts";

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
    // a clear DROPS a filter back to default/auto (the only removal path on a
    // long-running serve) while assignments in the same control still apply
    writeControl(c, { clear: ["source", "limit"], since: "24h" });
    await s.tick();
    assert.equal(s.activeConfig.source, undefined, "cleared filter removed");
    assert.equal(s.activeConfig.limit, undefined, "cleared limit removed");
    assert.equal(s.activeConfig.since, "24h", "assignment alongside clear applies");
    assert.equal(s.activeConfig.theme, "plain", "untouched key survives");
    // a stop patch fires the owner callback
    writeControl(c, { stop: true });
    await s.tick();
    assert.equal(stopReason, "control");
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation control: takeControl claims atomically — a set racing the take is never consumed unseen", () => {
  const { dir, c } = tmpCase();
  try {
    writeControl(c, { limit: 4, source: "web" });
    // the take returns the pending control AND leaves nothing behind
    assert.deepEqual(takeControl(c), { limit: 4, source: "web" });
    assert.equal(readControl(c), undefined, "control consumed by the take");
    assert.equal(takeControl(c), undefined, "nothing pending is not an error");

    // THE RACE: a `situation set` landing after a take must survive for the next
    // tick. The old stat-mtime-then-unlink consume could delete this one having
    // never applied it — the operator's command vanishing with no error.
    takeControl(c);
    writeControl(c, { theme: "plain" });
    assert.deepEqual(readControl(c), { theme: "plain" }, "post-take write still pending");
    assert.deepEqual(takeControl(c), { theme: "plain" }, "and is delivered whole on the next take");

    // a corrupt/truncated control is dropped rather than wedging the tick loop
    mkdirSync(situationDir(c), { recursive: true });
    writeFileSync(controlFile(c), "{not json", "utf8");
    assert.equal(takeControl(c), undefined, "corrupt control ignored");
    assert.equal(readControl(c), undefined, "and cleared, so it can't loop forever");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation control: concurrent writeControl across PROCESSES loses no update", async () => {
  // writeControl is a read-modify-write, so two `situation set`s racing from
  // different processes (the agent and a CLI in another terminal) could both
  // read the same pending state and the slower publish would clobber the
  // faster — an operator command lost with no error. Verified against the
  // unlocked implementation: it keeps 1 of 6 updates per round.
  //
  // Every contender adds a DIFFERENT clear key; writeControl unions clear[], so
  // a lost fold shows up precisely as a missing key.
  const { dir, c } = tmpCase();
  const child = join(dir, "contend.ts");
  const stateMod = pathToFileURL(join(HERE, "..", "..", "src", "situation", "state.ts")).href;
  const caseMod = pathToFileURL(join(HERE, "..", "..", "src", "case.ts")).href;
  writeFileSync(child, `
import { openCase } from ${JSON.stringify(caseMod)};
import { writeControl } from ${JSON.stringify(stateMod)};
const [dir, key, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* spin to the barrier so we truly contend */ }
writeControl(openCase(dir), { clear: [key] });
`, "utf8");

  const KEYS = ["panels", "source", "since", "limit", "theme", "query"];
  try {
    for (let round = 0; round < 2; round++) {
      rmSync(controlFile(c), { force: true });
      const startAt = Date.now() + 700; // all contenders write at the same instant
      await Promise.all(KEYS.map((k) => new Promise<void>((res) => {
        spawn(process.execPath, ["--import", "tsx", child, dir, k, String(startAt)], { stdio: "ignore" })
          .on("exit", () => res());
      })));
      const kept = (readControl(c)?.clear ?? []) as string[];
      assert.deepEqual([...kept].sort(), [...KEYS].sort(), `round ${round}: a concurrent update was lost`);
    }
  } finally {
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

test("situation state: clearStaleStop drops a leftover stop:true (keeps config)", () => {
  const { dir, c } = tmpCase();
  try {
    // a bare stale stop → file removed entirely, so a fresh serve isn't killed
    writeControl(c, { stop: true });
    clearStaleStop(c);
    assert.equal(readControl(c), undefined, "bare stale stop is cleared");
    // a stop alongside a set-before-start config → stop dropped, config kept
    writeControl(c, { stop: true, panels: ["map"], theme: "plain" });
    clearStaleStop(c);
    const left = readControl(c);
    assert.equal(left?.stop, undefined, "stale stop removed");
    assert.deepEqual(left?.panels, ["map"], "set-before-start config preserved");
    // a config-only control is untouched
    clearStaleStop(c);
    assert.deepEqual(readControl(c)?.panels, ["map"]);
    // clear-vs-set composition in PENDING control: a clear drops a pending
    // assignment (clear wins over an older set) …
    writeControl(c, { source: "web", limit: 4 });
    writeControl(c, { clear: ["source"] });
    let pending = readControl(c);
    assert.equal(pending?.source, undefined, "pending assignment dropped by a later clear");
    assert.deepEqual(pending?.clear, ["source"]);
    assert.equal(pending?.limit, 4, "unrelated pending key kept");
    // … and a later re-set drops the pending clear (the newest intent wins)
    writeControl(c, { source: "youtube" });
    pending = readControl(c);
    assert.equal(pending?.source, "youtube");
    assert.equal(pending?.clear, undefined, "pending clear cancelled by a re-set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
