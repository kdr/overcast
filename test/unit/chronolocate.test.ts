import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstant, parseRefDate } from "../../src/verbs/chronolocate.ts";

// parseInstant normalizes ExifTool-style capture times (what `exif` writes into
// payload.created) so an analyst can paste one straight into --at-time. It must
// mirror map's captureMs: normalize the date colons AND the space separator
// UNCONDITIONALLY, then pin only zone-less datetimes to UTC.

test("parseInstant: zoned exif time with a SPACE separator parses at the right instant", () => {
  // regression: previously the space→T normalization ran only when zone-less, so
  // a copied exif time with an offset (`… HH:MM:SS+05:30`) was left with a space
  // and failed / verified at the wrong instant.
  const got = parseInstant("2026:06:01 14:30:00+05:30");
  assert.ok(got, "should parse a zoned exif-with-space value");
  assert.equal(got!.assumedUtc, false, "an explicit offset is not assumed-UTC");
  // 14:30:00+05:30 == 09:00:00Z
  assert.equal(got!.date.toISOString(), "2026-06-01T09:00:00.000Z");
});

test("parseInstant: zone-less exif time with a space is pinned to UTC and flagged", () => {
  const got = parseInstant("2026:06:01 14:30:00");
  assert.ok(got);
  assert.equal(got!.assumedUtc, true);
  assert.equal(got!.date.toISOString(), "2026-06-01T14:30:00.000Z");
});

test("parseInstant: date-only is UTC midnight and flagged assumed-UTC", () => {
  const got = parseInstant("2026:06:01");
  assert.ok(got);
  assert.equal(got!.assumedUtc, true);
  assert.equal(got!.date.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("parseInstant: a fully-zoned ISO value is respected, not re-zoned", () => {
  const got = parseInstant("2026-06-01T14:30:00Z");
  assert.ok(got);
  assert.equal(got!.assumedUtc, false);
  assert.equal(got!.date.toISOString(), "2026-06-01T14:30:00.000Z");
});

test("parseInstant: garbage is undefined", () => {
  assert.equal(parseInstant("not-a-date"), undefined);
});

test("parseInstant: an impossible calendar day is rejected (not rolled forward)", () => {
  // Date would roll 2026-02-30 → Mar 2 and verify the wrong instant.
  assert.equal(parseInstant("2026-02-30"), undefined);
  assert.equal(parseInstant("2026:02:30 12:00:00"), undefined);
  assert.equal(parseInstant("2025-02-29"), undefined); // 2025 is not a leap year
  // a real day still parses
  assert.equal(parseInstant("2026-02-28")?.date.toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(parseInstant("2024-02-29")?.date.toISOString(), "2024-02-29T00:00:00.000Z"); // leap year
});

test("parseRefDate: an impossible solve --date is rejected (not rolled forward)", () => {
  assert.equal(parseRefDate("2026-02-30", 0), undefined);
  assert.equal(parseRefDate("2026-13-01", 0), undefined);
  assert.equal(parseRefDate("2025-02-29", 0), undefined);
  // a real day → noon UTC
  assert.equal(parseRefDate("2026-02-28", 0)?.toISOString(), "2026-02-28T12:00:00.000Z");
});

test("parseRefDate: a non-YYYY-MM-DD --date is rejected (no host-local Date parsing)", () => {
  // these would parse host-locally via `new Date`, shifting the UTC solar day
  assert.equal(parseRefDate("02/28/2026", 0), undefined);
  assert.equal(parseRefDate("Feb 28 2026", 0), undefined);
  assert.equal(parseRefDate("2026-02-28T00:00:00", 0), undefined);
  assert.equal(parseRefDate("2026/02/28", 0), undefined);
});
