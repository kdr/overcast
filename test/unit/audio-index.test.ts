// audio-fp (local fingerprint DB) + basic-clap (local CLAP DB) coverage. The
// uv-managed Python is faked (a bash stub echoing an `audio`/`similar` record) so
// the TS verb/arg-mapping, config.json plumbing, and index redirects run offline
// with NO numpy/scipy/torch. Mirrors similar-index.test.ts / face-index.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { openCase } from "../../src/case.ts";
import { defaultProfile, type Profile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { normalizeIndexType, findIndex, addMember, addIndex, LOCAL_INDEX_TYPES } from "../../src/state/index.ts";
import { indexVerb } from "../../src/verbs/index.ts";
import { audioVerb } from "../../src/verbs/audio.ts";
import { similarVerb } from "../../src/verbs/similar.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// A fake OC_VISUAL_DB_PY that echoes the resolved op + forwarded flags so the
// test can assert what the verb forwarded. $1 is the script path (audio_match.py
// or clap_match.py) → picks the record `verb`.
const STUB = `#!/usr/bin/env bash
script="$1"; shift
op=""; against=""; minvotes=""; minratio=""; minmargin=""; minsim=""; index=""; gran=""; samp=""; win=""; draw="no"; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --op) op="$2"; shift 2;;
    --against) against="$2"; shift 2;;
    --min-votes) minvotes="$2"; shift 2;;
    --min-ratio) minratio="$2"; shift 2;;
    --min-margin) minmargin="$2"; shift 2;;
    --min-similarity) minsim="$2"; shift 2;;
    --index) index="$2"; shift 2;;
    --granularity) gran="$2"; shift 2;;
    --sampling) samp="$2"; shift 2;;
    --window) win="$2"; shift 2;;
    --draw) draw="yes"; shift;;
    --index-dir|--limit|--offset|--pooling) shift 2;;
    *) input="$1"; shift;;
  esac
done
case "$script" in
  *clap_match.py) verb="similar";;
  *) verb="audio";;
esac
printf '{"verb":"%s","format":"json","payload":{"op":"%s","against":"%s","min_votes":"%s","min_ratio":"%s","min_margin":"%s","min_similarity":"%s","index":"%s","granularity":"%s","sampling":"%s","window":"%s","draw":"%s","input":"%s","matches":[],"count":0},"state":"ready","meta":{"provider":"fake-audio"}}\\n' "$verb" "$op" "$against" "$minvotes" "$minratio" "$minmargin" "$minsim" "$index" "$gran" "$samp" "$win" "$draw" "$input"
`;

// A fake that always fails (deps-missing style) to test the ready-gated add.
const STUB_FAIL = `#!/usr/bin/env bash
script="$1"
case "$script" in
  *clap_match.py) verb="similar";;
  *) verb="audio";;
esac
printf '{"verb":"%s","format":"json","payload":{"op":"add","matches":[],"count":0},"error":"deps missing","state":"error"}\\n' "$verb"
`;

async function withStub(stubBody: string, fn: (dir: string, stub: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-audio-"));
  const stub = join(dir, "fake-audio.sh");
  writeFileSync(stub, stubBody);
  chmodSync(stub, 0o755);
  const saved = process.env.OC_VISUAL_DB_PY;
  process.env.OC_VISUAL_DB_PY = stub;
  try {
    await fn(dir, stub);
  } finally {
    if (saved === undefined) delete process.env.OC_VISUAL_DB_PY;
    else process.env.OC_VISUAL_DB_PY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

function mk(dir: string, input: string | undefined, rest: string[] = [], opts: VerbContext["opts"] = {}, profile?: Profile): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: profile ?? defaultProfile() };
}

async function createIndex(dir: string, type: string, opts: VerbContext["opts"] = {}): Promise<string> {
  const [created] = await indexVerb.run(mk(dir, "create", ["idx"], { type, local: true, ...opts }));
  assert.equal(created.state, "ready", created.error);
  return String((created.payload as Record<string, unknown>).index);
}

// ---- index type registration ----------------------------------------------

test("normalizeIndexType maps audio aliases", () => {
  for (const a of ["audio-fp", "audio", "audio-fingerprint", "fingerprint"]) assert.equal(normalizeIndexType(a), "audio-fp");
  for (const a of ["basic-clap", "clap", "audio-clip", "audio-semantic"]) assert.equal(normalizeIndexType(a), "basic-clap");
  assert.ok(LOCAL_INDEX_TYPES.has("audio-fp"));
  assert.ok(LOCAL_INDEX_TYPES.has("basic-clap"));
});

test("index create --type audio-fp --local writes the fingerprint config.json", async () => {
  await withStub(STUB, async (dir) => {
    const id = await createIndex(dir, "audio-fp");
    assert.match(id, /^local_audio_fp_/);
    assert.equal(findIndex(openCase(dir), id)?.backend, "local");
    const cfg = JSON.parse(readFileSync(join(dir, ".overcast", "index", id, "config.json"), "utf8"));
    assert.equal(cfg.sampleRate, 11025);
    assert.equal(cfg.fanOut, 15);
  });
});

test("index create --type basic-clap --local writes clap defaults (pooling mean)", async () => {
  await withStub(STUB, async (dir) => {
    const id = await createIndex(dir, "basic-clap");
    assert.match(id, /^local_basic_clap_/);
    const cfg = JSON.parse(readFileSync(join(dir, ".overcast", "index", id, "config.json"), "utf8"));
    assert.equal(cfg.pooling, "mean");
    assert.equal(cfg.granularity, "video");
    assert.equal(cfg.window, 10);
  });
});

test("index create --type basic-clap rejects a frame-sampling flag", async () => {
  await withStub(STUB, async (dir) => {
    const [rec] = await indexVerb.run(mk(dir, "create", ["x"], { type: "basic-clap", local: true, sampling: "shots" }));
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /doesn't apply to a basic-clap/);
  });
});

test("audio-fp and basic-clap are local-only (attach rejected)", async () => {
  await withStub(STUB, async (dir) => {
    for (const type of ["audio-fp", "basic-clap"]) {
      const [rec] = await indexVerb.run(mk(dir, "attach", ["remote_x"], { type }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /local-only/);
    }
  });
});

test("index add redirects to the fingerprint/embed verbs", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const fpId = await createIndex(dir, "audio-fp");
    const [fp] = await indexVerb.run(mk(dir, "add", [clip], { to: fpId }));
    assert.equal(fp.state, "error");
    assert.match(fp.error ?? "", /audio add/);

    const clapId = await createIndex(dir, "basic-clap");
    const [clap] = await indexVerb.run(mk(dir, "add", [clip], { to: clapId }));
    assert.equal(clap.state, "error");
    assert.match(clap.error ?? "", /similar add/);
  });
});

