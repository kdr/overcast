import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { makeFinding } from "../../src/verbs/finding.ts";
import { LocalMemoryProvider, recordText } from "../../src/providers/memory/local.ts";
import { resolveMemory, fanOutAnswer } from "../../src/providers/memory/index.ts";
import { QmdMemoryProvider, DEFAULT_QMD_MODEL } from "../../src/providers/memory/qmd.ts";
import { indexableFields } from "../../src/providers/memory/fields.ts";
import { askVerb, briefVerb } from "../../src/verbs/read.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import { setupVerb } from "../../src/verbs/setup.ts";
import { emptySetup, saveSetup } from "../../src/state/setup.ts";
import type { MemoryProvider, Passage } from "../../src/providers/memory/types.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function withCase(fn: (c: ReturnType<typeof openCase>, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-read-"));
  const c = openCase(dir);
  c.ensure();
  c.writeRecord(makeRecord({ verb: "watch", payload: { content: "A white van near the docks at night" }, media: { ref: "a.mp4", at: [12, 18] }, meta: { time: "2026-06-20T10:00:00Z" } }));
  c.writeRecord(makeRecord({ verb: "watch", payload: { content: "An empty warehouse in daylight" }, media: { ref: "b.mp4", at: 5 }, meta: { time: "2026-06-21T10:00:00Z" } }));
  c.writeRecord(makeRecord({ verb: "scan", payload: { title: "dock cam feed", url: "http://x/1" } }));
  return Promise.resolve(fn(c, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("recordText flattens payload + media ref for indexing", () => {
  const r = makeRecord({ verb: "watch", payload: { content: "hello world", n: 3 }, media: { ref: "c.mp4" } });
  const t = recordText(r);
  assert.match(t, /hello world/);
  assert.match(t, /c\.mp4/);
});

test("indexable field policy prefers verb-specific fields, including notes", () => {
  const note = makeRecord({ verb: "note", payload: { title: "rear plate", text: "white van has no rear plate", detailed: { noisy: "skip me" } } });
  const fields = indexableFields(note);
  assert.deepEqual(fields.map((f) => f.path), ["title", "text"]);
  assert.match(fields.map((f) => f.text).join("\n"), /white van/);
});

test("case memory excludes operational/read/error records but indexes compact face summaries and crop evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-memory-filter-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "setup", payload: { summary: "SETUP_NOISE qmd configured" } }));
    c.writeRecord(makeRecord({ verb: "doctor", payload: { summary: "DOCTOR_NOISE qmd available" } }));
    c.writeRecord(makeRecord({ verb: "index", payload: { summary: "INDEX_NOISE remote attach" } }));
    c.writeRecord(makeRecord({ verb: "collection", payload: { summary: "COLLECTION_NOISE remote list" } }));
    c.writeRecord(makeRecord({ verb: "target", payload: { name: "TARGET_NOISE case target" } }));
    c.writeRecord(makeRecord({ verb: "source", payload: { name: "SOURCE_NOISE case source", ref: "web:query" } }));
    c.writeRecord(makeRecord({ verb: "prebrief", payload: { summary: "PREBRIEF_NOISE case kickoff" } }));
    c.writeRecord(makeRecord({ verb: "case", payload: { summary: "CASE_NOISE memory status" } }));
    c.writeRecord(makeRecord({ verb: "ask", payload: { text: "ASK_NOISE prior answer", citations: [] } }));
    c.writeRecord(makeRecord({ verb: "face", payload: { op: "detect", summary: "FACE_SUMMARY_MARKER 36 face boxes", faces: [{ box: { x: 1, y: 2, width: 3, height: 4 }, thumbnail: "NOISY_FACE_BLOB" }] }, media: { ref: "faces.mp4" } }));
    c.writeRecord(makeRecord({ verb: "crop", payload: { summary: "CROP_MARKER cropped face from faces.mp4", class: "face", detection_id: "face_1", crop: "crop.jpg", original_box: { noisy: "RAW_BOX_NOISE" } }, media: { ref: "crop.jpg" } }));
    c.writeRecord(makeRecord({ verb: "crop", payload: { error: "CROP_ERROR_MARKER failed crop should not become evidence" }, state: "error", error: "crop failed" }));
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "WATCH_ERROR_MARKER failed watch should not become evidence" }, state: "error", error: "watch failed" }));
    c.writeRecord(makeRecord({ verb: "note", payload: { text: "EVIDENCE_MARKER Zurich train station" } }));

    const local = new LocalMemoryProvider(c);
    assert.equal(local.status().documents, 3);
    assert.deepEqual(local.query("NOISE", { limit: 10 }), []);
    assert.equal(local.query("SETUP_NOISE", { verbs: ["setup"], limit: 10 }).length, 0);
    assert.equal(local.query("CROP_ERROR_MARKER", { limit: 10 }).length, 0);
    assert.equal(local.query("WATCH_ERROR_MARKER", { limit: 10 }).length, 0);
    assert.equal(local.query("FACE_SUMMARY_MARKER", { limit: 10 })[0]?.verb, "face");
    assert.equal(local.query("CROP_MARKER", { limit: 10 })[0]?.verb, "crop");
    const localHits = local.query("Zurich train", { limit: 10 });
    assert.equal(localHits.length, 1);
    assert.equal(localHits[0].verb, "note");

    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, '#!/usr/bin/env bash\necho "{\\"ok\\":true}"\n');
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    const rebuilt = await qmd.rebuild();
    assert.equal(rebuilt.state, "ready");
    assert.equal(rebuilt.documents, 3);
    const docsDir = join(c.indexDir, "case-search", "qmd", "docs");
    const docs = readdirSync(docsDir).map((name) => readFileSync(join(docsDir, name), "utf8")).join("\n");
    assert.match(docs, /EVIDENCE_MARKER/);
    assert.match(docs, /FACE_SUMMARY_MARKER/);
    assert.match(docs, /CROP_MARKER/);
    assert.doesNotMatch(docs, /SETUP_NOISE|DOCTOR_NOISE|INDEX_NOISE|COLLECTION_NOISE|TARGET_NOISE|SOURCE_NOISE|PREBRIEF_NOISE|CASE_NOISE|ASK_NOISE|CROP_ERROR_MARKER|WATCH_ERROR_MARKER|NOISY_FACE_BLOB|RAW_BOX_NOISE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dismissed findings and review records are excluded from memory and briefs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-finding-memory-"));
  try {
    const c = openCase(dir);
    c.ensure();
    const source = makeRecord({ verb: "watch", payload: { content: "ordinary clip" }, media: { ref: "clip.mp4" } });
    c.writeRecord(source);
    const finding = makeFinding({ text: "DISMISSED_FINDING_MARKER target found", target: "target", sourceRecord: source, trigger: "test" });
    c.writeRecord(finding);
    c.writeRecord(makeRecord({ verb: "finding", payload: { finding_id: finding.id, status: "dismissed", reviewed_at: "2026-06-28T00:00:00Z" } }));

    const mem = new LocalMemoryProvider(c);
    assert.deepEqual(mem.query("DISMISSED_FINDING_MARKER", { limit: 10 }), []);
    const [brief] = await briefVerb.run({ input: undefined, rest: [], opts: {}, case: c, profile: defaultProfile() });
    assert.doesNotMatch((brief.payload as Record<string, unknown>).report as string, /DISMISSED_FINDING_MARKER/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider-indexable case policy extends memory signals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-provider-indexable-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "see", payload: { caption: "PROVIDER_INDEXABLE_MARKER visible target" } }));
    const setup = emptySetup("provider-indexable");
    setup.memory = { backend: "local-grep", signals: ["note"] };
    setup.providers = { see: { verb: "see", choice: "local-detect", indexable: true } };
    saveSetup(c, setup);

    const [mem] = resolveMemory(c, defaultProfile());
    const hits = mem.query("PROVIDER_INDEXABLE_MARKER", { limit: 10 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].verb, "see");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local provider ranks the matching record first and cites media.at", async () => {
  await withCase((c) => {
    const mem = new LocalMemoryProvider(c);
    const hits = mem.query("white van docks");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].verb, "watch");
    assert.deepEqual(hits[0].at, [12, 18]);
    // the warehouse record should not outrank the van for this query
    assert.match(hits[0].text, /white van/i);

    const ans = mem.answer("white van docks");
    assert.equal(ans.citations.length, hits.length);
    assert.equal(ans.citations[0].recordId, hits[0].recordId);
  });
});

