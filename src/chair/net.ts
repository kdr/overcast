// Small network helpers for the chair bridge. Tailscale (and other WireGuard
// meshes using the CGNAT range) hand out 100.64.0.0/10 IPv4 addresses — that's
// the address `/chair on tailnet` binds so a phone on the tailnet can reach the
// bridge without exposing it on LAN/all interfaces.

import { networkInterfaces } from "node:os";

/** True for 100.64.0.0/10 (the CGNAT range used by Tailscale). */
export function isTailnetAddr(addr: string): boolean {
  const m = addr.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

interface IfaceAddr {
  address: string;
  /** "IPv4" on current Node/bun; numeric 4 on the Node 18.0–18.3 regression —
   *  accept both so the compiled binary stays robust across runtimes. */
  family: string | number;
  internal: boolean;
}

/** Pure core of detectTailnetAddr (unit-testable against a fixed iface map). */
export function pickTailnetAddr(ifaces: Record<string, IfaceAddr[] | undefined>): string | undefined {
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      const isV4 = a.family === "IPv4" || a.family === 4;
      if (isV4 && !a.internal && isTailnetAddr(a.address)) return a.address;
    }
  }
  return undefined;
}

/** First tailnet (100.64.0.0/10) IPv4 on any interface, if the host is on one. */
export function detectTailnetAddr(): string | undefined {
  return pickTailnetAddr(networkInterfaces());
}
