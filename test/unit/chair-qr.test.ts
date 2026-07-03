import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeQr } from "../../src/chair/qrcodegen.ts";
import { qrLines } from "../../src/chair/qr.ts";

function isDark(m: boolean[][], x: number, y: number): boolean {
  return m[y][x];
}

/** The 7x7 finder ring: dark unless at ring distance 2 or 4 from its center. */
function assertFinder(m: boolean[][], cx: number, cy: number): void {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      assert.equal(isDark(m, cx + dx, cy + dy), dist !== 2, `finder@${cx},${cy} module ${dx},${dy}`);
    }
  }
}

test("qr: structural invariants for a short payload (version 1)", () => {
  const m = encodeQr("A");
  assert.equal(m.length, 21); // version 1 = 21x21
  for (const row of m) assert.equal(row.length, 21);
  assertFinder(m, 3, 3);
  assertFinder(m, 21 - 4, 3);
  assertFinder(m, 3, 21 - 4);
  // timing patterns alternate between the finders
  for (let i = 8; i < 13; i++) {
    assert.equal(isDark(m, i, 6), i % 2 === 0, `h-timing@${i}`);
    assert.equal(isDark(m, 6, i), i % 2 === 0, `v-timing@${i}`);
  }
  // the spec's always-dark module at (8, size-8)
  assert.equal(isDark(m, 8, 21 - 8), true);
});

test("qr: a chair pairing URL fits version 5 at ECC M", () => {
  // 32-byte token → base64url 43 chars; realistic tailnet pairing URL ≈ 74 bytes
  const url = "http://100.101.102.103:7373/#t=" + "a".repeat(43);
  const m = encodeQr(url);
  assert.equal(m.length, 37); // version 5 = 37x37
  assertFinder(m, 3, 3);
  assert.equal(isDark(m, 8, 37 - 8), true);
});

test("qr: payload beyond version 10 capacity throws", () => {
  assert.throws(() => encodeQr("x".repeat(300)), /too long/);
});

test("qrLines: half-block render with an explicit light quiet zone", () => {
  const lines = qrLines("A"); // 21 + 2*4 border = 29 modules
  assert.equal(lines.length, Math.ceil(29 / 2));
  for (const line of lines) assert.equal([...line].length, 29);
  // top border rows are all light = full blocks (inverted render)
  assert.equal(lines[0], "█".repeat(29));
  assert.equal(lines[1], "█".repeat(29));
  // interior must contain dark modules (spaces or half blocks)
  assert.match(lines.join("\n"), /[ ▀▄]/);
});

test("qr: same input is deterministic", () => {
  const a = encodeQr("http://127.0.0.1:7373/#t=abc123");
  const b = encodeQr("http://127.0.0.1:7373/#t=abc123");
  assert.deepEqual(a, b);
});
