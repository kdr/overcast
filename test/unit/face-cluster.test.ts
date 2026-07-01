// Face-cluster coverage. The local deepface provider is faked two ways:
//   1. a bash stub set as OC_VISUAL_DB_PY that echoes back the --op + flags, so
//      the `cluster` verb's op-resolution + arg-forwarding runs offline;
//   2. a fake `deepface` module on PYTHONPATH, so the REAL face_cluster.py
//      assign-or-create + store I/O runs under bare python3 (no numpy/TF).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { addIndex, findIndex, normalizeIndexType } from "../../src/state/index.ts";
import { clusterVerb } from "../../src/verbs/cluster.ts";
import { indexVerb } from "../../src/verbs/index.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import { isMemoryRecord, makeRecord } from "../../src/record.ts";
import { indexableFields } from "../../src/providers/memory/fields.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLUSTER_PY = join(HERE, "..", "..", "examples", "providers", "visual-db", "face_cluster.py");

// a "python" stub: argv[1] is the real script path (ignored); it parses the
// flags face_cluster.py would get and echoes them back inside a cluster record.
function fakeClusterPy(dir: string): string {
  const path = join(dir, "fake-cluster");
  writeFileSync(path, `#!/usr/bin/env bash
op=""; index=""; indexdir=""; cluster=""; label=""; minsim=""; srcrec=""; input=""
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  case "$arg" in
    --op) j=$((i+1)); op="\${!j}";;
    --index) j=$((i+1)); index="\${!j}";;
    --index-dir) j=$((i+1)); indexdir="\${!j}";;
    --cluster) j=$((i+1)); cluster="\${!j}";;
    --label) j=$((i+1)); label="\${!j}";;
    --min-similarity) j=$((i+1)); minsim="\${!j}";;
    --source-record) j=$((i+1)); srcrec="\${!j}";;
  esac
done
input="\${!#}"
printf '{"verb":"cluster","format":"json","payload":{"op":"%s","index":"%s","index_dir_seen":%s,"cluster":"%s","label":"%s","min_similarity":"%s","source_record":"%s","input":"%s","count":5,"named":3,"clusters":[{"cluster_id":"p_1","label":null,"size":1,"sample_crops":[],"at_span":null,"sources":[]}]},"state":"ready","meta":{"provider":"fake-cluster","model":"FakeNet"}}\\n' \\
  "$op" "$index" "$([ -n "$indexdir" ] && echo true || echo false)" "$cluster" "$label" "\${minsim:-}" "\${srcrec:-}" "$input"
`);
  chmodSync(path, 0o755);
  return path;
}

async function withStub<T>(stub: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OC_VISUAL_DB_PY;
  process.env.OC_VISUAL_DB_PY = stub;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OC_VISUAL_DB_PY;
    else process.env.OC_VISUAL_DB_PY = saved;
  }
}

// ---- index type registration ----------------------------------------------

test("normalizeIndexType maps cluster aliases to face-cluster", () => {
  assert.equal(normalizeIndexType("face-cluster"), "face-cluster");
  assert.equal(normalizeIndexType("cluster"), "face-cluster");
  assert.equal(normalizeIndexType("clusters"), "face-cluster");
  assert.equal(normalizeIndexType("faces"), "face-analysis"); // unchanged
});