test("query respects the verb filter", async () => {
  await withCase((c) => {
    const mem = new LocalMemoryProvider(c);
    const scanOnly = mem.query("dock", { verbs: ["scan"] });
    assert.ok(scanOnly.every((p) => p.verb === "scan"));
  });
});

test("local provider keeps distinct matching array fields with the same path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-local-array-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "watch",
      payload: {
        data: {
          segments: [
            { description: "Zurich travel tips near the train station" },
            { description: "Zurich river walk and old town landmarks" },
          ],
        },
      },
      media: { ref: "zurich.mp4" },
    }));
    const hits = new LocalMemoryProvider(c).query("Zurich", { limit: 5 });
    assert.equal(hits.filter((h) => h.field === "data.segments[].description").length, 2);
    assert.ok(hits.some((h) => /train station/.test(h.text)));
    assert.ok(hits.some((h) => /old town/.test(h.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case memory search preserves distinct same-record snippets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-case-search-snippets-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "watch",
      payload: {
        data: {
          segments: [
            { description: "Zurich train station transit tip" },
            { description: "Zurich old town walking tip" },
          ],
        },
      },
      media: { ref: "zurich.mp4" },
    }));
    const [rec] = await caseVerb.run({ input: "memory", rest: ["search", "Zurich", "tip"], opts: { limit: 5 }, case: c, profile: defaultProfile() });
    assert.equal(rec.state, "ready");
    const passages = (rec.payload as Record<string, unknown>).passages as Array<Record<string, unknown>>;
    assert.equal(passages.filter((p) => p.recordId === c.records()[0].id).length, 2);
    assert.ok(passages.some((p) => /train station/.test(String(p.text))));
    assert.ok(passages.some((p) => /old town/.test(String(p.text))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fanOutAnswer merges + dedups citations across providers", async () => {
  await withCase(async (c) => {
    const local = new LocalMemoryProvider(c);
    // a second fake provider returning an overlapping + a new citation
    const fake: MemoryProvider = {
      id: "fake",
      write() {},
      query(): Passage[] {
        return [{ recordId: "rec_shared", at: 1, text: "x", score: 5, verb: "watch" }];
      },
      answer() {
        return { text: "fake says hi", citations: [{ recordId: "rec_shared", at: 1, verb: "watch" }] };
      },
    };
    const ans = await fanOutAnswer([local, fake], "white van");
    // local cites the van record; fake cites rec_shared → both present, deduped
    const ids = ans.citations.map((x) => x.recordId);
    assert.ok(ids.includes("rec_shared"));
    const keys = ans.citations.map((x) => JSON.stringify([x.recordId, x.at, x.verb, x.field, x.text]));
    assert.equal(new Set(keys).size, keys.length); // no exact dup citations
  });
});

