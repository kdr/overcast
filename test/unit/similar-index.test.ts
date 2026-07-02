// basic-clip (local CLIP DB) + `similar` verb coverage. The uv-managed Python is
// faked (a bash stub echoing a `similar` record) so the TS verb/arg-mapping,
// config.json plumbing, and case-setup wizard run offline with NO torch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openCase } from "../../src/case.ts";
import { defaultProfile, type Profile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { normalizeIndexType, findIndex, addMember, listIndexes } from "../../src/state/index.ts";
import { indexVerb } from "../../src/verbs/index.ts";
import { similarVerb } from "../../src/verbs/similar.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// A fake OC_VISUAL_DB_PY that echoes back the resolved op + config flags so the
// test can assert what the verb forwarded (index config ⊕ CLI flags).
const STUB = `#!/usr/bin/env bash
op=""; gran=""; pool=""; samp=""; win=""; framesat=""; input=""
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  case "$arg" in
    --op) j=$((i+1)); op="\${!j}";;
    --granularity) j=$((i+1)); gran="\${!j}";;
    --pooling) j=$((i+1)); pool="\${!j}";;
    --sampling) j=$((i+1)); samp="\${!j}";;
    --window) j=$((i+1)); win="\${!j}";;
    --frames-at) j=$((i+1)); framesat="\${!j}";;
  esac
  input="$arg"
done
printf '{"verb":"similar","format":"json","payload":{"op":"%s","granularity":"%s","pooling":"%s","sampling":"%s","window":"%s","frames_at":"%s","query":"%s","matches":[],"count":0},"state":"ready","meta":{"provider":"fake-clip"}}\\n' "$op" "$gran" "$pool" "$samp" "$win" "$framesat" "$input"
`;

async function withStub(fn: (dir: string, stub: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-clip-"));
  const stub = join(dir, "fake-clip.sh");
  writeFileSync(stub, STUB);
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

test("normalizeIndexType maps clip aliases to basic-clip", () => {
  for (const a of ["basic-clip", "basic-clip-db", "clip", "clips", "semantic"]) {
    assert.equal(normalizeIndexType(a), "basic-clip");
  }
});

test("index create --type basic-clip --local writes config.json from flags", async () => {
  await withStub(async (dir) => {
      const [created] = await indexVerb.run(
        mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, granularity: "frame", pooling: "mean", sampling: "uniform", window: 5 }),
      );
      assert.equal(created.state, "ready");
      const id = String((created.payload as Record<string, unknown>).index);
      assert.match(id, /^local_basic_clip_/);
      assert.equal(findIndex(openCase(dir), id)?.type, "basic-clip");
      const cfg = JSON.parse(readFileSync(join(dir, ".overcast", "index", id, "config.json"), "utf8"));
      assert.equal(cfg.granularity, "frame");
      assert.equal(cfg.pooling, "mean");
      assert.equal(cfg.window, 5);
  });
});

test("index create rejects an invalid basic-clip config value", async () => {
  await withStub(async (dir) => {
      const [rec] = await indexVerb.run(mk(dir, "create", ["x"], { type: "basic-clip", local: true, granularity: "bogus" }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /granularity must be one of/);
  });
});

test("similar add embeds via the local provider and registers the member", async () => {
  await withStub(async (dir) => {
      const img = join(dir, "photo.jpg");
      writeFileSync(img, "x");
      const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, granularity: "frame" }));
      const id = String((created.payload as Record<string, unknown>).index);

      const [added] = await similarVerb.run(mk(dir, "add", [img], { index: id }));
      assert.equal(added.state, "ready");
      const p = added.payload as Record<string, unknown>;
      assert.equal(p.op, "add");
      assert.equal(p.granularity, "frame"); // index config.json flowed through
      assert.equal(findIndex(openCase(dir), id)?.members.length, 1);
  });
});

test("similar search forwards the text query as the positional input", async () => {
  await withStub(async (dir) => {
      const img = join(dir, "photo.jpg");
      writeFileSync(img, "x");
      const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true }));
      const id = String((created.payload as Record<string, unknown>).index);
      addMember(openCase(dir), id, { ref: img });

      const [rec] = await similarVerb.run(mk(dir, "search", ["a", "red", "car"], { index: id }));
      assert.equal(rec.state, "ready");
      const p = rec.payload as Record<string, unknown>;
      assert.equal(p.op, "search");
      assert.equal(p.query, "a red car"); // joined + passed as the last positional
  });
});

