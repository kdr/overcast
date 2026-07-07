import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { refPathExists } from "../../src/verbs/media-ref.ts";

test("refPathExists: case-relative file yes; ../ escape and case-local symlink-out no", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-refpath-"));
  const outside = mkdtempSync(join(tmpdir(), "oc-outside-"));
  try {
    mkdirSync(join(dir, "media"), { recursive: true });
    writeFileSync(join(dir, "media", "clip.jpg"), "x");
    writeFileSync(join(outside, "secret.txt"), "s");

    // a real case-relative file → accepted
    assert.equal(refPathExists(dir, "media/clip.jpg"), true);
    // an absolute path is an explicit operator choice → accepted as-is
    assert.equal(refPathExists(dir, join(outside, "secret.txt")), true);
    // a bogus relative path → rejected
    assert.equal(refPathExists(dir, "media/nope.jpg"), false);

    // a ../ escape to a REAL file outside the case → rejected (lexical containment)
    assert.equal(refPathExists(dir, join("..", basename(outside), "secret.txt")), false);

    // a case-local SYMLINK pointing outside the case → rejected (realpath re-check)
    symlinkSync(join(outside, "secret.txt"), join(dir, "media", "link.jpg"));
    assert.equal(refPathExists(dir, "media/link.jpg"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
