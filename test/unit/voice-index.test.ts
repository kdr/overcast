// voice-print (local speaker-verification DB) coverage. The uv-managed Python
// is faked (a bash stub echoing a `voice` record) so the TS verb/arg-mapping,
// config.json plumbing, and index redirects run offline with NO torch/pyannote.
// Mirrors audio-index.test.ts.

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
import { normalizeIndexType, findIndex, addMember, LOCAL_INDEX_TYPES } from "../../src/state/index.ts";
import { indexVerb } from "../../src/verbs/index.ts";
import { voiceVerb } from "../../src/verbs/voice.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// A fake OC_VISUAL_DB_PY that echoes the resolved op + forwarded flags so the
// test can assert what the verb forwarded. Also echoes $OVERCAST_INDEX_DIR so
// the pairwise no-index-env invariant is observable.
const STUB = `#!/usr/bin/env bash
script="$1"; shift
op=""; match=""; diarize="no"; speakers=""; start=""; end=""; win=""; minsim=""; minmargin=""; index=""; limit=""; offset=""; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --op) op="$2"; shift 2;;
    --match) match="$2"; shift 2;;
    --diarize) diarize="yes"; shift;;
    --speakers) speakers="$2"; shift 2;;
    --start) start="$2"; shift 2;;
    --end) end="$2"; shift 2;;
    --window) win="$2"; shift 2;;
    --min-similarity) minsim="$2"; shift 2;;
    --min-margin) minmargin="$2"; shift 2;;
    --index) index="$2"; shift 2;;
    --limit) limit="$2"; shift 2;;
    --offset) offset="$2"; shift 2;;
    --index-dir) shift 2;;
    *) input="$1"; shift;;
  esac
done
printf '{"verb":"voice","format":"json","payload":{"op":"%s","match":"%s","diarize":"%s","speakers":"%s","start":"%s","end":"%s","window":"%s","min_similarity":"%s","min_margin":"%s","index":"%s","limit":"%s","offset":"%s","index_dir_env":"%s","input":"%s","matches":[],"count":0},"state":"ready","meta":{"provider":"fake-voice"}}\\n' "$op" "$match" "$diarize" "$speakers" "$start" "$end" "$win" "$minsim" "$minmargin" "$index" "$limit" "$offset" "\${OVERCAST_INDEX_DIR:-}" "$input"
`;

// A fake that always fails (deps-missing style) to test the ready-gated add.
const STUB_FAIL = `#!/usr/bin/env bash
printf '{"verb":"voice","format":"json","payload":{"op":"add","matches":[],"count":0},"error":"voice deps missing","state":"error"}\\n'
`;

