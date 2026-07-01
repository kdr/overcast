// see with an http(s) URL: the image is fetched into the case media dir first
// (media/fetch.ts), so every backend reads a local file — plus clear errors for
// non-image URLs. Fully offline: a local node http server plays the remote host.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { fetchMediaToCase, kindForExt, isHttpUrl, sniffExt } from "../../src/media/fetch.ts";
import { seeVerb } from "../../src/verbs/senses.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "latin1"), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64)]);

let dir: string;
let server: Server;
let base: string;
let hits: Record<string, number>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "oc-seeurl-"));
  hits = {};
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    } else if (path === "/photo.jpg") {
      // signed-URL style: extension in the path, query noise, no content-type
      res.writeHead(200);
      res.end(JPG);
    } else if (path === "/noext") {
      // no URL ext, no content-type → magic-byte sniff decides
      res.writeHead(200);
      res.end(PNG);
    } else if (path === "/clip") {
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(MP4);
    } else if (path === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html>login required</html>");
    } else if (path === "/expired.jpg") {
      // expired signed URL: .jpg path, but the body is an HTML error page
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html>URL signature expired</html>");
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function ctx(input: string, profile = defaultProfile()): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest: [], opts: {}, case: c, profile };
}

test("isHttpUrl / kindForExt / sniffExt basics", () => {
  assert.equal(isHttpUrl("https://x.test/a.jpg"), true);
  assert.equal(isHttpUrl("/local/a.jpg"), false);
  assert.equal(kindForExt(".png"), "image");
  assert.equal(kindForExt(".mp4"), "av");
  assert.equal(kindForExt(".bin"), "other");
  assert.equal(sniffExt(PNG), ".png");
  assert.equal(sniffExt(MP4), ".mp4");
});

test("fetchMediaToCase: content-type → extension; artifact lands in mediaDir", async () => {
  const media = join(dir, "media");
  const got = await fetchMediaToCase(`${base}/img.png`, media);
  assert.equal(got.ext, ".png");
  assert.equal(got.contentType, "image/png");
  assert.ok(got.path.startsWith(media));
  assert.deepEqual(readFileSync(got.path).subarray(0, 4), PNG.subarray(0, 4));
});

test("fetchMediaToCase: URL ext survives query noise; repeat call reuses the artifact", async () => {
  const media = join(dir, "media");
  const url = `${base}/photo.jpg?Expires=123&Signature=abc~def`;
  const a = await fetchMediaToCase(url, media);
  assert.equal(a.ext, ".jpg");
  const before = hits["/photo.jpg"];
  const b = await fetchMediaToCase(url, media);
  assert.equal(b.path, a.path);
  assert.equal(hits["/photo.jpg"], before); // cache hit — no second download
});

test("fetchMediaToCase: no ext + no content-type → magic-byte sniff", async () => {
  const got = await fetchMediaToCase(`${base}/noext`, join(dir, "media"));
  assert.equal(got.ext, ".png");
});

test("fetchMediaToCase: HTTP error status throws with the status line", async () => {
  await assert.rejects(fetchMediaToCase(`${base}/missing.png`, join(dir, "media")), /404/);
});

test("see with an image URL: provider receives a LOCAL path; meta.source_url keeps the origin", async () => {
  // fake exec provider that echoes the --input path back in the payload
  const prov = join(dir, "echo-see.sh");
  writeFileSync(
    prov,
    '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = "--input" ]; then inp="$2"; fi; shift; done\n' +
      'echo "{\\"verb\\":\\"see\\",\\"payload\\":{\\"caption\\":\\"ok\\",\\"got\\":\\"$inp\\"},\\"state\\":\\"ready\\"}"\n',
  );
  chmodSync(prov, 0o755);
  const p = defaultProfile();
  p.providers = { ...p.providers, see: { type: "exec", run: `bash ${prov} --input {{input}}` } };
  const url = `${base}/img.png`;
  const [rec] = await seeVerb.run(ctx(url, p));
  assert.equal(rec.state, "ready");
  const got = (rec.payload as Record<string, unknown>).got as string;
  assert.ok(!isHttpUrl(got), `provider must get a local path, got ${got}`);
  assert.ok(basename(got).startsWith("url-"), `artifact is case media: ${got}`);
  assert.equal(rec.meta?.source_url, url);
});

test("see with a video URL: clear error pointing at watch/frame://, no ENOENT spew", async () => {
  const [rec] = await seeVerb.run(ctx(`${base}/clip`));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /watch/);
  assert.doesNotMatch(rec.error ?? "", /ENOENT/);
});

test("see with an HTML URL (login wall / expired signature): clear non-image error", async () => {
  const [rec] = await seeVerb.run(ctx(`${base}/page`));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /did not return an image/);
  assert.match(rec.error ?? "", /text\/html/);
});

test("see with an unreachable URL: clean fetch error record", async () => {
  const [rec] = await seeVerb.run(ctx("http://127.0.0.1:9/img.png")); // port 9: discard, nothing listens
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /could not fetch/);
});

test("a .jpg URL whose body is HTML is NOT masked by the URL extension (Bugbot: expired signed URL)", async () => {
  // response truth (content-type text/html) must beat the path's .jpg claim
  const got = await fetchMediaToCase(`${base}/expired.jpg?Expires=0&Signature=stale`, join(dir, "media"));
  assert.equal(got.ext, ".bin");
  assert.equal(kindForExt(got.ext), "other");
  const [rec] = await seeVerb.run(ctx(`${base}/expired.jpg?Expires=0&Signature=stale`));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /did not return an image/);
  assert.match(rec.error ?? "", /text\/html/);
});