// ---- audio verb guards -----------------------------------------------------

test("audio verb: bad action / missing input / wrong index type", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const [bad] = await audioVerb.run(mk(dir, "frobnicate", [clip], { index: "x" }));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /usage: audio/);

    const [noInput] = await audioVerb.run(mk(dir, "match", [], { index: "x" }));
    assert.equal(noInput.state, "error");
    assert.match(noInput.error ?? "", /requires an audio\/video input/);

    // a basic-clap index is not an audio-fp index
    const clapId = await createIndex(dir, "basic-clap");
    const [wrong] = await audioVerb.run(mk(dir, "match", [clip], { index: clapId }));
    assert.equal(wrong.state, "error");
    assert.match(wrong.error ?? "", /not audio-fp/);
  });
});

test("audio match: reference XOR --index (both/neither is an error)", async () => {
  await withStub(STUB, async (dir) => {
    const q = join(dir, "q.wav");
    const r = join(dir, "r.wav");
    writeFileSync(q, "x");
    writeFileSync(r, "x");
    const id = await createIndex(dir, "audio-fp");

    const [both] = await audioVerb.run(mk(dir, "match", [q, r], { index: id }));
    assert.equal(both.state, "error");
    assert.match(both.error ?? "", /not both/);

    const [neither] = await audioVerb.run(mk(dir, "match", [q]));
    assert.equal(neither.state, "error");
    assert.match(neither.error ?? "", /--index .* or a second clip/);
  });
});