async function withStub(stubBody: string, fn: (dir: string, stub: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-voice-"));
  const stub = join(dir, "fake-voice.sh");
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

async function createIndex(dir: string, opts: VerbContext["opts"] = {}): Promise<string> {
  const [created] = await indexVerb.run(mk(dir, "create", ["voices"], { type: "voice-print", local: true, ...opts }));
  assert.equal(created.state, "ready", created.error);
  return String((created.payload as Record<string, unknown>).index);
}

// ---- index type registration ----------------------------------------------

test("normalizeIndexType maps voice aliases", () => {
  for (const a of ["voice-print", "voiceprint", "voice", "speaker", "speaker-id"]) {
    assert.equal(normalizeIndexType(a), "voice-print");
  }
  assert.ok(LOCAL_INDEX_TYPES.has("voice-print"));
});

test("index create --type voice-print --local writes + echoes the speaker config", async () => {
  await withStub(STUB, async (dir) => {
    const [created] = await indexVerb.run(mk(dir, "create", ["voices"], { type: "voice-print", local: true }));
    assert.equal(created.state, "ready", created.error);
    const id = String((created.payload as Record<string, unknown>).index);
    assert.match(id, /^local_voice_print_/);
    assert.equal(findIndex(openCase(dir), id)?.backend, "local");
    // the create record echoes the config (like basic-clip/audio-fp)…
    const echoed = (created.payload as Record<string, unknown>).config as Record<string, unknown>;
    assert.equal(echoed.model, "pyannote/wespeaker-voxceleb-resnet34-LM");
    assert.equal(echoed.window, 3);
    // …and it's persisted to disk for the provider's model guard + cache hash
    const cfg = JSON.parse(readFileSync(join(dir, ".overcast", "index", id, "config.json"), "utf8"));
    assert.equal(cfg.model, "pyannote/wespeaker-voxceleb-resnet34-LM");
    assert.equal(cfg.window, 3);
    assert.equal(cfg.step, 0.75);
    assert.equal(cfg.sampleRate, 16000);
  });
});

test("index create --type voice-print persists --window and rejects frame/pool flags", async () => {
  await withStub(STUB, async (dir) => {
    const id = await createIndex(dir, { window: 5 });
    const cfg = JSON.parse(readFileSync(join(dir, ".overcast", "index", id, "config.json"), "utf8"));
    assert.equal(cfg.window, 5);
    for (const opt of [{ pooling: "mean" }, { granularity: "frame" }, { sampling: "shots" }, { fps: 1 }] as VerbContext["opts"][]) {
      const [rec] = await indexVerb.run(mk(dir, "create", ["x"], { type: "voice-print", local: true, ...opt }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /doesn't apply to a voice-print/);
    }
  });
});

test("voice-print is local-only (attach rejected) and index add redirects to voice add", async () => {
  await withStub(STUB, async (dir) => {
    const [att] = await indexVerb.run(mk(dir, "attach", ["remote_x"], { type: "voice-print" }));
    assert.equal(att.state, "error");
    assert.match(att.error ?? "", /local-only/);

    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const id = await createIndex(dir);
    const [add] = await indexVerb.run(mk(dir, "add", [clip], { to: id }));
    assert.equal(add.state, "error");
    assert.match(add.error ?? "", /voice add/);
  });
});

// ---- voice verb guards ------------------------------------------------------

test("voice verb: bad action / missing input / wrong index type", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const [bad] = await voiceVerb.run(mk(dir, "frobnicate", [clip], { index: "x" }));
    assert.equal(bad.state, "error");
    assert.match(bad.error ?? "", /usage: voice/);

    const [noInput] = await voiceVerb.run(mk(dir, "match", [], { index: "x" }));
    assert.equal(noInput.state, "error");
    assert.match(noInput.error ?? "", /requires an audio\/video input/);

    // a basic-clap index is not a voice-print index
    const [created] = await indexVerb.run(mk(dir, "create", ["clap"], { type: "basic-clap", local: true }));
    const clapId = String((created.payload as Record<string, unknown>).index);
    const [wrong] = await voiceVerb.run(mk(dir, "match", [clip], { index: clapId }));
    assert.equal(wrong.state, "error");
    assert.match(wrong.error ?? "", /not voice-print/);
  });
});

test("voice match: sample XOR --index (both/neither is an error)", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "clip.wav");
    const sample = join(dir, "sample.wav");
    writeFileSync(clip, "x");
    writeFileSync(sample, "x");
    const id = await createIndex(dir);

    const [both] = await voiceVerb.run(mk(dir, "match", [clip, sample], { index: id }));
    assert.equal(both.state, "error");
    assert.match(both.error ?? "", /not both/);

    const [neither] = await voiceVerb.run(mk(dir, "match", [clip]));
    assert.equal(neither.state, "error");
    assert.match(neither.error ?? "", /--index .* or a reference sample/);
  });
});

