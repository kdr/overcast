import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exifVerb, verifyVerb } from "../../src/verbs/forensics.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import type { VerbContext } from "../../src/registry/types.ts";

// These tests fetch from 127.0.0.1 fixture servers, which the media-fetch SSRF
// guard blocks by default — opt out for this offline suite.
process.env.OVERCAST_ALLOW_PRIVATE_FETCH = "1";

// minimal valid JPEG for the fetch-a-remote-record test
const TINY_JPEG = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfeffd9",
  "hex",
);

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_EXIF = join(HERE, "..", "fixtures", "fake-exif.sh");
const FAKE_VERIFY = join(HERE, "..", "fixtures", "fake-verify.sh");
const FAKE_GEOCODE = join(HERE, "..", "fixtures", "fake-geocode.sh");
const FAKE_GEOCODE_NOPLACE = join(HERE, "..", "fixtures", "fake-geocode-noplace.sh");
const FAKE_GEOCODE_NEEDS = join(HERE, "..", "fixtures", "fake-geocode-needs.sh");
const FAKE_EXIF_BADGPS = join(HERE, "..", "fixtures", "fake-exif-badgps.sh");

/** Build a ctx with an exif binding (+ optional geocode binding) and opts. */
function geocodeCtx(dir: string, img: string, opts: Record<string, unknown>, withGeocode: boolean, geocodeScript: string = FAKE_GEOCODE, exifScript: string = FAKE_EXIF): VerbContext {
  const c = openCase(dir);
  c.ensure();
  const profile = defaultProfile();
  profile.providers = {
    ...profile.providers,
    exif: { type: "exec", run: `bash ${exifScript} --input {{input}}` },
    ...(withGeocode ? { geocode: { type: "exec", run: `bash ${geocodeScript} --input {{input}}` } } : {}),
  };
  return { input: img, rest: [], opts, case: c, profile } as unknown as VerbContext;
}

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

test("exif --geocode enriches payload.place when a geocode provider is bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-geo-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists-but-not-a-real-jpeg");
    chmodSync(FAKE_EXIF, 0o755);
    chmodSync(FAKE_GEOCODE, 0o755);
    const [rec] = await exifVerb.run(geocodeCtx(dir, img, { geocode: true }, true));
    const p = rec.payload as Record<string, unknown>;
    assert.deepEqual(p.gps, { lat: 1.5, lng: 2.5 });
    assert.equal(p.place, "San Francisco, California");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exif --geocode records a status when a bound provider resolves no place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-geo-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists-but-not-a-real-jpeg");
    chmodSync(FAKE_EXIF, 0o755);
    chmodSync(FAKE_GEOCODE_NOPLACE, 0o755);
    const [rec] = await exifVerb.run(geocodeCtx(dir, img, { geocode: true }, true, FAKE_GEOCODE_NOPLACE));
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.place, null);
    assert.match(String(p.geocode_status), /no place/i); // not silently ambiguous
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exif --geocode reports a dependency gap (needs_credentials) distinctly from a lookup miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-geo-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists-but-not-a-real-jpeg");
    chmodSync(FAKE_EXIF, 0o755);
    chmodSync(FAKE_GEOCODE_NEEDS, 0o755);
    const [rec] = await exifVerb.run(geocodeCtx(dir, img, { geocode: true }, true, FAKE_GEOCODE_NEEDS));
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.place, null);
    assert.match(String(p.geocode_status), /unavailable/i); // a setup/dep gap, not "no place"
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exif --geocode does NOT egress an out-of-range GPS to the provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-geo-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists-but-not-a-real-jpeg");
    chmodSync(FAKE_EXIF_BADGPS, 0o755);
    chmodSync(FAKE_GEOCODE, 0o755);
    // exif emits gps {lat:999,...}; the geocoder would return "San Francisco…" if
    // called — so an absent place proves the bad coord was rejected before egress.
    const [rec] = await exifVerb.run(geocodeCtx(dir, img, { geocode: true }, true, FAKE_GEOCODE, FAKE_EXIF_BADGPS));
    const p = rec.payload as Record<string, unknown>;
    assert.equal("place" in p, false);
    assert.equal("geocode_status" in p, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exif --geocode with nothing bound records a hint, not a silent no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-geo-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists-but-not-a-real-jpeg");
    chmodSync(FAKE_EXIF, 0o755);
    const [rec] = await exifVerb.run(geocodeCtx(dir, img, { geocode: true }, false));
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.place, null);
    assert.match(String(p.geocode_status), /no geocode provider bound/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exif without --geocode never touches a bound geocode provider (no place field)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-geo-"));
  try {
    const img = join(dir, "p.jpg");
    writeFileSync(img, "exists-but-not-a-real-jpeg");
    chmodSync(FAKE_EXIF, 0o755);
    chmodSync(FAKE_GEOCODE, 0o755);
    const [rec] = await exifVerb.run(geocodeCtx(dir, img, {}, true));
    const p = rec.payload as Record<string, unknown>;
    assert.equal("place" in p, false);
    assert.equal("geocode_status" in p, false);
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

test("forensic sense fetches a scan-hit record's REMOTE media.ref before calling the provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(TINY_JPEG);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const url = `http://127.0.0.1:${port}/photo.jpg`;
    const c = openCase(dir);
    c.ensure();
    // a scan hit whose media.ref is a REMOTE url (the case Bugbot flagged)
    const scan = makeRecord({ verb: "scan", payload: { url, source: "web" }, media: { ref: url } });
    c.writeRecord(scan);
    chmodSync(FAKE_EXIF, 0o755);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, exif: { type: "exec", run: `bash ${FAKE_EXIF} --input {{input}}` } };
    const [rec] = await exifVerb.run({ input: scan.id, rest: [], opts: {}, case: c, profile });
    assert.equal(rec.state, "ready");
    // the provider (fake-exif echoes media.ref = its --input) must have received a
    // LOCAL fetched file, not the remote url
    assert.ok(!String(rec.media?.ref).startsWith("http"), `expected a local file, got ${rec.media?.ref}`);
    assert.equal((rec.meta as Record<string, unknown>)?.source_url, url);
    // the scan hit's post-level provenance must be carried onto the sense record
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.source_url, url);
    assert.equal(p.source_platform, "web");
    assert.equal(p.source_record, scan.id);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forensic sense falls back to a scan hit's payload.url when it has no media.ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(TINY_JPEG);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const url = `http://127.0.0.1:${port}/photo.jpg`;
    const c = openCase(dir);
    c.ensure();
    // a scan hit with NO media, only payload.url (capture/hitFetchRef would use it)
    const scan = makeRecord({ verb: "scan", payload: { url, source: "web" } });
    c.writeRecord(scan);
    chmodSync(FAKE_EXIF, 0o755);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, exif: { type: "exec", run: `bash ${FAKE_EXIF} --input {{input}}` } };
    const [rec] = await exifVerb.run({ input: scan.id, rest: [], opts: {}, case: c, profile });
    assert.equal(rec.state, "ready");
    assert.ok(!String(rec.media?.ref).startsWith("http"), `expected a local file, got ${rec.media?.ref}`);
    assert.equal((rec.meta as Record<string, unknown>)?.source_url, url);
    assert.equal((rec.payload as Record<string, unknown>).source_url, url);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media senses reject an http URL that resolves to HTML (expired/auth page)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-exif-"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>login required</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const url = `http://127.0.0.1:${port}/x.jpg`;
    const [rec] = await exifVerb.run(caseCtx(dir, url, { verb: "exif", script: FAKE_EXIF }));
    assert.equal(rec.state, "error");
    assert.match(rec.error as string, /did not resolve to media/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

