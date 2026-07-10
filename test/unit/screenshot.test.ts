import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRecord, isMemoryRecord } from "../../src/record.ts";
import { indexableFields } from "../../src/providers/memory/fields.ts";
import { isArchivableMediaRecord, isRegisterableMediaRecord } from "../../src/verbs/media-ref.ts";

function shotRecord() {
  return makeRecord({
    verb: "screenshot",
    format: "json",
    payload: {
      summary: "Example Domain — https://example.com (1280x800 viewport)",
      url: "https://example.com",
      title: "Example Domain",
      kind: "image",
      source: "browser",
      full_page: false,
      viewport: "1280x800",
    },
    media: { ref: "/case/.overcast/media/shot-abc123def456.png" },
    meta: { provider: "playwright", case: "/case" },
    state: "ready",
  });
}

test("screenshot FIELD_POLICY indexes page identity, not the file path", () => {
  const fields = indexableFields(shotRecord());
  const paths = fields.map((f) => f.path);
  // title/url/summary drive recall
  assert.ok(paths.includes("title"), "title indexed");
  assert.ok(paths.includes("url"), "url indexed");
  assert.ok(paths.includes("summary"), "summary indexed");
  // the PNG path must never enter searchable memory (matches see/exif convention)
  const blob = fields.map((f) => f.text).join("\n");
  assert.ok(!blob.includes(".png"), "no media path leaks into indexed text");
  assert.ok(!blob.includes("/media/"), "no media dir leaks into indexed text");
});

test("screenshot records are memory-eligible evidence (not operational)", () => {
  assert.equal(isMemoryRecord(shotRecord()), true, "a ready screenshot is memory evidence");
});

test("a screenshot PNG is archivable but not index-registerable (image, not AV)", () => {
  const rec = shotRecord();
  assert.equal(isArchivableMediaRecord(rec), true, "archive add --all includes screenshots");
  // MEDIA_VERBS (index/face intake) is AV-only — a still screenshot must not be
  // registered as an AV clip.
  assert.equal(isRegisterableMediaRecord(rec), false, "not an AV index candidate");
});