test("voice add rejects a second positional and match-only flags", async () => {
  await withStub(STUB, async (dir) => {
    const a = join(dir, "a.mp3");
    const b = join(dir, "b.mp3");
    const jpg = join(dir, "q.jpg");
    for (const f of [a, b, jpg]) writeFileSync(f, "x");
    const id = await createIndex(dir);

    const [two] = await voiceVerb.run(mk(dir, "add", [a, b], { index: id }));
    assert.equal(two.state, "error");
    assert.match(two.error ?? "", /voice add takes one input/);

    const [diar] = await voiceVerb.run(mk(dir, "add", [a], { index: id, diarize: true }));
    assert.equal(diar.state, "error");
    assert.match(diar.error ?? "", /--diarize only applies to match/);

    const [sim] = await voiceVerb.run(mk(dir, "add", [a], { index: id, "min-similarity": 70 }));
    assert.equal(sim.state, "error");
    assert.match(sim.error ?? "", /match flags .* don't apply/);

    const [img] = await voiceVerb.run(mk(dir, "add", [jpg], { index: id }));
    assert.equal(img.state, "error");
    assert.match(img.error ?? "", /not a video\/audio file/);
  });
});

test("voice match flag/op mismatches are rejected, not ignored", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "clip.wav");
    const sample = join(dir, "sample.wav");
    writeFileSync(clip, "x");
    writeFileSync(sample, "x");
    const id = await createIndex(dir);
    addMember(openCase(dir), id, { ref: clip });

    // pairwise: --offset is search-only pagination
    const [off] = await voiceVerb.run(mk(dir, "match", [clip, sample], { offset: 2 }));
    assert.equal(off.state, "error");
    assert.match(off.error ?? "", /--offset only applies to an index search/);

    // --speakers is a diarization hint
    const [spk] = await voiceVerb.run(mk(dir, "match", [clip, sample], { speakers: 2 }));
    assert.equal(spk.state, "error");
    assert.match(spk.error ?? "", /add --diarize/);

    // index search: pairwise-only flags rejected (--diarize, --start, --window)
    for (const opt of [{ diarize: true }, { start: "5" }, { window: 5 }] as VerbContext["opts"][]) {
      const [rec] = await voiceVerb.run(mk(dir, "match", [sample], { index: id, ...opt }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /only applies to match/);
    }

    // bad numbers
    const [sim] = await voiceVerb.run(mk(dir, "match", [clip, sample], { "min-similarity": 150 }));
    assert.equal(sim.state, "error");
    assert.match(sim.error ?? "", /min-similarity/);
    const [blank] = await voiceVerb.run(mk(dir, "match", [clip, sample], { start: "  " }));
    assert.equal(blank.state, "error");
    assert.match(blank.error ?? "", /--start requires a timestamp/);
  });
});

// ---- voice verb wiring (fake provider) --------------------------------------

test("voice match pairwise forwards --match/--diarize/--speakers/--start/--end/--window and no index", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "clip.wav");
    const sample = join(dir, "sample.wav");
    writeFileSync(clip, "x");
    writeFileSync(sample, "x");
    const [rec] = await voiceVerb.run(mk(dir, "match", [clip, sample], {
      diarize: true, speakers: 2, start: "5", end: "60", window: 5, "min-similarity": 60, "min-margin": 10, limit: 5,
    }));
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.op, "match");
    assert.equal(p.match, sample);
    assert.equal(p.diarize, "yes");
    assert.equal(p.speakers, "2");
    assert.equal(p.start, "5");
    assert.equal(p.end, "60");
    assert.equal(p.window, "5");
    assert.equal(p.min_similarity, "60");
    assert.equal(p.min_margin, "10");
    assert.equal(p.limit, "5");
    assert.equal(p.input, clip);
    assert.equal(p.index, ""); // pairwise → no index forwarded…
    assert.equal(p.index_dir_env, ""); // …and no OVERCAST_INDEX_DIR either
  });
});

test("voice match --index dispatches op=search with pagination and the index dir env", async () => {
  await withStub(STUB, async (dir) => {
    const sample = join(dir, "sample.wav");
    writeFileSync(sample, "x");
    const id = await createIndex(dir);
    addMember(openCase(dir), id, { ref: sample });
    const [rec] = await voiceVerb.run(mk(dir, "match", [sample], { index: id, offset: 3, "min-similarity": 70 }));
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.op, "search");
    assert.equal(p.index, id);
    assert.equal(p.offset, "3");
    assert.equal(p.min_similarity, "70");
    assert.equal(p.input, sample);
    assert.ok(String(p.index_dir_env).includes(id), "search runs with OVERCAST_INDEX_DIR");
  });
});

test("voice add registers the member only on a ready embed", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    const id = await createIndex(dir);
    const [ok] = await voiceVerb.run(mk(dir, "add", [clip], { to: id }));
    assert.equal(ok.state, "ready", ok.error);
    assert.equal((ok.payload as Record<string, unknown>).op, "add");
    assert.equal(findIndex(openCase(dir), id)?.members.length, 1);
    // dedupe: a second add short-circuits as already_member
    const [dupe] = await voiceVerb.run(mk(dir, "add", [clip], { to: id }));
    assert.equal((dupe.payload as Record<string, unknown>).already_member, true);
    assert.equal(findIndex(openCase(dir), id)?.members.length, 1);
  });
});

