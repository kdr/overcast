import { test } from "node:test";
import assert from "node:assert/strict";
import { isTailnetAddr, pickTailnetAddr } from "../../src/chair/net.ts";

test("isTailnetAddr: 100.64.0.0/10 boundaries", () => {
  assert.equal(isTailnetAddr("100.64.0.1"), true);
  assert.equal(isTailnetAddr("100.101.102.103"), true);
  assert.equal(isTailnetAddr("100.127.255.254"), true);
  assert.equal(isTailnetAddr("100.63.255.255"), false);
  assert.equal(isTailnetAddr("100.128.0.1"), false);
  assert.equal(isTailnetAddr("10.0.0.1"), false);
  assert.equal(isTailnetAddr("fd7a:115c:a1e0::1"), false);
});

test("pickTailnetAddr: accepts both string and numeric IPv4 family", () => {
  // Node ≥18.4 and bun report family "IPv4"; Node 18.0–18.3 reported numeric 4
  const stringFamily = {
    en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
    utun3: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  };
  assert.equal(pickTailnetAddr(stringFamily), "100.101.102.103");
  const numericFamily = {
    utun3: [{ address: "100.101.102.103", family: 4, internal: false }],
  };
  assert.equal(pickTailnetAddr(numericFamily), "100.101.102.103");
});

test("pickTailnetAddr: skips internal, IPv6, and non-CGNAT addresses", () => {
  assert.equal(
    pickTailnetAddr({
      lo0: [{ address: "100.64.0.9", family: "IPv4", internal: true }],
      utun3: [{ address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false }],
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      empty: undefined,
    }),
    undefined,
  );
});
