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

/** First tailnet (100.64.0.0/10) IPv4 on any interface, if the host is on one. */
export function detectTailnetAddr(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && isTailnetAddr(a.address)) return a.address;
    }
  }
  return undefined;
}