test("fanOutAnswer preserves distinct same-record field citations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-fanout-cites-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({
      verb: "watch",
      payload: {
        data: {
          segments: [
            { description: "Zurich train station transit tip" },
            { description: "Zurich old town walking tip" },
          ],
        },
      },
      media: { ref: "zurich.mp4" },
    }));
    const ans = await fanOutAnswer([new LocalMemoryProvider(c)], "Zurich tip", { limit: 5 });
    assert.equal(ans.citations.filter((cite) => cite.recordId === c.records()[0].id).length, 2);
    assert.ok(ans.citations.some((cite) => /train station/.test(cite.text ?? "")));
    assert.ok(ans.citations.some((cite) => /old town/.test(cite.text ?? "")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMemory always includes the local provider", async () => {
  await withCase((c) => {
    const providers = resolveMemory(c, defaultProfile());
    assert.ok(providers.some((p) => p.id === "local-grep"));
    assert.ok(providers.some((p) => p.aliases?.includes("local")));
  });
});

test("resolveMemory honors case setup qmd backend and local signal filter", async () => {
  await withCase(async (c) => {
    c.writeRecord(makeRecord({ verb: "note", payload: { text: "white van note-only finding" } }));
    const setup = emptySetup("memory-test");
    setup.completed = true;
    setup.memory = { backend: "qmd", signals: ["note"] };
    saveSetup(c, setup);

    const providers = resolveMemory(c, defaultProfile());
    assert.ok(providers.some((p) => p.id === "qmd"));
    const local = providers.find((p) => p.id === "local-grep")!;
    const hits = await local.query("white van", { limit: 10 });
    assert.ok(hits.length >= 1);
    assert.equal(hits.every((hit) => hit.verb === "note"), true);
  });
});

test("resolveMemory honors case setup local-grep over profile qmd", async () => {
  await withCase(async (c) => {
    const setup = emptySetup("memory-test");
    setup.completed = true;
    setup.memory = { backend: "local-grep", signals: ["note", "watch"] };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.memory = [{ type: "exec", backend: "qmd", id: "qmd", command: "qmd" }];

    const providers = resolveMemory(c, profile);
    assert.deepEqual(providers.map((p) => p.id), ["local-grep"]);
  });
});

function ctx(c: ReturnType<typeof openCase>, input: string | undefined, opts: VerbContext["opts"] = {}): VerbContext {
  return { input, rest: [], opts, case: c, profile: defaultProfile() };
}

