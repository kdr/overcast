// Tailscale `serve` integration for the chair bridge.
//
// A phone on the tailnet reaches the chair over its 100.64.0.0/10 IP, but that's
// plain HTTP — and browsers only grant the microphone (and even expose the Web
// Speech API) on a SECURE context. `tailscale serve` fronts a local port with a
// real HTTPS cert at https://<machine>.<tailnet>.ts.net, which IS secure — so
// the pairing QR should point there when it's available, and voice dictation
// then works on the phone.
//
// We (a) DETECT an existing `tailscale serve` mapping to the chair's port and
// use its HTTPS URL for the QR, and (b) optionally ENABLE one (`/chair on
// --serve`). The whole invocation is overridable via OVERCAST_TAILSCALE_CMD
// (offline-test + custom-path knob, mirroring OVERCAST_TINYCLOUD_CMD).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// A GUI-launched process (Cursor/Terminal.app task) can inherit a minimal PATH
// that omits /usr/local/bin, so `tailscale` isn't found even though the login
// shell has it. Prefer a known absolute path, falling back to PATH lookup.
const TAILSCALE_PATHS = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function tailscaleInvocation(): { cmd: string; base: string[] } {
  const override = process.env.OVERCAST_TAILSCALE_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], base: parts.slice(1) };
  }
  for (const p of TAILSCALE_PATHS) if (existsSync(p)) return { cmd: p, base: [] };
  return { cmd: "tailscale", base: [] };
}

async function runTailscale(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const { cmd, base } = tailscaleInvocation();
  try {
    const { stdout, stderr } = await execFileP(cmd, [...base, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
    };
  }
}

/** True for tailscale serve's loopback proxy targets. */
function proxyTargetsPort(proxy: string, port: number): boolean {
  const m = proxy.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?/i);
  if (!m) return false;
  return (m[1] ? Number(m[1]) : 80) === port;
}

/** Build https://host[:port]/mount from a serve-config "host:443" key. */
function httpsUrlFor(hostPort: string, mount: string): string {
  let host = hostPort;
  let suffix = "";
  const idx = hostPort.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(hostPort.slice(idx + 1))) {
    host = hostPort.slice(0, idx);
    const p = hostPort.slice(idx + 1);
    if (p !== "443") suffix = `:${p}`;
  }
  const path = mount && mount !== "/" ? `${mount.replace(/\/+$/, "")}/` : "/";
  return `https://${host}${suffix}${path}`;
}

/** Pure core: pull an HTTPS URL proxying to loopback:<port> out of the parsed
 *  `tailscale serve status --json` config (undefined if none). */
export function parseServeUrl(config: unknown, port: number): string | undefined {
  const web = (config as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null)?.Web;
  if (!web || typeof web !== "object") return undefined;
  for (const [hostPort, entry] of Object.entries(web)) {
    const handlers = entry?.Handlers;
    if (!handlers) continue;
    for (const [mount, handler] of Object.entries(handlers)) {
      if (handler?.Proxy && proxyTargetsPort(handler.Proxy, port)) return httpsUrlFor(hostPort, mount);
    }
  }
  return undefined;
}

/** The HTTPS URL an existing `tailscale serve` exposes for the chair port, or
 *  undefined (tailscale absent, not serving that port, or old text-only CLI). */
export async function detectServeUrl(port: number): Promise<string | undefined> {
  if (!port || port <= 0) return undefined;
  const { code, stdout } = await runTailscale(["serve", "status", "--json"], 4000);
  if (code !== 0 || !stdout.trim()) return undefined;
  try {
    return parseServeUrl(JSON.parse(stdout), port);
  } catch {
    return undefined; // non-JSON (older tailscale) — treat as "not detected"
  }
}

/** The command a user would run to front the chair port with HTTPS themselves. */
export function serveCommandHint(port: number): string {
  return `tailscale serve --bg ${port}`;
}

/** Bring up `tailscale serve` for the port (idempotent) and read back the HTTPS
 *  URL. Returns { url } on success or { error } with actionable text.
 *
 *  We TRUST detection over the exit code: some tailscale builds print to stdout
 *  and return non-zero on first-run cert provisioning even though the serve
 *  mapping is written — so poll `serve status` before declaring failure. */
export async function enableServe(port: number): Promise<{ url?: string; error?: string }> {
  const existing = await detectServeUrl(port);
  if (existing) return { url: existing };
  const res = await runTailscale(["serve", "--bg", String(port)], 25000);
  const pollMs = Number(process.env.OVERCAST_TAILSCALE_POLL_MS) || 750;
  for (let i = 0; i < 4; i++) {
    const url = await detectServeUrl(port);
    if (url) return { url };
    await delay(pollMs);
  }
  // genuine failure — surface the real reason (tailscale often writes it to
  // stdout, not stderr), and the manual fallback + the prerequisite.
  const detail = (res.stderr.trim() || res.stdout.trim()).split("\n").filter(Boolean)[0] || `exit ${res.code}`;
  return {
    error: `tailscale serve exposed no HTTPS URL (${detail}) — run \`${serveCommandHint(port)}\` manually, or enable HTTPS certificates + MagicDNS for your tailnet in the admin console`,
  };
}

/** Best-effort teardown of the 443 serve mapping we brought up. */
export async function disableServe(port: number): Promise<void> {
  await runTailscale(["serve", "--https=443", "off"], 8000).catch(() => {});
  void port;
}