test("similar match rejects an out-of-range --min-similarity", async () => {
  await withStub(async (dir) => {
      const img = join(dir, "q.jpg");
      writeFileSync(img, "x");
      const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true }));
      const id = String((created.payload as Record<string, unknown>).index);
      const [rec] = await similarVerb.run(mk(dir, "match", [img], { index: id, "min-similarity": 150 }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /min-similarity/);
  });
});

test("similar rejects a non-basic-clip index", async () => {
  await withStub(async (dir) => {
      const c = openCase(dir);
      c.ensure();
      const [created] = await indexVerb.run(mk(dir, "create", ["logos"], { type: "image-ransac", local: true }));
      const id = String((created.payload as Record<string, unknown>).index);
      const img = join(dir, "q.jpg");
      writeFileSync(img, "x");
      const [rec] = await similarVerb.run(mk(dir, "match", [img], { index: id }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /not basic-clip/);
  });
});

test("index add --to a basic-clip index points at `similar add`", async () => {
  await withStub(async (dir) => {
      const img = join(dir, "photo.jpg");
      writeFileSync(img, "x");
      const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true }));
      const id = String((created.payload as Record<string, unknown>).index);
      const [rec] = await indexVerb.run(mk(dir, "add", [img], { to: id }));
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /similar add/);
  });
});

test("index remove from a basic-clip index accepts a video member", async () => {
  await withStub(async (dir) => {
      const video = join(dir, "clip.mp4");
      writeFileSync(video, "x");
      const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true }));
      const id = String((created.payload as Record<string, unknown>).index);
      addMember(openCase(dir), id, { ref: video });
      const [rec] = await indexVerb.run(mk(dir, "remove", [video], { from: id }));
      assert.equal(rec.state, "ready");
      assert.equal((rec.payload as Record<string, unknown>).removed, true);
      assert.equal(findIndex(openCase(dir), id)?.members.length, 0);
  });
});

test("case setup --index stands up two basic-clip indexes with distinct configs", async () => {
  await withStub(async (dir) => {
      const c = openCase(dir);
      c.ensure();
      const [rec] = await caseVerb.run({
        input: "setup",
        rest: [],
        opts: {
          yes: true,
          index: "moments:basic-clip@granularity=frame;window=5,another:basic-clip@granularity=video;pooling=mean",
        },
        case: c,
        profile: defaultProfile(),
        home: dir,
        profileName: "default",
      });
      assert.notEqual(rec.state, "error");
      const clip = listIndexes(openCase(dir)).filter((i) => i.type === "basic-clip");
      assert.equal(clip.length, 2, "two basic-clip indexes created");
      const byName = Object.fromEntries(clip.map((i) => [i.name, i.id]));
      const cfgOf = (id: string) => JSON.parse(readFileSync(join(dir, ".overcast", "index", id, "config.json"), "utf8"));
      assert.equal(cfgOf(byName["moments"]).granularity, "frame");
      assert.equal(cfgOf(byName["moments"]).window, 5);
      assert.equal(cfgOf(byName["another"]).granularity, "video");
      assert.equal(cfgOf(byName["another"]).pooling, "mean");
      assert.ok(existsSync(join(dir, ".overcast", "index", byName["another"], "config.json")));
  });
});

// ---- Bugbot round-1 regressions ---------------------------------------------

test("similar search forwards the full sampling config (cache-key parity with add) (#B1-1)", async () => {
  await withStub(async (dir) => {
    const img = join(dir, "photo.jpg");
    writeFileSync(img, "x");
    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, sampling: "uniform", window: 7, pooling: "mean" }));
    const id = String((created.payload as Record<string, unknown>).index);
    addMember(openCase(dir), id, { ref: img });

    const [rec] = await similarVerb.run(mk(dir, "search", ["red", "car"], { index: id }));
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    // the stub echoes the flags it received — search must carry the same config
    // add uses, or a query-time cache miss re-embeds members with defaults.
    assert.equal(p.sampling, "uniform");
    assert.equal(p.window, "7");
    assert.equal(p.pooling, "mean");
  });
});