test("ask verb returns an answer record citing record.id + media.at", async () => {
  await withCase(async (c) => {
    const [rec] = await askVerb.run(ctx(c, "white van at the docks"));
    assert.equal(rec.verb, "ask");
    assert.equal(rec.state, "ready");
    const p = rec.payload as Record<string, unknown>;
    const cites = p.citations as Array<Record<string, unknown>>;
    assert.ok(cites.length >= 1);
    assert.match(rec.meta?.provider as string, /local-grep/);
  });
});

test("ask --memory local alias still selects local-grep", async () => {
  await withCase(async (c) => {
    const [rec] = await askVerb.run(ctx(c, "white van at the docks", { memory: "local" }));
    assert.equal(rec.state, "ready");
    assert.match(rec.meta?.provider as string, /local-grep/);
  });
});

test("plain ask stays on local-grep even when qmd is configured", async () => {
  await withCase(async (c, dir) => {
    const log = join(dir, "qmd.log");
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
echo '[{"record_id":"rec_qmd","verb":"note","text":"qmd semantic hit","score":9}]'
`);
    chmodSync(fake, 0o755);
    const p = defaultProfile();
    p.memory = [{ type: "exec", backend: "qmd", id: "qmd", command: `bash ${fake}`, model: DEFAULT_QMD_MODEL }];
    const [rec] = await askVerb.run({ input: "white van at the docks", rest: [], opts: {}, case: c, profile: p });
    assert.equal(rec.state, "ready");
    assert.equal(rec.meta?.provider, "local-grep");
    assert.equal(existsSync(log), false);
  });
});

test("qmd memory provider materializes docs, records model config, and queries via qmd", async () => {
  await withCase(async (c, dir) => {
    const log = join(dir, "qmd.log");
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if printf '%s\\n' "$*" | grep -q ' vsearch '; then
  echo '[{"record_id":"rec_qmd","verb":"note","text":"qmd semantic hit","score":9}]'
else
  echo '{"ok":true}'
fi
`);
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    const st = await qmd.rebuild();
    assert.equal(st.state, "ready");
    assert.equal(st.model, DEFAULT_QMD_MODEL);
    assert.ok(st.documents && st.documents >= 3);
    const hits = await qmd.query("white van docks", { limit: 2 });
    assert.equal(hits[0].recordId, "rec_qmd");
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /collection remove/);
    assert.match(calls, /collection add/);
    assert.match(calls, /embed -c/);
    assert.match(calls, /vsearch white van docks --collection/);
  });
});

test("qmd rebuild is idempotent when the named collection already exists", async () => {
  await withCase(async (c, dir) => {
    const log = join(dir, "qmd.log");
    const state = join(dir, "collection.exists");
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if printf '%s\\n' "$*" | grep -q 'collection remove'; then
  rm -f ${JSON.stringify(state)}
  echo '{"removed":true}'
  exit 0
fi
if printf '%s\\n' "$*" | grep -q 'collection add'; then
  if [ -f ${JSON.stringify(state)} ]; then
    echo "Collection 'overcast-case' already exists." >&2
    exit 2
  fi
  touch ${JSON.stringify(state)}
  echo '{"added":true}'
  exit 0
fi
echo '{"ok":true}'
`);
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    const first = await qmd.rebuild();
    const second = await qmd.rebuild();
    assert.equal(first.state, "ready");
    assert.equal(second.state, "ready");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.filter((line) => /collection remove/.test(line)).length, 2);
    assert.equal(calls.filter((line) => /collection add/.test(line)).length, 2);
  });
});

test("qmd status becomes stale when indexable content changes without a count change", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, '#!/usr/bin/env bash\necho "{\\"ok\\":true}"\n');
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    const rebuilt = await qmd.rebuild();
    assert.equal(rebuilt.state, "ready");

    const watchFile = join(c.recordsDir, "watch.jsonl");
    const lines = readFileSync(watchFile, "utf8").trimEnd().split("\n");
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.payload = { content: "A red car near the marina at noon" };
    lines[0] = JSON.stringify(first);
    writeFileSync(watchFile, `${lines.join("\n")}\n`, "utf8");

    const status = await qmd.status();
    assert.equal(status.state, "stale");
  });
});

test("qmd query does not auto-rebuild a missing index", async () => {
  await withCase(async (c, dir) => {
    const log = join(dir, "qmd.log");
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
echo '[{"record_id":"rec_qmd","verb":"note","text":"qmd semantic hit","score":9}]'
`);
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    assert.deepEqual(await qmd.query("white van"), []);
    assert.equal(existsSync(log), false);
    const ans = await qmd.answer("white van");
    assert.match(ans.text, /qmd index is missing/);
    assert.match(ans.text, /case memory index rebuild --memory qmd/);
  });
});

