import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { APIFY_RUN_SYNC_TIMEOUT_MS, enumerateSource, fetchSource, tokenizeCommand } from "../../src/providers/sources/index.ts";
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

test("seen-set round-trips and hitKey prefers media.ref then url", () => {
  withCase((c) => {
    assert.equal(loadSeen(c).size, 0);
    const keys = new Set(["a", "b"]);
    saveSeen(c, keys);
    assert.deepEqual([...loadSeen(c)].sort(), ["a", "b"]);

    // media.ref wins (it's what capture/monitor actually fetch + dedup on)
    const rec = makeRecord({ verb: "scan", payload: { url: "http://x/1", title: "t" }, media: { ref: "m" } });
    assert.equal(hitKey(rec), "url:m");
    // …falling back to payload.url when there's no media.ref
    const urlOnly = makeRecord({ verb: "scan", payload: { url: "http://x/1", title: "t" } });
    assert.equal(hitKey(urlOnly), "url:http://x/1");

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

import { builtinDescriptor } from "../../src/providers/sources/index.ts";

test("builtinDescriptor resolves built-in source scripts; env override wins", () => {
  const yt = builtinDescriptor("youtube");
  const tt = builtinDescriptor("tiktok");
  const web = builtinDescriptor("web");
  const lens = builtinDescriptor("lens");
  assert.ok(yt, "youtube descriptor present in dev");
  assert.ok(tt, "tiktok descriptor present in dev");
  assert.ok(web, "web descriptor present in dev");
  assert.ok(lens, "lens descriptor present in dev");
  assert.match(yt!.base.join(" "), /youtube\.sh$/);
  assert.match(tt!.base.join(" "), /tiktok\.sh$/);
  assert.match(web!.base.join(" "), /web\.sh$/);
  assert.match(lens!.base.join(" "), /lens\.sh$/);
  assert.equal(lens!.needs, "APIFY_TOKEN");
  // Apify run-sync sources hold the request up to 300s — their exec budget
  // must beat the generic 2-min enumerate default or the harness kills them.
  assert.equal(lens!.timeoutMs, APIFY_RUN_SYNC_TIMEOUT_MS);
  assert.equal(tt!.timeoutMs, APIFY_RUN_SYNC_TIMEOUT_MS);
  assert.ok(APIFY_RUN_SYNC_TIMEOUT_MS > 5 * 60_000);
  assert.equal(builtinDescriptor("nope"), undefined);
  // env override takes precedence and is quote-aware
  process.env.OVERCAST_SOURCE_YOUTUBE_CMD = 'bash "/x y/z.sh"';
  try {
    assert.deepEqual(builtinDescriptor("youtube")!.base, ["bash", "/x y/z.sh"]);
  } finally {
    delete process.env.OVERCAST_SOURCE_YOUTUBE_CMD;
  }
});

test("enumerateSource honors the descriptor's exec budget (timeoutMs)", async () => {
  // a provider that outlives a tiny descriptor budget is killed and surfaces
  // as a timeout — proving desc.timeoutMs actually reaches execCapture
  await assert.rejects(
    enumerateSource(
      { type: "slow", base: ["node", "-e", "setTimeout(() => {}, 10_000)"], timeoutMs: 300 },
      { query: "q" },
    ),
    /timed out after 300ms/,
  );
});

test("enumerateSource passes provider-specific hit fields through to the payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-enum-extra-"));
  try {
    const script = join(dir, "enumerator.mjs");
    writeFileSync(script, `
const hits = [{
  title: "Mona Lisa - Wikipedia",
  url: "https://en.wikipedia.org/wiki/Mona_Lisa",
  snippet: "exact image match on Wikipedia",
  match: "exact",
  site: "Wikipedia",
  position: 1,
  image_size: { width: 330, height: 492 },
  media: { ref: "/tmp/lens_abc123.jpg" },
}];
console.log(JSON.stringify(hits));
`);
    const recs = await enumerateSource({ type: "lens", base: ["node", script] }, { query: "https://x/img.jpg" });
    assert.equal(recs.length, 1);
    const payload = recs[0].payload as Record<string, unknown>;
    // canonical fields still normalized
    assert.equal(payload.title, "Mona Lisa - Wikipedia");
    assert.equal(payload.source, "lens");
    assert.equal(payload.published, null);
    // extra fields ride along (loose record), media maps to media.ref not payload
    assert.equal(payload.match, "exact");
    assert.equal(payload.site, "Wikipedia");
    assert.equal(payload.position, 1);
    assert.deepEqual(payload.image_size, { width: 330, height: 492 });
    assert.equal(payload.media, undefined);
    assert.equal(recs[0].media?.ref, "/tmp/lens_abc123.jpg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchSource adds a media extension when provider writes extensionless MP4", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-fetch-ext-"));
  try {
    const script = join(dir, "fetcher.mjs");
    writeFileSync(script, `
import { writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
writeFileSync(out, Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]));
console.log(JSON.stringify({ path: out, kind: "video" }));
`);
    const out = join(dir, "download_without_ext");
    const rec = await fetchSource({ type: "tiktok", base: ["node", script] }, { url: "https://www.tiktok.com/@x/video/1", out });
    const payload = rec.payload as Record<string, unknown>;
    assert.equal(rec.state, "ready");
    assert.match(String(payload.path), /\.mp4$/);
    assert.match(rec.media?.ref ?? "", /\.mp4$/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(String(payload.path)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchSource picks a unique media extension path when sniffed target exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-fetch-ext-collision-"));
  try {
    const script = join(dir, "fetcher.mjs");
    writeFileSync(script, `
import { writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
writeFileSync(out, Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]));
console.log(JSON.stringify({ path: out, kind: "video" }));
`);
    const out = join(dir, "download_without_ext");
    writeFileSync(`${out}.mp4`, "existing different file");
    const rec = await fetchSource({ type: "tiktok", base: ["node", script] }, { url: "https://www.tiktok.com/@x/video/1", out });
    const payload = rec.payload as Record<string, unknown>;
    assert.equal(rec.state, "ready");
    assert.equal(payload.path, `${out}_1.mp4`);
    assert.equal(rec.media?.ref, `${out}_1.mp4`);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(`${out}.mp4`), true);
    assert.equal(existsSync(`${out}_1.mp4`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
