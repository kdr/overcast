import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exifVerb, verifyVerb, geolocateVerb } from "../../src/verbs/forensics.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_EXIF = join(HERE, "..", "fixtures", "fake-exif.sh");
const FAKE_VERIFY = join(HERE, "..", "fixtures", "fake-verify.sh");
const FAKE_GEOLOCATE = join(HERE, "..", "fixtures", "fake-geolocate.sh");

function caseCtx(dir: string, input: string | undefined, bind?: { verb: string; script: string }): VerbContext {
  const c = openCase(dir);
  c.ensure();
  const profile = defaultProfile();
  if (bind) profile.providers = { ...profile.providers, [bind.verb]: { type: "exec", run: `bash ${bind.script} --input {{input}}` } };
  return { input, rest: [], opts: {}, case: c, profile };
}

test("exif dispatches to a bound provider, stamps the case, and passes the record through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists-but-not-a-real-jpeg");
    chmodSync(FAKE_EXIF, 0o755);
    const [rec] = await exifVerb.run(caseCtx(dir, img, { verb: "exif", script: FAKE_EXIF }));
    assert.equal(rec.verb, "exif");
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    assert.match(p.summary as string, /TestCam/);
    assert.deepEqual(p.gps, { lat: 1.5, lng: 2.5 });
    assert.equal(rec.media?.ref, img);
    // the shared forensic runner stamps the case dir on every record
    assert.equal((rec.meta as Record<string, unknown>)?.case, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exif errors when no input is given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-"));
  try {
    const [rec] = await exifVerb.run(caseCtx(dir, undefined));
    assert.equal(rec.state, "error");
    assert.match(rec.error as string, /requires a media input/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exif errors when the local input file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-"));
  try {
    const [rec] = await exifVerb.run(caseCtx(dir, join(dir, "nope.jpg")));
    assert.equal(rec.state, "error");
    assert.match(rec.error as string, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify dispatches to a bound provider and passes the provenance record through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-verify-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists");
    chmodSync(FAKE_VERIFY, 0o755);
    const [rec] = await verifyVerb.run(caseCtx(dir, img, { verb: "verify", script: FAKE_VERIFY }));
    assert.equal(rec.verb, "verify");
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.has_manifest, true);
    assert.equal(p.signer, "TestCA");
    assert.equal((rec.meta as Record<string, unknown>)?.case, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify errors when no input is given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-verify-"));
  try {
    const [rec] = await verifyVerb.run(caseCtx(dir, undefined));
    assert.equal(rec.state, "error");
    assert.match(rec.error as string, /requires a media input/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geolocate dispatches to a bound provider and passes the geo record through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geo-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists");
    chmodSync(FAKE_GEOLOCATE, 0o755);
    const [rec] = await geolocateVerb.run(caseCtx(dir, img, { verb: "geolocate", script: FAKE_GEOLOCATE }));
    assert.equal(rec.verb, "geolocate");
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.city, "Paris");
    assert.equal(p.lat, 48.8584);
    assert.equal((rec.meta as Record<string, unknown>)?.case, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geolocate rejects a non-image input (image resolver)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geo-"));
  try {
    const vid = join(dir, "clip.mp4");
    writeFileSync(vid, "exists");
    const [rec] = await geolocateVerb.run(caseCtx(dir, vid, { verb: "geolocate", script: FAKE_GEOLOCATE }));
    assert.equal(rec.state, "error");
    assert.match(rec.error as string, /not an image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geolocate rejects an http URL that resolves to non-image content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-geo-"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(Buffer.from([0, 0, 0, 0]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const url = `http://127.0.0.1:${port}/clip.mp4`;
    // fetched (not a local path) but not a still image → must error BEFORE the
    // provider is called, and still carry the origin url.
    const [rec] = await geolocateVerb.run(caseCtx(dir, url, { verb: "geolocate", script: FAKE_GEOLOCATE }));
    assert.equal(rec.state, "error");
    assert.match(rec.error as string, /needs an image/);
    assert.equal((rec.meta as Record<string, unknown>)?.source_url, url);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