test("qmd query keeps media_at anchors and does not fall back to local-grep on search failure", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
if printf '%s\\n' "$*" | grep -q ' vsearch '; then
  if printf '%s\\n' "$*" | grep -q ' fail '; then exit 9; fi
  echo '[{"record_id":"rec_qmd_anchor","verb":"watch","text":"semantic timestamp hit","score":9,"metadata":{"media_at":"12-18"}}]'
else
  echo '{"ok":true}'
fi
`);
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    await qmd.rebuild();

    const hits = await qmd.query("white van");
    assert.equal(hits[0].recordId, "rec_qmd_anchor");
    assert.deepEqual(hits[0].at, [12, 18]);
    const ans = await qmd.answer("white van");
    assert.deepEqual(ans.citations[0].at, [12, 18]);

    const failed = await qmd.query("fail");
    assert.deepEqual(failed, []);
    const failedAns = await qmd.answer("fail");
    assert.equal(failedAns.text, 'No qmd results for "fail".');
  });
});

test("qmd parses real CLI full-body results back to record citations", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
if [ "$3" = "vsearch" ]; then
  cat <<'JSON'
[
  {
    "docid":"#abc",
    "score":0.51,
    "file":"qmd://case/rec1.md",
    "line":7,
    "title":"Watch rec1",
    "body":"# Watch rec1\\n\\nrecord_id: rec_real_qmd\\nverb: watch\\nmedia_at: 12-18\\n\\nA white van appears near the docks at night with boxes.\\n"
  }
]
JSON
else
  echo '{"ok":true}'
fi
`);
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    await qmd.rebuild();
    const hits = await qmd.query("white van docks", { limit: 2 });
    assert.equal(hits[0].recordId, "rec_real_qmd");
    assert.equal(hits[0].verb, "watch");
    assert.deepEqual(hits[0].at, [12, 18]);
    assert.match(hits[0].text, /white van appears near the docks/i);
  });
});

test("qmd query applies verb and since filters after semantic retrieval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-qmd-filter-"));
  try {
    const c = openCase(dir);
    c.ensure();
    const oldNote = makeRecord({ verb: "note", payload: { text: "Zurich travel note" }, meta: { time: "2020-01-01T00:00:00Z" } });
    const freshWatch = makeRecord({ verb: "watch", payload: { content: "Zurich travel watch" }, meta: { time: "2026-06-25T00:00:00Z" } });
    c.writeRecord(oldNote);
    c.writeRecord(freshWatch);
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
if printf '%s\\n' "$*" | grep -q ' vsearch '; then
  cat <<JSON
[
  {"record_id":"${oldNote.id}","verb":"note","text":"old Zurich note","score":9},
  {"record_id":"${freshWatch.id}","verb":"watch","text":"fresh Zurich watch","score":8}
]
JSON
else
  echo '{"ok":true}'
fi
`);
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    await qmd.rebuild();
    const watchOnly = await qmd.query("Zurich", { verbs: ["watch"], limit: 5 });
    assert.deepEqual(watchOnly.map((h) => h.recordId), [freshWatch.id]);
    const freshOnly = await qmd.query("Zurich", { since: "2026-01-01", limit: 5 });
    assert.deepEqual(freshOnly.map((h) => h.recordId), [freshWatch.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case memory index status/rebuild surfaces backend compatibility", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, '#!/usr/bin/env bash\necho "{\\"ok\\":true}"\n');
    chmodSync(fake, 0o755);
    const p = defaultProfile();
    p.memory = [{ type: "exec", backend: "qmd", id: "qmd", command: `bash ${fake}`, model: DEFAULT_QMD_MODEL }];
    const [rebuilt] = await caseVerb.run({ input: "memory", rest: ["index", "rebuild"], opts: { memory: "qmd" }, case: c, profile: p });
    assert.equal(rebuilt.state, "ready");
    const statuses = (rebuilt.payload as Record<string, unknown>).memory_index as Array<Record<string, unknown>>;
    assert.equal(statuses[0].backend, "qmd");
    assert.equal(statuses[0].model, DEFAULT_QMD_MODEL);

    const [status] = await caseVerb.run({ input: "memory", rest: ["index", "status"], opts: { memory: "qmd" }, case: c, profile: p });
    assert.equal(status.state, "ready");
    assert.equal((((status.payload as Record<string, unknown>).memory_index as Array<Record<string, unknown>>)[0]).state, "ready");
  });
});

test("qmd rebuild failure remains visible in later status", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd-fail.sh");
    writeFileSync(fake, '#!/usr/bin/env bash\necho "boom" >&2\nexit 42\n');
    chmodSync(fake, 0o755);
    const qmd = new QmdMemoryProvider(c, { command: `bash ${fake}` });
    const rebuilt = await qmd.rebuild();
    assert.equal(rebuilt.state, "error");
    assert.match(rebuilt.error ?? "", /boom/);
    const status = await qmd.status();
    assert.equal(status.state, "error");
    assert.match(status.error ?? "", /boom/);
  });
});

test("case memory search honors --memory qmd", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
if printf '%s\\n' "$*" | grep -q ' vsearch '; then
  echo '[{"record_id":"rec_qmd_search","verb":"note","text":"qmd-only case search","score":9}]'
else
  echo '{"ok":true}'
fi
`);
    chmodSync(fake, 0o755);
    const p = defaultProfile();
    p.memory = [{ type: "exec", backend: "qmd", id: "qmd", command: `bash ${fake}`, model: DEFAULT_QMD_MODEL }];
    const [rebuilt] = await caseVerb.run({ input: "memory", rest: ["index", "rebuild"], opts: { memory: "qmd" }, case: c, profile: p });
    assert.equal(rebuilt.state, "ready");
    const [rec] = await caseVerb.run({ input: "memory", rest: ["search", "white", "van"], opts: { memory: "qmd" }, case: c, profile: p });
    assert.equal(rec.state, "ready");
    const passages = (rec.payload as Record<string, unknown>).passages as Array<Record<string, unknown>>;
    assert.equal(passages[0].recordId, "rec_qmd_search");
  });
});

