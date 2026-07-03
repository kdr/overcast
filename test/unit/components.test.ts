import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtAge, fmtTime, sparkline, chip, coverageBadges } from "../../src/report/components.ts";

test("fmtAge: compact units, — for unknown", () => {
  assert.equal(fmtAge(null), "—");
  assert.equal(fmtAge(undefined), "—");
  assert.equal(fmtAge(NaN), "—");
  assert.equal(fmtAge(30), "30s");
  assert.equal(fmtAge(90), "2m");
  assert.equal(fmtAge(3 * 3600), "3h");
  assert.equal(fmtAge(6 * 86400), "6d");
});

test("fmtTime: m:ss and h:mm:ss", () => {
  assert.equal(fmtTime(65), "1:05");
  assert.equal(fmtTime(3661), "1:01:01");
});

test("sparkline: scales bins across the block ramp; empty flat", () => {
  assert.equal(sparkline([]), "");
  assert.equal(sparkline([0, 0, 0]), "▁▁▁");
  const s = sparkline([0, 4, 8]);
  assert.equal(s.length, 3);
  assert.equal(s[0], "▁");
  assert.equal(s[2], "█");
});

test("chip: tone class + escaping", () => {
  assert.equal(chip("OK"), '<span class="chip">OK</span>');
  assert.equal(chip("HOT", "amber"), '<span class="chip amber">HOT</span>');
  assert.match(chip("<x>"), /&lt;x&gt;/);
});

test("coverageBadges: lit letters for present modalities", () => {
  const b = coverageBadges({ watch: true, face: true });
  assert.match(b, /<b class="on">W<\/b>/);
  assert.match(b, /<b class="">L<\/b>/);
  assert.match(b, /<b class="on">F<\/b>/);
});