test("voice add does NOT register the member when the embed fails", async () => {
  await withStub(STUB_FAIL, async (dir) => {
    const clip = join(dir, "a.mp3");
    writeFileSync(clip, "x");
    // create with the good stub? create doesn't invoke python — safe with FAIL stub
    const id = await createIndex(dir);
    const [rec] = await voiceVerb.run(mk(dir, "add", [clip], { index: id }));
    assert.equal(rec.state, "error");
    assert.equal(findIndex(openCase(dir), id)?.members.length, 0);
  });
});

test("voice match stamps capture provenance on the scanned clip", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "clip.wav");
    const sample = join(dir, "sample.wav");
    writeFileSync(clip, "x");
    writeFileSync(sample, "x");
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "capture", payload: { path: clip, source_url: "https://x.test/post" }, media: { ref: clip }, state: "ready" }));
    const [rec] = await voiceVerb.run(mk(dir, "match", [clip, sample]));
    assert.equal((rec.payload as Record<string, unknown>).source_url, "https://x.test/post");
  });
});

// ---- index remove cache cleanup ---------------------------------------------

test("index remove drops the cached voice embedding (shared emb/ layout)", async () => {
  await withStub(STUB, async (dir) => {
    const clip = join(dir, "clip.wav");
    writeFileSync(clip, "x");
    const id = await createIndex(dir);
    addMember(openCase(dir), id, { ref: clip });
    const key = createHash("sha1").update(clip).digest("hex");
    const npy = join(dir, ".overcast", "index", id, "emb", `${key}.npy`);
    mkdirSync(dirname(npy), { recursive: true });
    writeFileSync(npy, "x");
    const [rm] = await indexVerb.run(mk(dir, "remove", [clip], { from: id }));
    assert.equal((rm.payload as Record<string, unknown>).removed, true);
    assert.ok(!existsSync(npy), "voice embedding npy deleted");
  });
});

// ---- Python provider source invariants (cheap, offline) ---------------------

test("voice_match.py: caveat, anchored scoring, read-only queries, deps hint", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "audio-db", "voice_match.py"), "utf8");
  // every match/search payload carries the not-liveness caveat
  assert.match(src, /CAVEAT = \("speaker similarity is not liveness/);
  assert.match(src, /payload\["caveat"\] = CAVEAT/);
  // threshold-anchored score mapping, NOT (cos+1)/2
  assert.match(src, /ANCHORS = \[\(-1\.0, 0\.0\), \(0\.0, 20\.0\), \(0\.25, 50\.0\), \(0\.60, 90\.0\), \(0\.75, 100\.0\)\]/);
  // query-time member rebuilds must not write the cache
  assert.match(src, /persist=False/);
  // deps-missing hint points at the right installer flag
  assert.match(src, /run scripts\/visual-db-uv\.sh --voice/);
  // cache layout shared with basic-clip so removeClipEmbedding cleans it
  assert.match(src, /emb_dir = Path\(index_dir\) \/ "emb"/);
});

test("voice_match.py: diarize tier is gated + falls back, and handles pyannote API drift", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "audio-db", "voice_match.py"), "utf8");
  // no token → windowed fallback with a warning (record stays ready)
  assert.match(src, /diarization skipped: HF_TOKEN \+ accepted license required/);
  // token present but unaccepted license → needs_credentials
  assert.match(src, /state="needs_credentials"/);
  // pyannote 4.x DiarizeOutput vs 3.x Annotation, and centroid recompute fallback
  assert.match(src, /getattr\(diar, "speaker_diarization", diar\)/);
  assert.match(src, /getattr\(diar, "speaker_embeddings", None\)/);
  assert.match(src, /embedding_source = "recomputed"/);
  // the model guard refuses to mix embedding spaces within an index
  assert.match(src, /unset OVERCAST_VOICE_MODEL or create a new voice-print index/);
  // the persisted per-index speech floor is honored (index_config returns it,
  // and op_search threads it into reference_vector — not the hardcoded default)
  assert.match(src, /"minSpeechSeconds": float\(cfg\.get\("minSpeechSeconds"\)/);
  assert.match(src, /reference_vector\(args\.input, cfg\["window"\], cfg\["minSpeechSeconds"\]\)/);
});
