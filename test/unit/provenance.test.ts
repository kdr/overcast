import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { makeRecord } from "../../src/record.ts";
import { scanHitProvenance, stampProvenance, provenanceFromCapture } from "../../src/verbs/provenance.ts";

test("scanHitProvenance lifts the source post fields from a scan hit", () => {
  const hit = makeRecord({
    verb: "scan",
    payload: { url: "https://x.com/rip/status/1", author: "codez", snippet: "loop engineering rip", title: "t", published: "Jun 22", views: 484526, source: "x" },
    media: { ref: "https://video.twimg.com/hi.mp4" },
    state: "ready",
  });
  const prov = scanHitProvenance(hit);
  assert.equal(prov.source_url, "https://x.com/rip/status/1");
  assert.equal(prov.source_author, "codez");
  assert.equal(prov.source_text, "loop engineering rip"); // snippet preferred over title
  assert.equal(prov.source_published, "Jun 22");
  assert.equal(prov.source_views, 484526);
  assert.equal(prov.source_platform, "x");
  assert.equal(prov.source_record, hit.id);
});

test("scanHitProvenance ignores non-scan records and empty fields", () => {
  assert.deepEqual(scanHitProvenance(undefined), {});
  assert.deepEqual(scanHitProvenance(makeRecord({ verb: "note", payload: { text: "x" } })), {});
  const bare = scanHitProvenance(makeRecord({ verb: "scan", payload: { url: "" }, state: "ready" }));
  assert.equal("source_url" in bare, false);
});

test("stampProvenance merges without clobbering existing payload keys", () => {
  const rec = makeRecord({ verb: "capture", payload: { path: "/a.mp4", source_author: "kept" } });
  stampProvenance(rec, { source_author: "new", source_url: "https://x.com/a/1" });
  const p = rec.payload as Record<string, unknown>;
  assert.equal(p.source_author, "kept"); // not clobbered
  assert.equal(p.source_url, "https://x.com/a/1"); // added
});

test("provenanceFromCapture traces a sensed file back to the capture's source post", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-prov-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "capture",
      payload: { capture_id: "cap_x", path: "/media/rip.mp4", source_url: "https://x.com/rip/status/1", source_author: "codez", source_text: "loop engineering", source_record: "rec_scan1" },
      media: { ref: "/media/rip.mp4" },
      state: "ready",
    }));
    const prov = provenanceFromCapture(c, "/media/rip.mp4");
    assert.equal(prov.source_url, "https://x.com/rip/status/1");
    assert.equal(prov.source_author, "codez");
    assert.equal(prov.source_text, "loop engineering");
    assert.equal(prov.source_capture, "cap_x");
    assert.equal(prov.source_record, "rec_scan1"); // prefers the upstream scan over the capture record id
    // unknown path → no provenance
    assert.deepEqual(provenanceFromCapture(c, "/media/other.mp4"), {});
    assert.deepEqual(provenanceFromCapture(c, undefined), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
