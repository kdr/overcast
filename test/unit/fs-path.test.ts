// Containment guarantees for the file-serving helpers (src/fs-path.ts). Both
// the chair static-asset route and the situation /media route hand these a
// caller-influenced path, so the boundary they draw is worth pinning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContainedFile, realpathContained } from "../../src/fs-path.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "oc-fspath-"));
  const root = join(base, "assets");
  mkdirSync(root);
  const outside = join(base, "SECRET.txt");
  writeFileSync(outside, "outside-secret", "utf8");
  const inside = join(root, "ok.txt");
  writeFileSync(inside, "inside-ok", "utf8");
  return { base, root, outside, inside };
}

/** Read and close, or null when the helper refused to open. */
function served(fd: number | undefined): string | null {
  if (fd === undefined) return null;
  try {
    return readFileSync(fd).toString();
  } finally {
    closeSync(fd);
  }
}

test("openContainedFile: serves a regular file inside the root", () => {
  const { base, root, inside } = fixture();
  try {
    assert.equal(served(openContainedFile(root, inside)), "inside-ok");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("openContainedFile: follows a symlink that stays inside the root", () => {
  // resolving first is what makes legitimate symlinked assets keep working —
  // the containment check runs on the RESOLVED path, not the link
  const { base, root, inside } = fixture();
  try {
    const link = join(root, "link-inside");
    symlinkSync(inside, link);
    assert.equal(served(openContainedFile(root, link)), "inside-ok");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("openContainedFile: refuses a symlink escaping the root", () => {
  // the whole point: a link INSIDE the served dir pointing out of it must not
  // turn into a file read, however the caller spells the path
  const { base, root, outside } = fixture();
  try {
    const link = join(root, "link-outside");
    symlinkSync(outside, link);
    assert.equal(served(openContainedFile(root, link)), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("openContainedFile: refuses directories, missing paths, and traversal", () => {
  const { base, root, outside } = fixture();
  try {
    assert.equal(openContainedFile(root, root), undefined, "a directory is not servable");
    assert.equal(openContainedFile(root, join(root, "nope.txt")), undefined, "missing path");
    assert.equal(openContainedFile(root, outside), undefined, "plain path outside the root");
    assert.equal(openContainedFile(root, join(root, "..", "SECRET.txt")), undefined, "..-traversal");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("realpathContained: agrees with openContainedFile on the symlink cases", () => {
  const { base, root, inside, outside } = fixture();
  try {
    const linkIn = join(root, "l-in");
    const linkOut = join(root, "l-out");
    symlinkSync(inside, linkIn);
    symlinkSync(outside, linkOut);
    assert.equal(realpathContained(root, linkIn), true);
    assert.equal(realpathContained(root, linkOut), false);
    assert.equal(realpathContained(root, join(root, "missing")), false, "unresolvable is not contained");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