test("index create --type face-cluster --local mints a local face-cluster index", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-create-"));
  const mk = (input: string, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext => {
    const c = openCase(cdir); c.ensure();
    return { input, rest, opts, case: c, profile: defaultProfile() };
  };
  try {
    const [created] = await indexVerb.run(mk("create", ["people"], { type: "face-cluster", local: true }));
    assert.equal(created.state, "ready");
    const id = String((created.payload as Record<string, unknown>).index);
    assert.match(id, /^local_face_cluster_/);
    const entry = findIndex(openCase(cdir), id);
    assert.equal(entry?.backend, "local");
    assert.equal(entry?.type, "face-cluster");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("index add to a face-cluster index errors, pointing at `cluster add`", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-add-"));
  const img = join(cdir, "q.jpg"); writeFileSync(img, "x");
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "local_face_cluster_x", name: "people", type: "face-cluster", backend: "local" });
    const [rec] = await indexVerb.run({ input: "add", rest: [img], opts: { to: "local_face_cluster_x" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /cluster add/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("case setup provisions a local face-cluster index alongside another index", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-wizard-"));
  const mk = (opts: VerbContext["opts"]): VerbContext => {
    const c = openCase(cdir); c.ensure();
    return { input: "setup", rest: [], opts, case: c, profile: defaultProfile() };
  };
  try {
    // both types are LOCAL so apply never spawns tinycloud (a media-descriptions
    // sibling would ENOENT in CI, where no tinycloud binary exists).
    const [rec] = await caseVerb.run(mk({ index: "faces:face-cluster,logos:image-ransac", yes: true }));
    assert.equal(rec.state, "ready");
    const fc = findIndex(openCase(cdir), "faces");
    assert.equal(fc?.type, "face-cluster");
    assert.equal(fc?.backend, "local"); // stood up as a real local DB
    // the wizard routes the DB via the `cluster add` signal, never `index add`
    const setup = JSON.parse(readFileSync(join(cdir, ".overcast", "setup.json"), "utf8")) as Record<string, unknown>;
    const idxs = (setup.indexes ?? []) as Array<Record<string, unknown>>;
    const faceIdx = idxs.find((i) => i.type === "face-cluster");
    assert.deepEqual(faceIdx?.default_signals, ["cluster add"]);

    // an EXPLICIT-ID spec (id:type:name) must stamp backend local for local-only
    // types too — a backend-less face-cluster mirror entry would be rejected by
    // every cluster op as "remote" (#PR33 R9).
    const [rec2] = await caseVerb.run(mk({ index: "local_face_cluster_pre:face-cluster:premade", yes: true }));
    assert.equal(rec2.state, "ready");
    const pre = findIndex(openCase(cdir), "local_face_cluster_pre");
    assert.equal(pre?.type, "face-cluster");
    assert.equal(pre?.backend, "local", "explicit-id setup spec must stamp backend local");
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- cluster verb op-resolution (bash stub) -------------------------------

function clusterCase(cdir: string) {
  const c = openCase(cdir); c.ensure();
  addIndex(c, { id: "local_face_cluster_1", name: "people", type: "face-cluster", backend: "local" });
  return () => openCase(cdir);
}

test("cluster add resolves the sole face-cluster index and runs op=ingest", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-ingest-"));
  const openC = clusterCase(cdir);
  const img = join(cdir, "alice.jpg"); writeFileSync(img, "x");
  const stub = fakeClusterPy(cdir);
  try {
    await withStub(stub, async () => {
      const [rec] = await clusterVerb.run({ input: "add", rest: [img], opts: {}, case: openC(), profile: defaultProfile() });
      assert.equal(rec.state, "ready");
      const p = rec.payload as Record<string, unknown>;
      assert.equal(p.op, "ingest");
      assert.equal(p.index, "local_face_cluster_1"); // auto-picked
      assert.equal(p.index_dir_seen, true);
      assert.equal(p.input, img);
    });
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("cluster list/recluster/show/label forward the right op + flags", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-ops-"));
  const openC = clusterCase(cdir);
  const stub = fakeClusterPy(cdir);
  try {
    await withStub(stub, async () => {
      const list = (await clusterVerb.run({ input: "list", rest: [], opts: { index: "local_face_cluster_1" }, case: openC(), profile: defaultProfile() }))[0];
      assert.equal((list.payload as Record<string, unknown>).op, "list");
      assert.equal(list.media, undefined); // non-media op: placeholder ref stripped

      const rc = (await clusterVerb.run({ input: "recluster", rest: [], opts: { index: "local_face_cluster_1", "min-similarity": 55 }, case: openC(), profile: defaultProfile() }))[0];
      const rp = rc.payload as Record<string, unknown>;
      assert.equal(rp.op, "recluster");
      assert.equal(rp.min_similarity, "55");

      const show = (await clusterVerb.run({ input: "show", rest: ["p_1"], opts: {}, case: openC(), profile: defaultProfile() }))[0];
      assert.equal((show.payload as Record<string, unknown>).op, "show");
      assert.equal((show.payload as Record<string, unknown>).cluster, "p_1");

      const label = (await clusterVerb.run({ input: "label", rest: ["p_1", "Alice"], opts: {}, case: openC(), profile: defaultProfile() }))[0];
      const lp = label.payload as Record<string, unknown>;
      assert.equal(lp.op, "label");
      assert.equal(lp.cluster, "p_1");
      assert.equal(lp.label, "Alice");
    });
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("cluster view renders a self-contained HTML gallery record", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-view-"));
  const openC = clusterCase(cdir);
  const stub = fakeClusterPy(cdir);
  try {
    await withStub(stub, async () => {
      const [rec] = await clusterVerb.run({ input: "view", rest: [], opts: { index: "local_face_cluster_1", "no-open": true }, case: openC(), profile: defaultProfile() });
      assert.equal(rec.state, "ready");
      const p = rec.payload as Record<string, unknown>;
      assert.equal(p.op, "view");
      // whole-store totals from the list payload (count=5, named=3), NOT the
      // 1-entry page — the gallery must not understate a big DB (#PR33 R3).
      assert.equal(p.people, 5);
      assert.match(String(p.summary), /5 people/);
      const viewer = String(p.viewer);
      assert.ok(existsSync(viewer), "gallery html written");
      const html = readFileSync(viewer, "utf8");
      assert.match(html, /data-cluster-gallery="true"/);
      assert.match(html, /PEOPLE<\/span><strong>5</);
      assert.match(html, /NAMED<\/span><strong>3</);
      assert.match(html, /showing 1 of 5 people/);
    });
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("cluster view re-attributes a failing internal list to op=view (#PR33 R8)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-viewfail-"));
  const openC = clusterCase(cdir);
  const stub = join(cdir, "fail-cluster");
  writeFileSync(stub, `#!/usr/bin/env bash
printf '{"verb":"cluster","format":"json","payload":{"op":"list","clusters":[]},"state":"error","error":"store unreadable"}\\n'
`);
  chmodSync(stub, 0o755);
  try {
    await withStub(stub, async () => {
      const [rec] = await clusterVerb.run({ input: "view", rest: [], opts: { "no-open": true }, case: openC(), profile: defaultProfile() });
      assert.equal(rec.state, "error");
      assert.match(rec.error ?? "", /store unreadable/);
      // the user ran VIEW — traces keying off payload.op must not blame list
      assert.equal((rec.payload as Record<string, unknown>).op, "view");
    });
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("cluster errors: unknown action, missing index, label without a name", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-err-"));
  const stub = fakeClusterPy(cdir);
  try {
    await withStub(stub, async () => {
      // no face-cluster index in the case yet
      const c0 = openCase(cdir); c0.ensure();
      const [noIdx] = await clusterVerb.run({ input: "list", rest: [], opts: {}, case: c0, profile: defaultProfile() });
      assert.equal(noIdx.state, "error");
      assert.match(noIdx.error ?? "", /no face-cluster index/);

      addIndex(c0, { id: "local_face_cluster_1", name: "people", type: "face-cluster", backend: "local" });
      const [bad] = await clusterVerb.run({ input: "frobnicate", rest: [], opts: {}, case: openCase(cdir), profile: defaultProfile() });
      assert.equal(bad.state, "error");
      assert.match(bad.error ?? "", /unknown cluster action/);

      const [noName] = await clusterVerb.run({ input: "label", rest: ["p_1"], opts: {}, case: openCase(cdir), profile: defaultProfile() });
      assert.equal(noName.state, "error");
      assert.match(noName.error ?? "", /requires a name/);
    });
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("cluster add forwards an explicit --source-record; identify accepts a video probe (#PR33 R1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-srcvid-"));
  const openC = clusterCase(cdir);
  const img = join(cdir, "probe.jpg"); writeFileSync(img, "x");
  const vid = join(cdir, "probe.mp4"); writeFileSync(vid, "x");
  const stub = fakeClusterPy(cdir);
  try {
    await withStub(stub, async () => {
      // an explicit --source-record on a bare path reaches the provider
      const [add] = await clusterVerb.run({ input: "add", rest: [img], opts: { "source-record": "rec_origin" }, case: openC(), profile: defaultProfile() });
      assert.equal((add.payload as Record<string, unknown>).source_record, "rec_origin");
      // a provided-but-blank value is a user error, not an omitted flag
      const [blank] = await clusterVerb.run({ input: "add", rest: [img], opts: { "source-record": " " }, case: openC(), profile: defaultProfile() });
      assert.equal(blank.state, "error");
      assert.match(blank.error ?? "", /--source-record/);
      // identify takes a VIDEO probe (sampled frames), not just a still image
      const [vidProbe] = await clusterVerb.run({ input: "identify", rest: [vid], opts: { fps: 0.5 }, case: openC(), profile: defaultProfile() });
      assert.equal(vidProbe.state, "ready");
      assert.equal((vidProbe.payload as Record<string, unknown>).op, "identify");
    });
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("cluster rejects a flag on the wrong action instead of silently dropping it (#PR33 R1)", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-flagops-"));
  const openC = clusterCase(cdir);
  const stub = fakeClusterPy(cdir);
  try {
    await withStub(stub, async () => {
      const [fpsOnList] = await clusterVerb.run({ input: "list", rest: [], opts: { fps: 0.5 }, case: openC(), profile: defaultProfile() });
      assert.equal(fpsOnList.state, "error");
      assert.match(fpsOnList.error ?? "", /--fps doesn't apply to cluster list/);
      const [limitOnAdd] = await clusterVerb.run({ input: "recluster", rest: [], opts: { limit: 5 }, case: openC(), profile: defaultProfile() });
      assert.equal(limitOnAdd.state, "error");
      assert.match(limitOnAdd.error ?? "", /--limit doesn't apply/);
    });
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("cluster rejects an --index that isn't a local face-cluster index", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-wrongtype-"));
  try {
    const c = openCase(cdir); c.ensure();
    addIndex(c, { id: "col_faces", name: "cloud-faces", type: "face-analysis" });
    const [rec] = await clusterVerb.run({ input: "list", rest: [], opts: { index: "col_faces" }, case: openCase(cdir), profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /not a local face-cluster index/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

// ---- case-memory policy (#PR33 R1) ------------------------------------------

test("cluster memory policy: ingest/identify are evidence; DB reads/maintenance are not", () => {
  const mk = (op: string) => makeRecord({ verb: "cluster", format: "json", payload: { op }, state: "ready" });
  assert.equal(isMemoryRecord(mk("ingest")), true);
  assert.equal(isMemoryRecord(mk("identify")), true);
  for (const op of ["list", "show", "view", "label", "recluster"]) {
    assert.equal(isMemoryRecord(mk(op)), false, `cluster ${op} must stay out of case memory`);
  }
});

test("cluster/image index compact summaries only — no faces[], boxes, or homographies", () => {
  const clusterRec = makeRecord({
    verb: "cluster", format: "json", state: "ready",
    payload: {
      op: "ingest", index: "idx", summary: "ingested 2 faces → 1 new person", count: 2,
      new_clusters: 1, clusters_total: 3,
      faces: [{ face_id: "f_000001", box: { x: 1, y: 2, w: 3, h: 4 }, crop: "/secret/crop.jpg" }],
    },
  });
  const cFields = indexableFields(clusterRec);
  assert.ok(cFields.some((f) => f.path === "summary"));
  assert.ok(!cFields.some((f) => f.path.startsWith("faces") || f.text.includes("f_000001")), "raw faces[] must not be indexed");

  const imageRec = makeRecord({
    verb: "image", format: "json", state: "ready",
    payload: {
      op: "match", index: "logos", summary: "1 image match", count: 1,
      matches: [{ label: "starbucks", db_img_path: "/refs/sb.jpg", num_inliers: 42, inlier_ratio: 0.8, homography: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }],
    },
  });
  const iFields = indexableFields(imageRec);
  assert.ok(iFields.some((f) => f.path === "matches[].label" && f.text === "starbucks"));
  assert.ok(!iFields.some((f) => f.path.includes("homography") || f.text.includes("[[1,0,0]")), "homography must not be indexed");
});

// ---- REAL face_cluster.py: assign-or-create + store I/O (fake deepface) ----

test("face_cluster.py ingest does assign-or-create and persists the store", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-py-"));
  const idxDir = join(cdir, "idx");
  const mods = join(cdir, "mods");
  mkdirSync(mods, { recursive: true });
  writeFileSync(join(cdir, "aliceA.jpg"), "x");
  writeFileSync(join(cdir, "aliceB.jpg"), "x");
  writeFileSync(join(cdir, "bob.jpg"), "x");
  // fake deepface: a fixed embedding per person encoded in the filename
  writeFileSync(join(mods, "deepface.py"), `class DeepFace:
    @staticmethod
    def represent(img_path=None, **kwargs):
        p = str(img_path).lower()
        if "alice" in p: emb=[1.0,0.2,0.0,0.0]
        elif "bob" in p: emb=[0.0,0.0,1.0,0.2]
        else: emb=[0.0,1.0,0.0,0.0]
        return [{"embedding":emb,"facial_area":{"x":10,"y":10,"w":50,"h":50}}]
`, { flag: "w" });
  const run = (op: string, ...extra: string[]) =>
    spawnSync("python3", [CLUSTER_PY, "--op", op, "--index", "idx", "--index-dir", idxDir, ...extra], {
      cwd: cdir, env: { ...process.env, PYTHONPATH: mods }, encoding: "utf8",
    });
  try {
    const a = run("ingest", join(cdir, "aliceA.jpg"));
    assert.equal(a.status, 0, a.stderr);
    assert.equal((JSON.parse(a.stdout.trim()).payload).new_clusters, 1);

    const b = JSON.parse(run("ingest", join(cdir, "aliceB.jpg")).stdout.trim());
    assert.equal(b.payload.new_clusters, 0); // aliceB matches alice's person
    assert.equal(b.payload.faces[0].is_new_cluster, false);

    const c = JSON.parse(run("ingest", join(cdir, "bob.jpg")).stdout.trim());
    assert.equal(c.payload.new_clusters, 1); // bob is a new person

    const list = JSON.parse(run("list").stdout.trim());
    assert.equal(list.payload.count, 2); // two people total
    const sizes = list.payload.clusters.map((x: Record<string, unknown>) => x.size).sort();
    assert.deepEqual(sizes, [1, 2]);

    // show's count is the person's FULL face count even when --limit truncates
    // the returned page — it must never contradict the summary (#PR33 R9)
    const big = list.payload.clusters.find((x: Record<string, unknown>) => x.size === 2);
    const shown = JSON.parse(run("show", "--cluster", big.cluster_id, "--limit", "1").stdout.trim());
    assert.equal(shown.payload.count, 2, "count = whole person");
    assert.equal(shown.payload.returned, 1, "returned = the page");
    assert.equal(shown.payload.faces.length, 1);
    assert.match(shown.payload.summary, /2 faces/);

    // store on disk
    assert.ok(existsSync(join(idxDir, "faces.jsonl")));
    assert.ok(existsSync(join(idxDir, "clusters.json")));
    const faces = readFileSync(join(idxDir, "faces.jsonl"), "utf8").trim().split("\n");
    assert.equal(faces.length, 3);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face_cluster.py list counts named people over the WHOLE store, not the --limit page (#PR33 R1)", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-named-"));
  const idxDir = join(cdir, "idx");
  const mods = join(cdir, "mods");
  mkdirSync(mods, { recursive: true });
  writeFileSync(join(cdir, "a.jpg"), "x");
  writeFileSync(join(cdir, "b.jpg"), "x");
  writeFileSync(join(mods, "deepface.py"), `class DeepFace:
    @staticmethod
    def represent(img_path=None, **kwargs):
        p = str(img_path).lower()
        emb = [1.0,0.0,0.0,0.0] if "a.jpg" in p else [0.0,1.0,0.0,0.0]
        return [{"embedding":emb,"facial_area":{"x":1,"y":1,"w":9,"h":9}}]
`, { flag: "w" });
  const run = (op: string, ...extra: string[]) =>
    spawnSync("python3", [CLUSTER_PY, "--op", op, "--index", "idx", "--index-dir", idxDir, ...extra], {
      cwd: cdir, env: { ...process.env, PYTHONPATH: mods }, encoding: "utf8",
    });
  try {
    run("ingest", join(cdir, "a.jpg"));
    run("ingest", join(cdir, "b.jpg"));   // distinct person → p_2
    run("label", "--cluster", "p_2", "--label", "Bee");
    // page of 1 shows only unlabeled p_1, but the summary still counts Bee —
    // and `returned` flags the partial page (count=whole, same as show).
    const list = JSON.parse(run("list", "--limit", "1").stdout.trim());
    assert.equal(list.payload.clusters.length, 1);
    assert.equal(list.payload.returned, 1);
    assert.equal(list.payload.count, 2);
    assert.match(list.payload.summary, /2 people .*\(1 named\)/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face_cluster.py identify headlines the STRONGEST confident match, not the first face (#PR33 R1)", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-strongest-"));
  const idxDir = join(cdir, "idx");
  const mods = join(cdir, "mods");
  mkdirSync(mods, { recursive: true });
  for (const f of ["a.jpg", "b.jpg", "multi.jpg"]) writeFileSync(join(cdir, f), "x");
  // multi.jpg has TWO faces: face 1 weakly matches person A (~76), face 2
  // perfectly matches person B (100) — the summary must name B.
  writeFileSync(join(mods, "deepface.py"), `class DeepFace:
    @staticmethod
    def represent(img_path=None, **kwargs):
        p = str(img_path).lower()
        area = {"x":1,"y":1,"w":9,"h":9}
        if "multi.jpg" in p:
            return [{"embedding":[0.7,0.6,0.0,0.0],"facial_area":area},{"embedding":[0.0,1.0,0.0,0.0],"facial_area":area}]
        emb = [1.0,0.0,0.0,0.0] if "a.jpg" in p else [0.0,1.0,0.0,0.0]
        return [{"embedding":emb,"facial_area":area}]
`, { flag: "w" });
  const run = (op: string, ...extra: string[]) =>
    spawnSync("python3", [CLUSTER_PY, "--op", op, "--index", "idx", "--index-dir", idxDir, ...extra], {
      cwd: cdir, env: { ...process.env, PYTHONPATH: mods }, encoding: "utf8",
    });
  try {
    run("ingest", join(cdir, "a.jpg"));
    run("ingest", join(cdir, "b.jpg"));
    run("label", "--cluster", "p_1", "--label", "Aye");
    run("label", "--cluster", "p_2", "--label", "Bee");
    const idout = JSON.parse(run("identify", join(cdir, "multi.jpg")).stdout.trim());
    assert.equal(idout.payload.count, 2); // both probe faces reported
    assert.match(idout.payload.summary, /closest person: Bee \(100/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face_cluster.py refuses to mix embedding models in one index (#PR33 R2)", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-model-"));
  const idxDir = join(cdir, "idx");
  const mods = join(cdir, "mods");
  mkdirSync(mods, { recursive: true });
  writeFileSync(join(cdir, "a.jpg"), "x");
  writeFileSync(join(mods, "deepface.py"), `class DeepFace:
    @staticmethod
    def represent(img_path=None, **kwargs):
        return [{"embedding":[1.0,0.0,0.0,0.0],"facial_area":{"x":1,"y":1,"w":9,"h":9}}]
`, { flag: "w" });
  const run = (model: string, op: string, ...extra: string[]) =>
    spawnSync("python3", [CLUSTER_PY, "--op", op, "--index", "idx", "--index-dir", idxDir, ...extra], {
      cwd: cdir, env: { ...process.env, PYTHONPATH: mods, OVERCAST_FACE_MODEL: model }, encoding: "utf8",
    });
  try {
    const first = JSON.parse(run("ModelA", "ingest", join(cdir, "a.jpg")).stdout.trim());
    assert.equal(first.state, "ready");
    // a different model against a populated store must refuse, for ingest AND identify
    for (const op of ["ingest", "identify"]) {
      const rec = JSON.parse(run("ModelB", op, join(cdir, "a.jpg")).stdout.trim());
      assert.equal(rec.state, "error", `${op} with a mismatched model must error`);
      assert.match(String(rec.error), /ModelA/);
      assert.match(String(rec.error), /ModelB/);
    }
    // same model still works, and the commit path leaves no temp files behind
    const again = JSON.parse(run("ModelA", "ingest", join(cdir, "a.jpg")).stdout.trim());
    assert.equal(again.state, "ready");
    const leftovers = readdirSync(idxDir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "atomic writes must not leave .tmp files");
    assert.ok(existsSync(join(idxDir, ".lock")), "mutating ops take the store lock");
    // the guard must also trip on centroids alone (the documented crash window:
    // clusters.json replaced, faces.jsonl write lost) — not just on face rows.
    rmSync(join(idxDir, "faces.jsonl"));
    const centroidOnly = JSON.parse(run("ModelB", "ingest", join(cdir, "a.jpg")).stdout.trim());
    assert.equal(centroidOnly.state, "error", "model guard must cover a faces-empty, clusters-populated store");
    assert.match(String(centroidOnly.error), /ModelA/);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face_cluster.py guards the detector and reconciles ghost clusters (#PR33 R4)", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-reconcile-"));
  const idxDir = join(cdir, "idx");
  const mods = join(cdir, "mods");
  mkdirSync(mods, { recursive: true });
  writeFileSync(join(cdir, "a.jpg"), "x");
  writeFileSync(join(cdir, "b.jpg"), "x");
  writeFileSync(join(mods, "deepface.py"), `class DeepFace:
    @staticmethod
    def represent(img_path=None, **kwargs):
        p = str(img_path).lower()
        emb = [1.0,0.0,0.0,0.0] if "a.jpg" in p else [0.0,1.0,0.0,0.0]
        return [{"embedding":emb,"facial_area":{"x":1,"y":1,"w":9,"h":9}}]
`, { flag: "w" });
  const run = (env: Record<string, string>, op: string, ...extra: string[]) =>
    spawnSync("python3", [CLUSTER_PY, "--op", op, "--index", "idx", "--index-dir", idxDir, ...extra], {
      cwd: cdir, env: { ...process.env, PYTHONPATH: mods, ...env }, encoding: "utf8",
    });
  const base = { OVERCAST_FACE_MODEL: "ModelA", OVERCAST_FACE_DETECTOR: "detA" };
  try {
    run(base, "ingest", join(cdir, "a.jpg"));
    run(base, "ingest", join(cdir, "b.jpg"));
    // same model, different DETECTOR → incompatible crops/alignment → refuse
    const det = JSON.parse(run({ ...base, OVERCAST_FACE_DETECTOR: "detB" }, "ingest", join(cdir, "a.jpg")).stdout.trim());
    assert.equal(det.state, "error");
    assert.match(String(det.error), /detA/);
    assert.match(String(det.error), /detB/);

    // the guard must SURVIVE a recluster — its store rebuild once dropped the
    // detector field, silently reopening the mixing hole (#R6).
    assert.equal(JSON.parse(run(base, "recluster").stdout.trim()).state, "ready");
    const store0 = JSON.parse(readFileSync(join(idxDir, "clusters.json"), "utf8"));
    assert.equal(store0.detector, "detA", "recluster must carry the detector field forward");
    const detAfter = JSON.parse(run({ ...base, OVERCAST_FACE_DETECTOR: "detB" }, "ingest", join(cdir, "a.jpg")).stdout.trim());
    assert.equal(detAfter.state, "error", "detector guard must still trip after a recluster");

    // simulate the partial-commit window: drop person p_2's face row while
    // clusters.json still holds the ghost cluster + its centroid.
    const rows = readFileSync(join(idxDir, "faces.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const kept = rows.filter((r) => r.cluster_id !== "p_2");
    writeFileSync(join(idxDir, "faces.jsonl"), kept.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // list self-heals: the ghost person is gone, not counted
    const list = JSON.parse(run(base, "list").stdout.trim());
    assert.equal(list.payload.count, 1);
    assert.match(list.payload.summary, /1 person/);

    // ingest must NOT assign the new face to the ghost's stale centroid —
    // person B comes back as a NEW person with a real face row.
    const re = JSON.parse(run(base, "ingest", join(cdir, "b.jpg")).stdout.trim());
    assert.equal(re.state, "ready");
    assert.equal(re.payload.faces[0].is_new_cluster, true, "ghost centroid must not capture the new face");
    const after = JSON.parse(run(base, "list").stdout.trim());
    assert.equal(after.payload.count, 2);
    for (const cl of after.payload.clusters) assert.ok(cl.size >= 1);

    // a drifted persisted `size` self-heals too: list's SORT and show's summary
    // must use the reconciled member count, not the stored field (#R5).
    const storePath = join(idxDir, "clusters.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    store.clusters[0].size = 99;
    writeFileSync(storePath, JSON.stringify(store, null, 2));
    const healed = JSON.parse(run(base, "list").stdout.trim());
    for (const cl of healed.payload.clusters) assert.ok(cl.size <= 2, `size ${cl.size} must be re-derived, not the drifted 99`);
    const shown = JSON.parse(run(base, "show", "--cluster", store.clusters[0].cluster_id).stdout.trim());
    assert.doesNotMatch(String(shown.payload.summary), /99/, "show summary must not repeat the drifted size");

    // a store with embeddings but NO recorded model/detector is unknown
    // provenance — every op that computes with embedding values must refuse,
    // recluster included (#R7, #R10).
    delete store.model;
    store.clusters[0].size = 1;
    writeFileSync(storePath, JSON.stringify(store, null, 2));
    for (const op of ["ingest", "identify", "recluster"]) {
      const rec = JSON.parse(run(base, op, join(cdir, "a.jpg")).stdout.trim());
      assert.equal(rec.state, "error", `${op} must refuse an unstamped store`);
      assert.match(String(rec.error), /no recorded model/);
    }

    // faces stored but ZERO surviving people (stamps intact, clusters all ghost
    // or gone) → identify must point at `cluster recluster` (more ingests never
    // rebuild groups from stored rows), not `cluster add` (#R8).
    writeFileSync(storePath, JSON.stringify({ model: "ModelA", detector: "detA", next_face: 10, next_cluster: 10, clusters: [] }));
    const orphaned = JSON.parse(run(base, "identify", join(cdir, "a.jpg")).stdout.trim());
    assert.equal(orphaned.state, "error");
    assert.match(String(orphaned.error), /cluster recluster/);
    assert.doesNotMatch(String(orphaned.error), /cluster add/);

    // an intact-membership cluster with a blanked centroid must be recomputed
    // by reconcile, not scored at 0% forever (#R9). Rebuild a clean store first.
    run(base, "recluster");
    const store3 = JSON.parse(readFileSync(storePath, "utf8"));
    for (const cl of store3.clusters) cl.centroid = [];
    writeFileSync(storePath, JSON.stringify(store3, null, 2));
    const probe = JSON.parse(run(base, "identify", join(cdir, "a.jpg")).stdout.trim());
    assert.equal(probe.state, "ready");
    const top = probe.payload.matches[0].candidates[0];
    assert.ok(top.similarity > 90, `blanked centroid must be recomputed (got ${top.similarity}%)`);
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});

test("face_cluster.py recluster carries a human label forward by plurality", () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-relabel-"));
  const idxDir = join(cdir, "idx");
  const mods = join(cdir, "mods");
  mkdirSync(mods, { recursive: true });
  writeFileSync(join(cdir, "alice1.jpg"), "x");
  writeFileSync(join(cdir, "alice2.jpg"), "x");
  writeFileSync(join(mods, "deepface.py"), `class DeepFace:
    @staticmethod
    def represent(img_path=None, **kwargs):
        return [{"embedding":[1.0,0.2,0.0,0.0],"facial_area":{"x":1,"y":1,"w":9,"h":9}}]
`, { flag: "w" });
  const run = (op: string, ...extra: string[]) =>
    spawnSync("python3", [CLUSTER_PY, "--op", op, "--index", "idx", "--index-dir", idxDir, ...extra], {
      cwd: cdir, env: { ...process.env, PYTHONPATH: mods }, encoding: "utf8",
    });
  try {
    run("ingest", join(cdir, "alice1.jpg"));
    run("ingest", join(cdir, "alice2.jpg"));
    const labeled = JSON.parse(run("label", "--cluster", "p_1", "--label", "Alice").stdout.trim());
    assert.equal(labeled.payload.label, "Alice");
    const re = JSON.parse(run("recluster", "--min-similarity", "60").stdout.trim());
    assert.equal(re.state, "ready");
    const list = JSON.parse(run("list").stdout.trim());
    assert.equal(list.payload.clusters[0].label, "Alice"); // carried across recluster
  } finally {
    rmSync(cdir, { recursive: true, force: true });
  }
});
