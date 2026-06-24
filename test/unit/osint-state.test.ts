import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { addTarget, listTargets, removeTarget, primaryTarget } from "../../src/state/target.ts";
import {
  parseSourceSpec,
  addSource,
  listSources,
  enabledSources,
  setEnabled,
  removeSource,
  resolveSources,
} from "../../src/state/source.ts";
import { loadSeen, saveSeen, hitKey } from "../../src/state/seen.ts";
import { tokenizeCommand } from "../../src/providers/sources/index.ts";
import { makeRecord } from "../../src/record.ts";

function withCase(fn: (c: ReturnType<typeof openCase>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "oc-osint-"));
  try {
    const c = openCase(dir);
    c.ensure();
    fn(c);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("addTarget classifies name vs prompt vs image; primary is most recent", () => {
  withCase((c) => {
    const a = addTarget(c, "@pier9");
    assert.equal(a.kind, "name");
    const b = addTarget(c, "a white van seen near the docks at night");
    assert.equal(b.kind, "prompt");
    const img = addTarget(c, "./suspect.jpg", { image: true });
    assert.equal(img.kind, "image");
    assert.equal(listTargets(c).length, 3);
    assert.equal(primaryTarget(c)?.id, img.id);
    assert.equal(removeTarget(c, a.id), true);
    assert.equal(listTargets(c).length, 2);
  });
});

test("parseSourceSpec splits type:ref (ref may contain ':')", () => {
  assert.deepEqual(parseSourceSpec("youtube:@pier9"), { type: "youtube", ref: "@pier9" });
  assert.deepEqual(parseSourceSpec('youtube:search:"pier 9"'), { type: "youtube", ref: 'search:"pier 9"' });
  assert.deepEqual(parseSourceSpec("rss:https://x.com/feed"), { type: "rss", ref: "https://x.com/feed" });
});

test("source registry add/list/enable/disable/rm + resolveSources", () => {
  withCase((c) => {
    const s1 = addSource(c, "youtube:@pier9");
    const s2 = addSource(c, "tiktok:#pier9", { name: "tt" });
    assert.equal(listSources(c).length, 2);
    assert.equal(enabledSources(c).length, 2);
    assert.equal(setEnabled(c, s2.id, false), true);
    assert.equal(enabledSources(c).length, 1);
    // resolve by type
    assert.equal(resolveSources(c, ["youtube"]).length, 1);
    // resolve default = enabled only
    assert.equal(resolveSources(c).length, 1);
    assert.equal(removeSource(c, s1.id), true);
    assert.equal(listSources(c).length, 1);
  });
});

test("seen-set round-trips and hitKey prefers url", () => {
  withCase((c) => {
    assert.equal(loadSeen(c).size, 0);
    const keys = new Set(["a", "b"]);
    saveSeen(c, keys);
    assert.deepEqual([...loadSeen(c)].sort(), ["a", "b"]);

    const rec = makeRecord({ verb: "scan", payload: { url: "http://x/1", title: "t" }, media: { ref: "m" } });
    assert.equal(hitKey(rec), "url:http://x/1");

    // No url → a content composite (prefixed), stable and title-derived.
    const noUrl = makeRecord({ verb: "scan", payload: { title: "only-title" } });
    const k = hitKey(noUrl);
    assert.match(k, /^c:/);
    assert.ok(k.includes("only-title"));
    // distinct titles → distinct keys; identical payload → identical key.
    assert.notEqual(k, hitKey(makeRecord({ verb: "scan", payload: { title: "other-title" } })));
    assert.equal(k, hitKey(makeRecord({ verb: "scan", payload: { title: "only-title" } })));

    // nothing identifying → a stable content hash (never the random rec.id).
    const bare = makeRecord({ verb: "scan", payload: {} });
    assert.match(hitKey(bare), /^h:/);
    assert.equal(hitKey(bare), hitKey(makeRecord({ verb: "scan", payload: {} })));
  });
});

test("tokenizeCommand respects quotes (spaced command paths)", () => {
  assert.deepEqual(tokenizeCommand("bash /a/b.sh"), ["bash", "/a/b.sh"]);
  assert.deepEqual(tokenizeCommand('"/My Tools/bridge" enumerate'), ["/My Tools/bridge", "enumerate"]);
  assert.deepEqual(tokenizeCommand("'a b' c"), ["a b", "c"]);
});