test("audio add rejects a reference positional and a bad --min-votes / image input", async () => {
  await withStub(STUB, async (dir) => {
    const a = join(dir, "a.mp3");
    const b = join(dir, "b.mp3");
    const jpg = join(dir, "q.jpg");
    for (const f of [a, b, jpg]) writeFileSync(f, "x");
    const id = await createIndex(dir, "audio-fp");

    const [ref] = await audioVerb.run(mk(dir, "add", [a, b], { to: id }));
    assert.equal(ref.state, "error");
    assert.match(ref.error ?? "", /audio add takes one input/);

    const [votes] = await audioVerb.run(mk(dir, "match", [a], { index: id, "min-votes": 0 }));
    assert.equal(votes.state, "error");
    assert.match(votes.error ?? "", /min-votes/);

    const [img] = await audioVerb.run(mk(dir, "add", [jpg], { to: id }));
    assert.equal(img.state, "error");
    assert.match(img.error ?? "", /not a video\/audio file/);
  });
});

// ---- audio verb wiring (fake provider) -------------------------------------

test("audio match forwards --op/--min-votes/--min-margin to the provider (indexed)", async () => {
  await withStub(STUB, async (dir) => {
    const q = join(dir, "q.wav");
    writeFileSync(q, "x");
    const id = await createIndex(dir, "audio-fp");
    addMember(openCase(dir), id, { ref: q });
    const [rec] = await audioVerb.run(mk(dir, "match", [q], { index: id, "min-votes": 8, "min-margin": 2 }));
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.op, "match");
    assert.equal(p.min_votes, "8");
    assert.equal(p.min_margin, "2"); // the speed-drift gate is forwarded
    assert.equal(p.against, ""); // indexed mode → no pairwise reference
  });
});

test("audio match forwards --draw to the provider", async () => {
  await withStub(STUB, async (dir) => {
    const q = join(dir, "q.wav");
    writeFileSync(q, "x");
    const id = await createIndex(dir, "audio-fp");
    addMember(openCase(dir), id, { ref: q });
    const [rec] = await audioVerb.run(mk(dir, "match", [q], { index: id, draw: true }));
    assert.equal(rec.state, "ready", rec.error);
    assert.equal((rec.payload as Record<string, unknown>).draw, "yes");
    // no --draw → not forwarded
    const [plain] = await audioVerb.run(mk(dir, "match", [q], { index: id }));
    assert.equal((plain.payload as Record<string, unknown>).draw, "no");
  });
});

test("audio match rejects a --min-margin below 1", async () => {
  await withStub(STUB, async (dir) => {
    const q = join(dir, "q.wav");
    writeFileSync(q, "x");
    const id = await createIndex(dir, "audio-fp");
    addMember(openCase(dir), id, { ref: q });
    const [rec] = await audioVerb.run(mk(dir, "match", [q], { index: id, "min-margin": 0.5 }));
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /min-margin/);
  });
});

test("audio match pairwise forwards --against and no index dir", async () => {
  await withStub(STUB, async (dir) => {
    const q = join(dir, "q.wav");
    const r = join(dir, "r.wav");
    writeFileSync(q, "x");
    writeFileSync(r, "x");
    const [rec] = await audioVerb.run(mk(dir, "match", [q, r]));
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.op, "match");
    assert.equal(p.against, r);
    assert.equal(p.index, ""); // pairwise → no index forwarded
  });
});

test("audio add registers the member only on a ready fingerprint", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const id = await createIndex(dir, "audio-fp");
    const [ok] = await audioVerb.run(mk(dir, "add", [clip], { to: id }));
    assert.equal(ok.state, "ready");
    assert.equal(findIndex(openCase(dir), id)?.members.length, 1);
    // dedupe: a second add short-circuits as already_member
    const [dupe] = await audioVerb.run(mk(dir, "add", [clip], { to: id }));
    assert.equal((dupe.payload as Record<string, unknown>).already_member, true);
    assert.equal(findIndex(openCase(dir), id)?.members.length, 1);
  });
});