test("ask --deep selects configured semantic providers", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
if printf '%s\\n' "$*" | grep -q ' vsearch '; then
  echo '[{"record_id":"rec_qmd_deep","verb":"note","text":"deep qmd semantic hit","score":9}]'
else
  echo '{"ok":true}'
fi
`);
    chmodSync(fake, 0o755);
    const p = defaultProfile();
    p.memory = [{ type: "exec", backend: "qmd", id: "qmd", command: `bash ${fake}`, model: DEFAULT_QMD_MODEL }];
    const [rebuilt] = await caseVerb.run({ input: "memory", rest: ["index", "rebuild"], opts: { memory: "qmd" }, case: c, profile: p });
    assert.equal(rebuilt.state, "ready");

    const [rec] = await askVerb.run({ input: "white van at the docks", rest: [], opts: { deep: true }, case: c, profile: p });
    assert.equal(rec.state, "ready");
    assert.equal(rec.meta?.provider, "qmd");
    assert.match(String((rec.payload as Record<string, unknown>).text), /deep qmd semantic hit/);
  });
});

test("ask --deep errors instead of silently falling back to local-grep", async () => {
  await withCase(async (c) => {
    const [rec] = await askVerb.run({ input: "white van", rest: [], opts: { deep: true }, case: c, profile: defaultProfile() });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /no semantic memory provider/i);
  });
});

test("ask --deep errors when the configured qmd index is missing", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
echo '{"ok":true}'
`);
    chmodSync(fake, 0o755);
    const p = defaultProfile();
    p.memory = [{ type: "exec", backend: "qmd", id: "qmd", command: `bash ${fake}`, model: DEFAULT_QMD_MODEL }];
    const [rec] = await askVerb.run({ input: "white van", rest: [], opts: { deep: true }, case: c, profile: p });
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /qmd index is missing/);
    assert.match(rec.error ?? "", /case memory index rebuild --memory qmd/);
  });
});

test("setup memory qmd preserves multi-token command", async () => {
  await withCase(async (c, dir) => {
    const home = join(dir, "home");
    const [rec] = await setupVerb.run({
      input: "memory",
      rest: ["qmd", "bash", "/tmp/fake qmd.sh"],
      opts: {},
      case: c,
      profile: defaultProfile(),
      home,
    });
    assert.equal(rec.state, "ready");
    const memory = (rec.payload as Record<string, unknown>).memory as Array<Record<string, unknown>>;
    assert.equal(memory[0].command, 'bash "/tmp/fake qmd.sh"');
  });
});

