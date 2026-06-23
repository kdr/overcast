import { test } from "node:test";
import assert from "node:assert/strict";
import { versionInfo, OVERCAST_VERSION, PI_VERSION } from "../../src/version.ts";

test("versionInfo reports overcast + pinned pi + node", () => {
  const v = versionInfo();
  assert.equal(v.overcast, OVERCAST_VERSION);
  assert.equal(v.pi, PI_VERSION);
  assert.equal(v.node, process.versions.node);
});

test("pi version is pinned at exactly 0.79.10 (invariant)", () => {
  // CLAUDE.md invariant: do not float the pi packages.
  assert.equal(PI_VERSION, "0.79.10");
});