test("audio add does NOT register the member when the fingerprint fails", async () => {
  await withStub(STUB_FAIL, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const id = await createIndex(dir, "audio-fp");
    const [rec] = await audioVerb.run(mk(dir, "add", [clip], { to: id }));
    assert.equal(rec.state, "error");
    assert.equal(findIndex(openCase(dir), id)?.members.length, 0);
  });
});

test("audio match stamps capture provenance on the query", async () => {
  await withStub(STUB, async (dir) => {
    const q = join(dir, "q.wav");
    writeFileSync(q, "x");
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "capture", payload: { path: q, source_url: "https://x.test/post" }, media: { ref: q }, state: "ready" }));
    const id = await createIndex(dir, "audio-fp");
    addMember(openCase(dir), id, { ref: q });
    const [rec] = await audioVerb.run(mk(dir, "match", [q], { index: id }));
    assert.equal((rec.payload as Record<string, unknown>).source_url, "https://x.test/post");
  });
});

// ---- similar (basic-clap) guards + wiring ----------------------------------

test("similar rejects a frame-sampling flag against a basic-clap index", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const id = await createIndex(dir, "basic-clap");
    for (const opt of [{ fps: 1 }, { sampling: "shots" }] as VerbContext["opts"][]) {
      const [rec] = await similarVerb.run(mk(dir, "match", [clip], { index: id, ...opt }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /basic-clap \(audio\) index/);
    }
  });
});

test("similar match against basic-clap rejects an image and dispatches to clap", async () => {
  await withStub(STUB, async (dir) => {
    const jpg = join(dir, "q.jpg");
    const wav = join(dir, "q.wav");
    writeFileSync(jpg, "x");
    writeFileSync(wav, "x");
    const id = await createIndex(dir, "basic-clap");
    addMember(openCase(dir), id, { ref: wav });

    const [img] = await similarVerb.run(mk(dir, "match", [jpg], { index: id }));
    assert.equal(img.state, "error");
    assert.match(img.error ?? "", /not a video\/audio file/);

    const [rec] = await similarVerb.run(mk(dir, "match", [wav], { index: id }));
    assert.equal(rec.state, "ready", rec.error);
    assert.equal((rec.payload as Record<string, unknown>).op, "match");
  });
});

test("similar search reaches the clap provider with --op search", async () => {
  await withStub(STUB, async (dir) => {
    const wav = join(dir, "q.wav");
    writeFileSync(wav, "x");
    const id = await createIndex(dir, "basic-clap");
    addMember(openCase(dir), id, { ref: wav });
    const [rec] = await similarVerb.run(mk(dir, "search", ["crowd", "chanting"], { index: id }));
    assert.equal(rec.state, "ready", rec.error);
    assert.equal((rec.payload as Record<string, unknown>).op, "search");
  });
});

test("similar accepts a NEGATIVE --min-similarity (CLAP text→audio scores near/below 0)", async () => {
  await withStub(STUB, async (dir) => {
    const wav = join(dir, "q.wav");
    writeFileSync(wav, "x");
    const id = await createIndex(dir, "basic-clap");
    addMember(openCase(dir), id, { ref: wav });
    // -100 must be accepted (not rejected as out-of-range) and forwarded so a
    // negative-cosine best match is retrievable instead of filtered to [].
    const [rec] = await similarVerb.run(mk(dir, "search", ["a person speaking"], { index: id, "min-similarity": -100 }));
    assert.equal(rec.state, "ready", rec.error);
    assert.equal((rec.payload as Record<string, unknown>).min_similarity, "-100");
    // out-of-range still rejected
    const [bad] = await similarVerb.run(mk(dir, "search", ["x"], { index: id, "min-similarity": -101 }));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /min-similarity/);
  });
});

test("similar add embeds an audio member into a basic-clap index (ready-gated)", async () => {
  await withStub(STUB, async (dir) => {
    const wav = join(dir, "clip.wav");
    writeFileSync(wav, "x");
    const id = await createIndex(dir, "basic-clap");
    const [rec] = await similarVerb.run(mk(dir, "add", [wav], { index: id }));
    assert.equal(rec.state, "ready", rec.error);
    assert.equal(findIndex(openCase(dir), id)?.members.length, 1);
  });
});