test("case memory index start uses the configured CLI command", async () => {
  await withCase(async (c, dir) => {
    const fake = join(dir, "overcast-bg.sh");
    const log = join(dir, "bg.log");
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
`);
    chmodSync(fake, 0o755);
    const prev = process.env.OVERCAST_CMD;
    process.env.OVERCAST_CMD = `bash ${fake}`;
    try {
      const [rec] = await caseVerb.run({ input: "memory", rest: ["index", "start"], opts: { memory: "local-grep" }, case: c, profile: defaultProfile() });
      assert.equal(rec.state, "pending");
      const job = ((rec.payload as Record<string, unknown>).job as Record<string, unknown>);
      assert.match(job.command as string, /overcast-bg\.sh/);
      assert.match(job.command as string, /case memory index rebuild/);
      const jobFile = (rec.payload as Record<string, unknown>).job_file as string;
      for (let i = 0; i < 50; i++) {
        if (existsSync(log) && /case memory index rebuild/.test(readFileSync(log, "utf8"))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(readFileSync(log, "utf8"), /case memory index rebuild/);
      for (let i = 0; i < 50; i++) {
        let state = "";
        try {
          state = JSON.parse(readFileSync(jobFile, "utf8")).state;
        } catch {
          state = "";
        }
        if (state === "ready") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(JSON.parse(readFileSync(jobFile, "utf8")).state, "ready");
    } finally {
      if (prev === undefined) delete process.env.OVERCAST_CMD;
      else process.env.OVERCAST_CMD = prev;
    }
  });
});

test("case clear drops configured qmd collection before removing local index state", async () => {
  await withCase(async (c, dir) => {
    const log = join(dir, "qmd-clear.log");
    const fake = join(dir, "qmd.sh");
    writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
echo '{"ok":true}'
`);
    chmodSync(fake, 0o755);
    const p = defaultProfile();
    p.memory = [{ type: "exec", backend: "qmd", id: "qmd", command: `bash ${fake}`, model: DEFAULT_QMD_MODEL }];
    const [rebuilt] = await caseVerb.run({ input: "memory", rest: ["index", "rebuild"], opts: { memory: "qmd" }, case: c, profile: p });
    assert.equal(rebuilt.state, "ready");
    assert.ok(existsSync(join(c.indexDir, "case-search", "qmd", "manifest.json")));

    const [cleared] = await caseVerb.run({ input: "clear", rest: [], opts: { yes: true }, case: c, profile: p });
    assert.equal(cleared.state, "ready");
    assert.equal(existsSync(c.indexDir), false);
    const payload = cleared.payload as Record<string, unknown>;
    const memory = payload.memory_indexes_cleared as Array<Record<string, unknown>>;
    assert.equal(memory[0].provider, "qmd");
    assert.equal(memory[0].state, "missing");
    assert.match(readFileSync(log, "utf8"), /collection remove/);
  });
});

test("brief --scope since:<when> actually filters stale records (review fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-brief-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "ancient" }, meta: { time: "2020-01-01T00:00:00Z" } }));
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "recent" }, meta: { time: new Date().toISOString() } }));
    const [rec] = await briefVerb.run({ input: undefined, rest: [], opts: { scope: "since:24h" }, case: c, profile: defaultProfile() });
    const report = (rec.payload as Record<string, unknown>).report as string;
    assert.match(report, /recent/);
    assert.ok(!report.includes("ancient"), "stale 2020 record must be filtered out by since:24h");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brief timeline: dated records sort chronologically, undated go last in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-tl-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "UNDATED-A" } }));
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "DATED-2026" }, meta: { time: "2026-01-01T00:00:00Z" } }));
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "UNDATED-B" } }));
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "DATED-2020" }, meta: { time: "2020-01-01T00:00:00Z" } }));
    const [rec] = await briefVerb.run({ input: undefined, rest: [], opts: {}, case: c, profile: defaultProfile() });
    const report = (rec.payload as Record<string, unknown>).report as string;
    const order = ["DATED-2020", "DATED-2026", "UNDATED-A", "UNDATED-B"].map((s) => report.indexOf(s));
    assert.ok(order.every((i) => i >= 0));
    // dated ascending, then undated in insertion order
    assert.ok(order[0] < order[1], "2020 before 2026");
    assert.ok(order[1] < order[2], "dated before undated");
    assert.ok(order[2] < order[3], "undated kept in insertion order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brief head preserves non-string content (does not print the key name)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-head-"));
  try {
    const c = openCase(dir);
    c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: 42 } }));
    const [rec] = await briefVerb.run({ input: undefined, rest: [], opts: {}, case: c, profile: defaultProfile() });
    const report = (rec.payload as Record<string, unknown>).report as string;
    assert.match(report, /: 42$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brief verb builds a report and --export writes md + html", async () => {
  await withCase(async (c, dir) => {
    const mdPath = join(dir, "out.md");
    const [md] = await briefVerb.run(ctx(c, undefined, { export: mdPath }));
    assert.equal(md.verb, "brief");
    assert.equal((md.payload as Record<string, unknown>).total, 3);
    assert.ok(existsSync(mdPath));
    assert.match(readFileSync(mdPath, "utf8"), /# Brief/);

    const htmlPath = join(dir, "out.html");
    await briefVerb.run(ctx(c, undefined, { export: htmlPath }));
    const html = readFileSync(htmlPath, "utf8");
    assert.match(html, /<h1>/);
    assert.match(html, /white van/);
  });
});

