// Face-cluster coverage. The local deepface provider is faked two ways:
//   1. a bash stub set as OC_VISUAL_DB_PY that echoes back the --op + flags, so
//      the `cluster` verb's op-resolution + arg-forwarding runs offline;
//   2. a fake `deepface` module on PYTHONPATH, so the REAL face_cluster.py
//      assign-or-create + store I/O runs under bare python3 (no numpy/TF).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { addIndex, findIndex, normalizeIndexType } from "../../src/state/index.ts";
import { clusterVerb } from "../../src/verbs/cluster.ts";
import { indexVerb } from "../../src/verbs/index.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLUSTER_PY = join(HERE, "..", "..", "examples", "providers", "visual-db", "face_cluster.py");

// a "python" stub: argv[1] is the real script path (ignored); it parses the
// flags face_cluster.py would get and echoes them back inside a cluster record.
function fakeClusterPy(dir: string): string {
  const path = join(dir, "fake-cluster");
  writeFileSync(path, `#!/usr/bin/env bash
op=""; index=""; indexdir=""; cluster=""; label=""; minsim=""; input=""
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  case "$arg" in
    --op) j=$((i+1)); op="\${!j}";;
    --index) j=$((i+1)); index="\${!j}";;
    --index-dir) j=$((i+1)); indexdir="\${!j}";;
    --cluster) j=$((i+1)); cluster="\${!j}";;
    --label) j=$((i+1)); label="\${!j}";;
    --min-similarity) j=$((i+1)); minsim="\${!j}";;
  esac
done
input="\${!#}"
printf '{"verb":"cluster","format":"json","payload":{"op":"%s","index":"%s","index_dir_seen":%s,"cluster":"%s","label":"%s","min_similarity":"%s","input":"%s","clusters":[{"cluster_id":"p_1","label":null,"size":1,"sample_crops":[],"at_span":null,"sources":[]}]},"state":"ready","meta":{"provider":"fake-cluster","model":"FakeNet"}}\\n' \\
  "$op" "$index" "$([ -n "$indexdir" ] && echo true || echo false)" "$cluster" "$label" "\${minsim:-}" "$input"
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

test("case setup provisions a local face-cluster index alongside a media index", async () => {
  const cdir = mkdtempSync(join(tmpdir(), "oc-fc-wizard-"));
  const mk = (opts: VerbContext["opts"]): VerbContext => {
    const c = openCase(cdir); c.ensure();
    return { input: "setup", rest: [], opts, case: c, profile: defaultProfile() };
  };
  try {
    const [rec] = await caseVerb.run(mk({ index: "faces:face-cluster,calls:media-descriptions", yes: true }));
    assert.equal(rec.state, "ready");
    const fc = findIndex(openCase(cdir), "faces");
    assert.equal(fc?.type, "face-cluster");
    assert.equal(fc?.backend, "local"); // stood up as a real local DB
    // the wizard routes the DB via the `cluster add` signal, never `index add`
    const setup = JSON.parse(readFileSync(join(cdir, ".overcast", "setup.json"), "utf8")) as Record<string, unknown>;
    const idxs = (setup.indexes ?? []) as Array<Record<string, unknown>>;
    const faceIdx = idxs.find((i) => i.type === "face-cluster");
    assert.deepEqual(faceIdx?.default_signals, ["cluster add"]);
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
      const viewer = String(p.viewer);
      assert.ok(existsSync(viewer), "gallery html written");
      const html = readFileSync(viewer, "utf8");
      assert.match(html, /data-cluster-gallery="true"/);
      assert.match(html, /PEOPLE/);
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

    // store on disk
    assert.ok(existsSync(join(idxDir, "faces.jsonl")));
    assert.ok(existsSync(join(idxDir, "clusters.json")));
    const faces = readFileSync(join(idxDir, "faces.jsonl"), "utf8").trim().split("\n");
    assert.equal(faces.length, 3);
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
