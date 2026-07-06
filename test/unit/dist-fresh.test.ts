import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = join(process.cwd(), "scripts", "check-dist-fresh.mjs");

function writeCli(path: string, version: { overcast: string; pi: string }, verbs: string[]): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "--version" && argv[1] === "--json") {
  console.log(${JSON.stringify(JSON.stringify({ ...version, node: "test" }))});
} else if (argv[0] === "commands" && argv[1] === "--json") {
  console.log(${JSON.stringify(JSON.stringify({ verbs: verbs.map((name) => ({ name })) }))});
} else {
  console.error("unexpected argv: " + argv.join(" "));
  process.exit(2);
}
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

test("check-dist-fresh fails clearly when dist CLI is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-dist-missing-"));
  try {
    const res = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...process.env, OVERCAST_DIST_FRESH_ROOT: root },
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /dist CLI is missing/);
    assert.match(res.stderr, /npm run build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-dist-fresh fails clearly when dist version or commands drift", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-dist-stale-"));
  try {
    const source = join(root, "source-cli.mjs");
    const distDir = join(root, "dist", "bin");
    const dist = join(distDir, "overcast.js");
    mkdirSync(distDir, { recursive: true });
    writeCli(source, { overcast: "1.2.3", pi: "0.80.3" }, ["watch", "listen"]);
    writeCli(dist, { overcast: "1.2.2", pi: "0.80.1" }, ["watch", "scan"]);

    const res = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OVERCAST_DIST_FRESH_ROOT: root,
        OVERCAST_DIST_FRESH_SOURCE_CMD: JSON.stringify([process.execPath, source]),
        OVERCAST_DIST_FRESH_DIST_CMD: JSON.stringify([process.execPath, dist]),
      },
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /dist\/bin\/overcast\.js is stale/);
    assert.match(res.stderr, /overcast: source=1\.2\.3 dist=1\.2\.2/);
    assert.match(res.stderr, /pi: source=0\.80\.3 dist=0\.80\.1/);
    assert.match(res.stderr, /missing in dist: listen/);
    assert.match(res.stderr, /extra in dist: scan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