test("brief embeds the FULL primary field, not a 160-char stub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-brieffull-"));
  try {
    const c = openCase(dir); c.ensure();
    // a marker only reachable if the field is NOT truncated at ~160 chars
    const content = "lead ".repeat(60) + "DEEP_TAIL_MARKER";
    c.writeRecord(makeRecord({ verb: "watch", payload: { content }, media: { ref: "v.mp4" } }));
    const [rec] = await briefVerb.run(ctx(c, undefined, {}));
    const report = (rec.payload as Record<string, unknown>).report as string;
    assert.ok(content.length > 200, "fixture should exceed the old 160-char cap");
    assert.match(report, /DEEP_TAIL_MARKER/); // full content embedded
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brief excludes meta and operational records from timeline and counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-briefmeta-"));
  try {
    const c = openCase(dir); c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "EVIDENCE_MARKER van at docks" }, media: { ref: "a.mp4" } }));
    c.writeRecord(makeRecord({ verb: "brief", payload: { report: "OLD_REPORT_BODY", counts: {}, total: 5 } }));
    c.writeRecord(makeRecord({ verb: "ask", payload: { text: "ASK_ANSWER", citations: [], question: "q" } }));
    c.writeRecord(makeRecord({ verb: "case", payload: { record: "rec_x", field: "content", chunk: "CASE_CHUNK" } }));
    c.writeRecord(makeRecord({ verb: "setup", payload: { summary: "SETUP_CHUNK" } }));
    c.writeRecord(makeRecord({ verb: "doctor", payload: { summary: "DOCTOR_CHUNK" } }));
    c.writeRecord(makeRecord({ verb: "index", payload: { summary: "INDEX_CHUNK" } }));
    c.writeRecord(makeRecord({ verb: "target", payload: { name: "TARGET_CHUNK" } }));
    c.writeRecord(makeRecord({ verb: "source", payload: { name: "SOURCE_CHUNK", ref: "web:query" } }));
    c.writeRecord(makeRecord({ verb: "prebrief", payload: { summary: "PREBRIEF_CHUNK" } }));
    const [rec] = await briefVerb.run(ctx(c, undefined, {}));
    const p = rec.payload as Record<string, unknown>;
    const report = p.report as string;
    assert.match(report, /EVIDENCE_MARKER/); // the real evidence IS present
    assert.doesNotMatch(report, /OLD_REPORT_BODY|ASK_ANSWER|CASE_CHUNK|SETUP_CHUNK|DOCTOR_CHUNK|INDEX_CHUNK|TARGET_CHUNK|SOURCE_CHUNK|PREBRIEF_CHUNK/);
    assert.equal(p.total, 1); // only the 1 evidence record counted
    assert.deepEqual(p.counts, { watch: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local memory does not retrieve case (inspection) records as evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-memcase-"));
  try {
    const c = openCase(dir); c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "a white van at the docks" }, media: { ref: "a.mp4" } }));
    // a `case memory get` page envelope that duplicates the same source text
    c.writeRecord(makeRecord({ verb: "case", payload: { record: "rec_x", field: "content", chunk: "a white van at the docks" } }));
    const hits = new LocalMemoryProvider(c).query("white van docks");
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.verb !== "case"), "case envelopes must not be cited as evidence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brief html export does not reparse embedded content as markup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-briefhtml-"));
  try {
    const c = openCase(dir); c.ensure();
    c.writeRecord(makeRecord({ verb: "watch", payload: { content: "intro line\n### Scene 5 heading\n- bullet inside content" }, media: { ref: "v.mp4" } }));
    const htmlPath = join(dir, "b.html");
    await briefVerb.run(ctx(c, undefined, { export: htmlPath }));
    const html = readFileSync(htmlPath, "utf8");
    assert.doesNotMatch(html, /<h3>Scene 5 heading<\/h3>/); // embedded line NOT a heading
    assert.match(html, /### Scene 5 heading/); // present as escaped literal text
    assert.match(html, /<pre>/); // embedded content is fenced
    assert.match(html, /<h3>/); // the structural per-record heading still renders
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
