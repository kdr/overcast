import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { versionInfo, OVERCAST_VERSION, PI_VERSION } from "../../src/version.ts";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
);

test("versionInfo reports overcast + pinned pi + node", () => {
  const v = versionInfo();
  assert.equal(v.overcast, OVERCAST_VERSION);
  assert.equal(v.pi, PI_VERSION);
  assert.equal(v.node, process.versions.node);
});

test("pi version is pinned at exactly 0.80.1 (invariant)", () => {
  // CLAUDE.md invariant: do not float the pi packages.
  assert.equal(PI_VERSION, "0.80.1");
});

test("PI_VERSION constant stays in sync with the pinned pi-* deps", () => {
  // The constant is the single source of truth surfaced to `--version`; this
  // guards it against silently drifting from the actual pinned dependency
  // when pi is bumped (a reviewed change, per CLAUDE.md).
  const piDeps = Object.entries(pkg.dependencies as Record<string, string>)
    .filter(([name]) => name.startsWith("@earendil-works/pi-"))
    .map(([, range]) => range);
  assert.ok(piDeps.length > 0, "expected pinned @earendil-works/pi-* deps");
  for (const range of piDeps) {
    assert.equal(range, PI_VERSION, "pi-* deps must be pinned to PI_VERSION");
  }
});
