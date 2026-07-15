import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { situationConsoleDir } from "../../src/situation/assets.ts";
import { chairConsoleDir } from "../../src/chair/assets.ts";

// Regression guard for the situation.page_html 404 (and the silent chair fallback
// it shares a root cause with). shippedPath()'s walk-up returns the FIRST ancestor
// that merely *contains* `assets/<console>/`, so a stale or partial copy — a prior
// `build:bun` sidecar copy left beside the node dev binary in dist/bin/, or an
// interrupted vite build — used to shadow the complete build and get served,
// 404ing the root because it had no index.html. The resolvers now resolve by the
// index.html sentinel; the invariant they must uphold is: never hand back a
// console directory that lacks its entry point.
for (const [name, resolve] of [
  ["situation", situationConsoleDir],
  ["chair", chairConsoleDir],
] as const) {
  test(`${name} console resolver never returns a directory without index.html`, () => {
    const dir = resolve();
    // undefined is a valid answer (console not built in this env → server serves
    // its 404 / fallback); we only forbid returning an entry-point-less shell.
    if (dir === undefined) return;
    assert.ok(
      existsSync(join(dir, "index.html")),
      `${name}ConsoleDir() returned ${dir} with no index.html — a shadowing/partial copy would 404 the served root`,
    );
  });
}