// ---- index remove cache cleanup --------------------------------------------

test("index remove drops the cached fingerprint / embedding", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "clip.wav");
    writeFileSync(clip, "x");
    // audio-fp: fp/<sha1>.npz
    const fpId = await createIndex(dir, "audio-fp");
    addMember(openCase(dir), fpId, { ref: clip });
    const key = createHash("sha1").update(clip).digest("hex");
    const npz = join(dir, ".overcast", "index", fpId, "fp", `${key}.npz`);
    mkdirSync(dirname(npz), { recursive: true });
    writeFileSync(npz, "x");
    const [rmFp] = await indexVerb.run(mk(dir, "remove", [clip], { from: fpId }));
    assert.equal((rmFp.payload as Record<string, unknown>).removed, true);
    assert.ok(!existsSync(npz), "fingerprint npz deleted");

    // basic-clap: emb/<sha1>.npy (shared basic-clip layout)
    const clapId = await createIndex(dir, "basic-clap");
    addMember(openCase(dir), clapId, { ref: clip });
    const npy = join(dir, ".overcast", "index", clapId, "emb", `${key}.npy`);
    mkdirSync(dirname(npy), { recursive: true });
    writeFileSync(npy, "x");
    const [rmClap] = await indexVerb.run(mk(dir, "remove", [clip], { from: clapId }));
    assert.equal((rmClap.payload as Record<string, unknown>).removed, true);
    assert.ok(!existsSync(npy), "clap npy deleted");
  });
});

// ---- Python provider source invariants (cheap, offline) --------------------

test("audio_match.py anchors media on the query and never persists at query time", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "audio-db", "audio_match.py"), "utf8");
  // media anchors the QUERY input (member offsets live in matches[])
  assert.match(src, /"media": \{"ref": args\.input\}/);
  // query-time member rebuilds must not write the cache
  assert.match(src, /persist=False/);
  // deps-missing hint points at the right installer flag
  assert.match(src, /run scripts\/visual-db-uv\.sh --audio/);
});

test("audio_match.py gates confirmation on margin and warns on a 0-hash (silent) add", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "audio-db", "audio_match.py"), "utf8");
  // the confirm criterion must include the margin gate (rejects speed-drift
  // partial alignments the raw vote floor would otherwise confirm)…
  assert.match(src, /aligned_votes >= min_votes and match_ratio >= min_ratio and margin >= min_margin/);
  // …and a silent/tonal member (0 hashes) must be flagged, not silently registered
  assert.match(src, /if hashes\.size == 0:/);
  assert.match(src, /"warning"\] = "no fingerprint hashes/);
});

test("audio_match.py --draw renders a dependency-free SVG under audio-matches/", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "audio-db", "audio_match.py"), "utf8");
  // the alignment visualization is hand-rolled SVG (no matplotlib dep) written to
  // the case media store, surfaced to the record as match_draw_path
  assert.match(src, /def render_match_svg\(/);
  assert.match(src, /"audio-matches"/);
  assert.match(src, /item\["match_draw_path"\] = p/);
  assert.match(src, /<svg xmlns=/);
});

test("clap_match.py uses the basic-clip emb/ cache layout and clap deps hint", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "audio-db", "clap_match.py"), "utf8");
  assert.match(src, /emb_dir = Path\(index_dir\) \/ "emb"/);
  assert.match(src, /"%s\.npy" % key/);
  assert.match(src, /run scripts\/visual-db-uv\.sh --clap/);
});

test("clap_match.py handles the transformers v4↔v5 CLAP API differences", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "audio-db", "clap_match.py"), "utf8");
  // v5 renamed the processor kwarg audios→audio (fall back for pinned v4)…
  assert.match(src, /processor\(audio=batch/);
  assert.match(src, /processor\(audios=batch/);
  // …and get_audio/text_features returns an output object (pooler_output) in v5,
  // a bare tensor in v4 — both must be unwrapped to the projected embedding.
  assert.match(src, /def _features\(out\)/);
  assert.match(src, /"audio_embeds", "text_embeds", "pooler_output"/);
});
