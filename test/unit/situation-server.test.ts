import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, chmodSync } from "node:fs";
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

test("situation control: no shared mutable file — writes and takes never block", () => {
  // the patch directory exists so there is nothing to lock: no .lock is created,
  // no writer waits, and a take is a directory drain. Earlier designs parked the
  // event loop here (Atomics.wait), which stalled /media and SSE on the TUI's
  // in-process server.
  const { dir, c } = tmpCase();
  try {
    const t0 = Date.now();
    writeControl(c, { limit: 7 });
    writeControl(c, { theme: "plain" });
    const taken = takeControl(c);
    const elapsed = Date.now() - t0;

    assert.deepEqual(taken, { limit: 7, theme: "plain" }, "both patches folded in order");
    assert.ok(elapsed < 100, `control ops should not wait; took ${elapsed}ms`);
    assert.equal(takeControl(c), undefined, "drained");
    const litter = readdirSync(situationDir(c)).filter((f) => f.includes(".lock"));
    assert.deepEqual(litter, [], "no lock file exists to be abandoned or aged out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation control: patch order survives same-millisecond writes", () => {
  // ordering is filename order, and two sets land in the same millisecond
  // routinely — a later clear must still beat an earlier assignment
  const { dir, c } = tmpCase();
  try {
    for (let i = 0; i < 25; i++) {
      writeControl(c, { source: `s${i}` });
      writeControl(c, { clear: ["source"] });
    }
    const pending = readControl(c);
    assert.equal(pending?.source, undefined, "the last clear wins over the assignment before it");
    assert.deepEqual(pending?.clear, ["source"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation control: an unreadable patch waits; a corrupt one is dropped", () => {
  // a transient read failure must not destroy the operator's command, but a
  // genuinely corrupt patch must not wedge every future tick either
  const { dir, c } = tmpCase();
  try {
    writeControl(c, { limit: 3 });
    const cdir = join(situationDir(c), "control.d");
    writeFileSync(join(cdir, "999999999999999-000001-0-corrupt.json"), "{not json", "utf8");

    const taken = takeControl(c);
    assert.deepEqual(taken, { limit: 3 }, "the readable patch still applies");
    assert.equal(readdirSync(cdir).length, 0, "the corrupt patch is removed, not retried forever");
    assert.equal(takeControl(c), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation control: an unreadable patch HOLDS the ones behind it (order)", () => {
  // patches are an ordered log. Skipping an unreadable one and applying a later
  // one would replay the skipped patch on the NEXT tick, after the later one
  // already landed — an old assignment silently undoing a newer clear.
  const { dir, c } = tmpCase();
  const cdir = join(situationDir(c), "control.d");
  let blocked: string | undefined;
  try {
    writeControl(c, { source: "web" });
    blocked = readdirSync(cdir)[0] && join(cdir, readdirSync(cdir)[0]);
    chmodSync(blocked as string, 0o000); // stand in for a transient read failure
    writeControl(c, { clear: ["source"] }); // the NEWER intent, behind the block

    assert.equal(takeControl(c), undefined, "nothing is applied past the blocked patch");
    assert.equal(readdirSync(cdir).length, 2, "both patches still pending, in order");

    chmodSync(blocked as string, 0o600); // the transient failure clears
    assert.deepEqual(takeControl(c), { clear: ["source"] }, "now both apply, in the right order");
    assert.equal(readdirSync(cdir).length, 0, "drained");
  } finally {
    if (blocked) { try { chmodSync(blocked, 0o600); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation control: writeControl's return always includes the caller's own patch", () => {
  // the return is what `situation set` shows the operator; a concurrent drain
  // must not make it report a control that omits the update just made
  const { dir, c } = tmpCase();
  try {
    assert.deepEqual(writeControl(c, { limit: 4 }), { limit: 4 });
    assert.deepEqual(writeControl(c, { theme: "plain" }), { limit: 4, theme: "plain" }, "folded onto pending");
    takeControl(c); // the server drains everything
    assert.deepEqual(writeControl(c, { source: "web" }), { source: "web" }, "still reports the caller's patch");
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
      // reset BOTH the legacy file and the patch directory — leftovers from a
      // previous round would satisfy the assertion and mask a real loss
      rmSync(controlFile(c), { force: true });
      rmSync(join(situationDir(c), "control.d"), { recursive: true, force: true });
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

test("situation state: clearStaleStop keeps a patch it could not read", () => {
  // it deletes what it CONSUMED, not everything it listed — an unreadable patch
  // is an operator command nobody has looked at yet, so sweeping it up would
  // discard it silently. Same rule takeControl follows.
  const { dir, c } = tmpCase();
  try {
    writeControl(c, { stop: true });
    const cdir = join(situationDir(c), "control.d");
    // genuinely UNREADABLE, not merely corrupt — a corrupt patch carries no
    // content and is consumed, while an unreadable one may be a real command
    const unread = join(cdir, "999999999999999-000001-0-unreadable.json");
    writeFileSync(unread, JSON.stringify({ theme: "plain" }), "utf8");
    chmodSync(unread, 0o000);
    try {
      clearStaleStop(c);
      assert.ok(existsSync(unread), "the unread patch survived the stale-stop sweep");
      assert.equal(readdirSync(cdir).length, 1, "only the consumed stop patch was removed");
    } finally {
      chmodSync(unread, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation state: clearStaleStop keeps surviving config APPLYABLE (position, not just content)", () => {
  // dropping the stop must not push the set-before-start config behind a later
  // unreadable patch — it was applyable a moment ago and must stay so
  const { dir, c } = tmpCase();
  const cdir = join(situationDir(c), "control.d");
  let blocker: string | undefined;
  try {
    writeControl(c, { stop: true, panels: ["map"], theme: "plain" });
    // The blocker must sort strictly AFTER the config patch and strictly BEFORE
    // anything republished later, or the test passes against the very bug it
    // targets: a far-future name sorts last, and a same-millisecond name can be
    // beaten by the republish's sequence number. Pin it one ms after the config
    // patch, then let the clock move past it.
    const firstName = readdirSync(cdir)[0];
    const firstMs = Number(firstName.split("-")[0]);
    blocker = join(cdir, `${String(firstMs + 1).padStart(15, "0")}-000001-0-blocked.json`);
    writeFileSync(blocker, JSON.stringify({ limit: 9 }), "utf8");
    chmodSync(blocker, 0o000); // an unreadable patch sitting AFTER the config
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // clock > blocker

    clearStaleStop(c);

    const applied = takeControl(c);
    assert.equal(applied?.stop, undefined, "stale stop dropped");
    assert.deepEqual(applied?.panels, ["map"], "config still applies despite the later blocker");
    assert.equal(applied?.theme, "plain");
  } finally {
    if (blocker) { try { chmodSync(blocker, 0o600); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("situation state: clearStaleStop neutralizes a stop queued BEHIND a blocker", () => {
  // folding only the applyable prefix missed this: the fresh serve starts fine,
  // then dies the moment the blocker is repaired and the take reaches the stale
  // stop — the exact failure clearStaleStop exists to prevent, just deferred.
  const { dir, c } = tmpCase();
  const cdir = join(situationDir(c), "control.d");
  let blocker: string | undefined;
  try {
    writeControl(c, { panels: ["map"] });          // readable prefix
    const firstMs = Number(readdirSync(cdir)[0].split("-")[0]);
    blocker = join(cdir, `${String(firstMs + 1).padStart(15, "0")}-000001-0-blocked.json`);
    writeFileSync(blocker, JSON.stringify({ theme: "plain" }), "utf8");
    chmodSync(blocker, 0o000);
    // let the clock pass the blocker's stamp, or the stop lands in the PREFIX
    // and the test passes against the very implementation it targets
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    writeControl(c, { stop: true });               // the stale stop, BEHIND it

    clearStaleStop(c);
    chmodSync(blocker, 0o600);                     // the blocker is repaired

    const applied = takeControl(c);
    assert.equal(applied?.stop, undefined, "the stale stop cannot come back and kill the server");
    assert.deepEqual(applied?.panels, ["map"], "everything else still applies");
    assert.equal(applied?.theme, "plain", "the once-blocked patch applies too");
  } finally {
    if (blocker) { try { chmodSync(blocker, 0o600); } catch { /* gone */ } }
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
