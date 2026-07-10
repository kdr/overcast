import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServeUrl, detectServeUrl, serveCommandHint } from "../../src/chair/serve.ts";
import { ChairBridge, type ChairAgent } from "../../src/chair/bridge.ts";
import type { CaseGlance } from "../../src/chair/wire.ts";

// --- parseServeUrl: pull the HTTPS origin out of `tailscale serve status --json` ---

const serveConfig = (proxy: string, host = "mac.tail1234.ts.net:443", mount = "/") => ({
  TCP: { "443": { HTTPS: true } },
  Web: { [host]: { Handlers: { [mount]: { Proxy: proxy } } } },
});

test("parseServeUrl maps a loopback proxy to its HTTPS origin (strips :443)", () => {
  assert.equal(parseServeUrl(serveConfig("http://127.0.0.1:7373"), 7373), "https://mac.tail1234.ts.net/");
});

test("parseServeUrl accepts localhost and ::1 loopback targets", () => {
  assert.equal(parseServeUrl(serveConfig("http://localhost:7373"), 7373), "https://mac.tail1234.ts.net/");
  assert.equal(parseServeUrl(serveConfig("http://[::1]:7373"), 7373), "https://mac.tail1234.ts.net/");
});

test("parseServeUrl keeps a non-443 host port and a non-root mount", () => {
  assert.equal(parseServeUrl(serveConfig("http://127.0.0.1:7373", "mac.ts.net:8443", "/chair"), 7373), "https://mac.ts.net:8443/chair/");
});

test("parseServeUrl returns undefined when the proxy targets a different port", () => {
  assert.equal(parseServeUrl(serveConfig("http://127.0.0.1:9999"), 7373), undefined);
});

test("parseServeUrl ignores non-loopback proxy targets", () => {
  assert.equal(parseServeUrl(serveConfig("http://100.82.85.64:7373"), 7373), undefined);
});

test("parseServeUrl tolerates empty / malformed config", () => {
  assert.equal(parseServeUrl(null, 7373), undefined);
  assert.equal(parseServeUrl({}, 7373), undefined);
  assert.equal(parseServeUrl({ Web: {} }, 7373), undefined);
  assert.equal(parseServeUrl({ Web: { "h:443": {} } }, 7373), undefined);
});

test("serveCommandHint names the port", () => {
  assert.equal(serveCommandHint(7373), "tailscale serve --bg 7373");
});

// --- detectServeUrl: exec wiring via OVERCAST_TAILSCALE_CMD fake ---

function withFakeTailscale(body: string, fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-ts-"));
  const script = join(dir, "fakets.sh");
  writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(script, 0o755);
  const prev = process.env.OVERCAST_TAILSCALE_CMD;
  process.env.OVERCAST_TAILSCALE_CMD = script;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.OVERCAST_TAILSCALE_CMD;
    else process.env.OVERCAST_TAILSCALE_CMD = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("detectServeUrl parses a fake `serve status --json`", async () => {
  const json = JSON.stringify(serveConfig("http://127.0.0.1:7373"));
  await withFakeTailscale(`echo '${json}'`, async () => {
    assert.equal(await detectServeUrl(7373), "https://mac.tail1234.ts.net/");
  });
});

test("detectServeUrl returns undefined on non-JSON output (old CLI)", async () => {
  await withFakeTailscale(`echo 'https://mac.ts.net/ (tailnet only)'`, async () => {
    assert.equal(await detectServeUrl(7373), undefined);
  });
});

test("detectServeUrl returns undefined when tailscale errors", async () => {
  await withFakeTailscale(`echo 'not logged in' >&2; exit 1`, async () => {
    assert.equal(await detectServeUrl(7373), undefined);
  });
});

test("detectServeUrl short-circuits an ephemeral (0) port", async () => {
  // no fake needed — port 0 never reaches exec
  assert.equal(await detectServeUrl(0), undefined);
});

// --- ChairBridge: publicUrl drives displayUrl / secure / pairingUrl ---

const GLANCE: CaseGlance = { caseName: "tc", dir: "/tmp/tc", records: 0, counts: {}, targets: [], sources: [], openFindings: [], latest: [] };
const agent: ChairAgent = {
  isIdle: () => true,
  hasPending: () => false,
  abort: () => {},
  sendUserMessage: () => {},
  model: () => "m",
  sessionName: () => "s",
  caseName: () => "tc",
  caseDir: () => "/tmp/tc",
  transcript: () => [],
  caseGlance: () => GLANCE,
};

test("ChairBridge with publicUrl pairs over the HTTPS origin", () => {
  const b = new ChairBridge({ agent, profile: "default", version: "0", port: 0, token: "tok", publicUrl: "https://mac.ts.net/" });
  assert.equal(b.displayUrl, "https://mac.ts.net/");
  assert.equal(b.secure, true);
  assert.equal(b.pairingUrl, "https://mac.ts.net/#t=tok");
});

test("ChairBridge without publicUrl stays on the raw http bind", () => {
  const b = new ChairBridge({ agent, profile: "default", version: "0", port: 0, token: "tok" });
  assert.match(b.displayUrl, /^http:\/\//);
  assert.equal(b.secure, false);
  assert.match(b.pairingUrl, /#t=tok$/);
});
