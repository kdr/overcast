import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstant } from "../../src/verbs/chronolocate.ts";

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
