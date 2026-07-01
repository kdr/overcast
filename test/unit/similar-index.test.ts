// basic-clip (local CLIP DB) + `similar` verb coverage. The uv-managed Python is
// faked (a bash stub echoing a `similar` record) so the TS verb/arg-mapping,
// config.json plumbing, and case-setup wizard run offline with NO torch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { normalizeIndexType, findIndex, addMember, listIndexes } from "../../src/state/index.ts";
import { indexVerb } from "../../src/verbs/index.ts";
import { similarVerb } from "../../src/verbs/similar.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import type { VerbContext } from "../../src/registry/types.ts";

// A fake OC_VISUAL_DB_PY that echoes back the resolved op + config flags so the
// test can assert what the verb forwarded (index config ⊕ CLI flags).
const STUB = `#!/usr/bin/env bash
op=""; gran=""; pool=""; samp=""; win=""; framesat="no"; input=""
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  case "$arg" in
    --op) j=$((i+1)); op="\${!j}";;
    --granularity) j=$((i+1)); gran="\${!j}";;
    --pooling) j=$((i+1)); pool="\${!j}";;
    --sampling) j=$((i+1)); samp="\${!j}";;
    --window) j=$((i+1)); win="\${!j}";;
    --frames-at) framesat="yes";;
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

function mk(dir: string, input: string | undefined, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: defaultProfile() };
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