test("similar add does NOT register the member when the embed fails (#B1-3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-clip-fail-"));
  const bad = join(dir, "fail-clip.sh");
  writeFileSync(bad, `#!/usr/bin/env bash
printf '{"verb":"similar","format":"json","payload":{"op":"add","matches":[],"count":0},"error":"basic-clip deps missing","state":"error"}\\n'
`);
  chmodSync(bad, 0o755);
  const saved = process.env.OC_VISUAL_DB_PY;
  process.env.OC_VISUAL_DB_PY = bad;
  try {
    const img = join(dir, "photo.jpg");
    writeFileSync(img, "x");
    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true }));
    const id = String((created.payload as Record<string, unknown>).index);
    const [rec] = await similarVerb.run(mk(dir, "add", [img], { index: id }));
    assert.equal(rec.state, "error");
    assert.equal(findIndex(openCase(dir), id)?.members.length, 0, "failed embed must not leave a vectorless member");
  } finally {
    if (saved === undefined) delete process.env.OC_VISUAL_DB_PY;
    else process.env.OC_VISUAL_DB_PY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("similar add with sampling=shots persists the fresh watch record (#B1-4)", async () => {
  await withStub(async (dir) => {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const fakeWatch = join(dir, "fake-watch.sh");
    writeFileSync(fakeWatch, `#!/usr/bin/env bash
printf '{"verb":"watch","format":"json","payload":{"content":"x","transcript":"","detailed":{"segments":[{"start_seconds":0},{"start_seconds":12.5}]}},"state":"ready"}\\n'
`);
    chmodSync(fakeWatch, 0o755);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${fakeWatch} {{input}}` } };

    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, sampling: "shots" }));
    const id = String((created.payload as Record<string, unknown>).index);
    const recs = await similarVerb.run(mk(dir, "add", [video], { index: id }, profile));
    assert.equal(recs.length, 2, "similar record + the fresh watch record");
    assert.equal(recs[0].verb, "similar");
    assert.equal((recs[0].payload as Record<string, unknown>).frames_at, "0,12.5", "shot markers forwarded to the embedder");
    assert.equal(recs[1].verb, "watch");
    assert.equal(recs[1].media?.ref, video);
    assert.equal(recs[1].meta?.triggered_by, "similar");
  });
});

test("similar add with sampling=shots reuses ready watch evidence (no re-watch) (#B1-4)", async () => {
  await withStub(async (dir) => {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "x", detailed: { segments: [{ start_seconds: 3 }, { start_seconds: 9 }] } },
      media: { ref: video },
      state: "ready",
    }));
    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, sampling: "shots" }));
    const id = String((created.payload as Record<string, unknown>).index);
    // no watch provider bound: a re-invocation would fail loudly, so a ready
    // result carrying the record's markers proves the existing record was reused.
    const recs = await similarVerb.run(mk(dir, "add", [video], { index: id }));
    assert.equal(recs.length, 1, "no duplicate watch record");
    assert.equal(recs[0].state, "ready");
    assert.equal((recs[0].payload as Record<string, unknown>).frames_at, "3,9");
  });
});

test("similar add with sampling=shots does not re-watch while evidence is pending (#B1-4)", async () => {
  await withStub(async (dir) => {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "watch",
      format: "json",
      payload: { content: "" },
      media: { ref: video },
      state: "pending",
    }));
    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, sampling: "shots" }));
    const id = String((created.payload as Record<string, unknown>).index);
    const recs = await similarVerb.run(mk(dir, "add", [video], { index: id }));
    assert.equal(recs.length, 1, "pending watch evidence must suppress a new (double-billed) watch");
    assert.equal(recs[0].state, "ready");
    assert.equal((recs[0].payload as Record<string, unknown>).frames_at, "", "uniform fallback while shots are pending");
  });
});

test("shots reuse prefers the NEWEST ready watch with segments (#B2-2)", async () => {
  await withStub(async (dir) => {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const c = openCase(dir);
    c.ensure();
    // older watch has stale segments; a later re-watch produced better ones.
    c.writeRecord(makeRecord({
      verb: "watch", format: "json",
      payload: { content: "x", detailed: { segments: [{ start_seconds: 3 }, { start_seconds: 9 }] } },
      media: { ref: video }, state: "ready",
    }));
    c.writeRecord(makeRecord({
      verb: "watch", format: "json",
      payload: { content: "x", detailed: { segments: [{ start_seconds: 5 }, { start_seconds: 20 }] } },
      media: { ref: video }, state: "ready",
    }));
    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, sampling: "shots" }));
    const id = String((created.payload as Record<string, unknown>).index);
    const recs = await similarVerb.run(mk(dir, "add", [video], { index: id }));
    assert.equal(recs.length, 1);
    assert.equal((recs[0].payload as Record<string, unknown>).frames_at, "5,20", "the newest ready watch's segments win");
  });
});

test("shots reuse skips a segmentless ready watch in favor of one with segments (#B2-2)", async () => {
  await withStub(async (dir) => {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "watch", format: "json",
      payload: { content: "x", detailed: { segments: [{ start_seconds: 3 }, { start_seconds: 9 }] } },
      media: { ref: video }, state: "ready",
    }));
    // a later speech-only watch with no segments must not mask the earlier one
    c.writeRecord(makeRecord({
      verb: "watch", format: "json",
      payload: { content: "x", transcript: "hi", detailed: {} },
      media: { ref: video }, state: "ready",
    }));
    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true, sampling: "shots" }));
    const id = String((created.payload as Record<string, unknown>).index);
    const recs = await similarVerb.run(mk(dir, "add", [video], { index: id }));
    assert.equal(recs.length, 1);
    assert.equal((recs[0].payload as Record<string, unknown>).frames_at, "3,9");
  });
});

test("clip_match.py invalidates a cached member when explicit frames_at changed (#B2-1)", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", "clip_match.py"), "utf8");
  // frames_at is not part of config_hash, so the freshness check must compare
  // an explicit marker list against the sidecar's recorded markers.
  assert.match(src, /frames_at is not None and meta\.get\("frames_at"\) != frames_at/);
});

test("visual-db scripts recognize every video extension the TS intake gate accepts (#B3-1)", () => {
  // media-ref.ts AV_RE's video subset — a clip the verb accepts as video must not
  // be misrouted to a script's image path because its VIDEO_EXTS tuple is narrower.
  const avVideoExts = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpeg", "mpg", "m2ts", "mts", "ts", "wmv", "flv", "3gp", "3g2", "ogv", "mxf"];
  for (const script of ["clip_match.py", "image_match.py", "face_match.py"]) {
    const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", script), "utf8");
    const tuple = src.match(/VIDEO_EXTS = \(([^)]*)\)/)?.[1] ?? "";
    for (const ext of avVideoExts) {
      assert.ok(tuple.includes(`".${ext}"`), `${script} VIDEO_EXTS is missing .${ext}`);
    }
  }
});

test("clip_match.py queries never re-key or persist member embeddings (#B4-1)", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", "clip_match.py"), "utf8");
  // member-side rebuilds during a query must use the PERSISTED index config
  // (config.json), not the per-query CLI flags…
  assert.match(src, /member_args = index_config_args\(args\)/);
  assert.match(src, /build_member\(mem\["ref"\], member_args, args\.index_dir, persist=False\)/);
  // …and a query-time rebuild must stay in memory — reads never write the cache.
  assert.match(src, /def build_member\(ref, args, index_dir, frames_at=None, persist=True\)/);
  assert.match(src, /if persist:\n\s+npy\.parent\.mkdir/);
});

test("similar add rejects per-add config overrides (#B5-1)", async () => {
  await withStub(async (dir) => {
    const img = join(dir, "photo.jpg");
    writeFileSync(img, "x");
    const [created] = await indexVerb.run(mk(dir, "create", ["scenes"], { type: "basic-clip", local: true }));
    const id = String((created.payload as Record<string, unknown>).index);
    const [rec] = await similarVerb.run(mk(dir, "add", [img], { index: id, granularity: "frame" }));
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /doesn't apply per-add.*index create/);
    assert.equal(findIndex(openCase(dir), id)?.members.length, 0);
  });
});

test("clip_match.py add embeds with the persisted index config, like queries (#B5-1)", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", "clip_match.py"), "utf8");
  // add and query must key the member cache identically, or add persists a
  // config_hash searches never reuse.
  assert.match(src, /build_member\(ref, member_args, args\.index_dir, frames_at=frames_at\)/);
});

test("clip_match.py stops reusing shot markers once the config says uniform (#B5-2)", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", "clip_match.py"), "utf8");
  assert.match(src, /frames_at is None and args\.sampling == "shots"/);
});

test("case setup 'index add' signal also embeds into basic-clip routes (#B5-3)", async () => {
  await withStub(async (dir) => {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const c = openCase(dir);
    c.ensure();
    // a watch record pre-exists so no watch provider is needed for the route
    const recs = await caseVerb.run({
      input: "setup",
      rest: [],
      opts: { yes: true, index: "scenes:basic-clip", video, signals: "index add" },
      case: c,
      profile: defaultProfile(),
      home: dir,
      profileName: "default",
    });
    const setupRec = recs.find((r) => {
      const p = r.payload as Record<string, unknown> | undefined;
      return p && typeof p === "object" && Array.isArray(p.applied_operations);
    });
    assert.ok(setupRec, "setup record with applied_operations");
    const ops = (setupRec!.payload as Record<string, unknown>).applied_operations as string[];
    assert.ok(ops.some((o) => o.startsWith("indexing started") && o.includes(video)), `expected an embed op in ${JSON.stringify(ops)}`);
    const clipIndex = listIndexes(openCase(dir)).find((i) => i.type === "basic-clip");
    assert.equal(clipIndex?.members.length, 1, "the routed video was embedded and registered");
  });
});

test("case status counts similar records as evidence (#B6-1)", async () => {
  await withStub(async (dir) => {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "similar",
      format: "json",
      payload: { op: "search", summary: "2 semantic matches", query: "a red car", matches: [], count: 2 },
      media: { ref: "a red car" },
      state: "ready",
    }));
    const [status] = await caseVerb.run(mk(dir, "status"));
    const tldr = (status.payload as Record<string, unknown>).tldr as Record<string, unknown>;
    const findings = (tldr.findings as string[]).join("\n");
    assert.match(findings, /Evidence present:.*similar 1/, "similar counted in the evidence summary");
    assert.match(findings, /similar: 2 semantic matches/, "similar record surfaces in recent evidence");
  });
});

test("clip_match.py does not anchor the query record on a matched member's timestamp (#B3-2)", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", "clip_match.py"), "utf8");
  // a member's `at` lives in payload.matches[]; media anchors the QUERY only.
  assert.doesNotMatch(src, /media\["at"\]\s*=\s*results/);
});

test("case setup labels a failed basic-clip embed 'attempted' even when shots watch succeeds (#B3-3)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-clip-setuplabel-"));
  const bad = join(dir, "fail-clip.sh");
  writeFileSync(bad, `#!/usr/bin/env bash
printf '{"verb":"similar","format":"json","payload":{"op":"add","matches":[],"count":0},"error":"basic-clip deps missing","state":"error"}\\n'
`);
  chmodSync(bad, 0o755);
  const fakeWatch = join(dir, "fake-watch.sh");
  writeFileSync(fakeWatch, `#!/usr/bin/env bash
printf '{"verb":"watch","format":"json","payload":{"content":"x","detailed":{"segments":[{"start_seconds":0}]}},"state":"ready"}\\n'
`);
  chmodSync(fakeWatch, 0o755);
  const saved = process.env.OC_VISUAL_DB_PY;
  process.env.OC_VISUAL_DB_PY = bad;
  try {
    const video = join(dir, "clip.mp4");
    writeFileSync(video, "x");
    const c = openCase(dir);
    c.ensure();
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${fakeWatch} {{input}}` } };
    const recs = await caseVerb.run({
      input: "setup",
      rest: [],
      opts: { yes: true, index: "scenes:basic-clip@sampling=shots", video, signals: "similar add" },
      case: c,
      profile,
      home: dir,
      profileName: "default",
    });
    const setupRec = recs.find((r) => {
      const p = r.payload as Record<string, unknown> | undefined;
      return p && typeof p === "object" && Array.isArray(p.applied_operations);
    });
    assert.ok(setupRec, "setup record with applied_operations");
    const ops = (setupRec!.payload as Record<string, unknown>).applied_operations as string[];
    const indexing = ops.filter((o) => o.includes(video));
    assert.ok(indexing.some((o) => o.startsWith("indexing attempted")), `expected 'indexing attempted' in ${JSON.stringify(indexing)}`);
    assert.ok(!indexing.some((o) => o.startsWith("indexing started")), "a ready auxiliary watch record must not mask the failed embed");
  } finally {
    if (saved === undefined) delete process.env.OC_VISUAL_DB_PY;
    else process.env.OC_VISUAL_DB_PY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clip_match.py persists + reuses shot markers across cache rebuilds (#B1-2)", () => {
  const src = readFileSync(join(HERE, "..", "..", "examples", "providers", "visual-db", "clip_match.py"), "utf8");
  // the sidecar must record the markers a member was embedded with…
  assert.match(src, /"frames_at":\s*frames_at/);
  // …and a stale query-time rebuild must reuse them instead of a uniform grid.
  assert.match(src, /meta\.get\("frames_at"\)/);
});
