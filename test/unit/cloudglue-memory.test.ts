// Offline unit tests for the opt-in Cloudglue memory provider (`ask --deep` over
// a case-linked media-descriptions collection). Everything runs against the
// stubbed tinycloud CLI (OVERCAST_TINYCLOUD_CMD → test/fixtures/fake-tinycloud.sh),
// so the REAL envelope→record→passage mapping runs with NO live creds. Invariant
// #9: the provider never imports the Cloudglue SDK; it goes through tcAsk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { addIndex } from "../../src/state/index.ts";
import { emptySetup, saveSetup, loadSetup } from "../../src/state/setup.ts";
import { CloudglueMemoryProvider } from "../../src/providers/memory/cloudglue.ts";
import { resolveMemory, fanOutAnswer } from "../../src/providers/memory/index.ts";
import { LocalMemoryProvider } from "../../src/providers/memory/local.ts";
import { setupVerb } from "../../src/verbs/setup.ts";
import { askVerb } from "../../src/verbs/read.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const FIXTURE = `bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")}`;

function withCase(fn: (c: ReturnType<typeof openCase>, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-cg-"));
  const c = openCase(dir);
  c.ensure();
  return Promise.resolve(fn(c, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Run `fn` with a controlled env, restoring every touched key afterward. `null`
 *  deletes the key for the duration (used to force "no Cloudglue key"). */
async function withEnv(vars: Record<string, string | null>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Write a fake tinycloud (in `dir`) that tallies each `ask`/`probe` call by
 *  appending one byte to `countFile`, so a test can PROVE call coalescing (count
 *  the bytes = the number of paid cloud calls). `body`:
 *   - "delegate": exec the shared realistic fixture (answer + one citation);
 *   - "empty": return a ready answer with NO text/citations, so `deepsearch`
 *     yields [] and `fanOutAnswer` falls through to `answer` — the exact
 *     Finding-A double-call path.
 *  Returns the `base` command string to hand the provider. */
function countingTinycloud(dir: string, countFile: string, body: "delegate" | "empty" = "delegate"): string {
  const script = join(dir, `counting-tc-${body}.sh`);
  const emit =
    body === "empty"
      ? `echo '{"tinycloud":"1","kind":"ask","status":"ready","data":{"answer":"","citations":[]}}'`
      : `exec bash ${join(process.cwd(), "test/fixtures/fake-tinycloud.sh")} "$@"`;
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      `if [ "\${1:-}" = "ask" ] || [ "\${1:-}" = "probe" ]; then printf x >> ${countFile}; fi`,
      emit,
      "",
    ].join("\n"),
  );
  return `bash ${script}`;
}

/** Count the paid cloud calls a `countingTinycloud` fake tallied. */
function askCalls(countFile: string): number {
  return existsSync(countFile) ? readFileSync(countFile, "utf8").length : 0;
}

test("status() is missing without a collection (key present)", async () => {
  await withCase(async (c) => {
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const p = new CloudglueMemoryProvider(c, { indexId: "", collectionId: "" });
      const st = await p.status();
      assert.equal(st.state, "missing");
      assert.match(st.error ?? "", /media-descriptions|CLOUDGLUE_API_KEY/);
    });
  });
});

test("status() is missing without a Cloudglue key (collection present)", async () => {
  await withCase(async (c, dir) => {
    // point HOME at an empty dir so readTinycloudKey finds no ~/.tinycloud key,
    // and drop CLOUDGLUE_API_KEY — resolveCloudglue().apiKey must be undefined.
    await withEnv({ CLOUDGLUE_API_KEY: null, HOME: dir }, async () => {
      const p = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x" });
      const st = await p.status();
      assert.equal(st.state, "missing");
    });
  });
});

test("status() is ready with a key and a collection", async () => {
  await withCase(async (c) => {
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const p = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x" });
      const st = await p.status();
      assert.equal(st.state, "ready");
      assert.equal((st.config as Record<string, unknown>).collection, "col_x");
    });
  });
});

test("query() is empty — a plain ask never touches the cloud", async () => {
  await withCase(async (c) => {
    const p = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x", base: FIXTURE });
    assert.deepEqual(p.query("anything"), []);
  });
});

test("deepsearch() maps the tinycloud ask envelope to anchored passages", async () => {
  await withCase(async (c) => {
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const p = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x", base: FIXTURE });
      const passages = await p.deepsearch("why did the buyer object?");
      assert.equal(passages.length, 1);
      const [hit] = passages;
      // fixture ask envelope: answer "They objected to the price.", citation
      // { file: "vid1.mp4", timestamp: 42 }
      assert.equal(hit.recordId, "vid1.mp4");
      assert.equal(hit.at, 42);
      assert.match(hit.text, /objected to the price/);
      assert.equal(hit.provider, "cloudglue");
    });
  });
});

test("answer() returns the grounded answer + mapped citations", async () => {
  await withCase(async (c) => {
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const p = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x", base: FIXTURE });
      const ans = await p.answer("why did the buyer object?");
      assert.match(ans.text, /objected to the price/);
      assert.equal(ans.citations.length, 1);
      assert.equal(ans.citations[0].recordId, "vid1.mp4");
      assert.equal(ans.citations[0].at, 42);
    });
  });
});

// ---- Finding A: deepsearch + answer for one query = ONE paid tcAsk call -------

test("deepsearch + answer for the same query coalesce into ONE tcAsk call (no double cloud spend)", async () => {
  await withCase(async (c, dir) => {
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const countFile = join(dir, "ask-calls-direct");
      const base = countingTinycloud(dir, countFile, "delegate");
      const p = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x", base });
      // both public entry points call the private run() for the SAME query.
      const passages = await p.deepsearch("why did the buyer object?");
      const ans = await p.answer("why did the buyer object?");
      assert.equal(passages.length, 1); // still fully functional
      assert.match(ans.text, /objected to the price/);
      assert.equal(askCalls(countFile), 1, "the per-instance memo must collapse both to ONE tcAsk call");
    });
  });
});

test("fanOutAnswer (deep) with an empty cloud result makes ONE tcAsk call, not two", async () => {
  // Reproduces the exact Finding-A path: deepsearch yields no passages, so
  // fanOutAnswer falls through to answer(). Without the memo that is two paid
  // calls for one user query; with it, one.
  await withCase(async (c, dir) => {
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const countFile = join(dir, "ask-calls-fanout");
      const base = countingTinycloud(dir, countFile, "empty");
      const cloud = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x", base });
      await fanOutAnswer([cloud], "why did the buyer object?", {}, true);
      assert.equal(askCalls(countFile), 1, "deepsearch()→[] then answer() must share ONE tcAsk call");
    });
  });
});

test("distinct queries are NOT coalesced (the memo keys on the query)", async () => {
  await withCase(async (c, dir) => {
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const countFile = join(dir, "ask-calls-distinct");
      const base = countingTinycloud(dir, countFile, "delegate");
      const p = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x", base });
      await p.deepsearch("first question?");
      await p.answer("second question?");
      assert.equal(askCalls(countFile), 2, "different queries must each make their own call");
    });
  });
});

test("resolveMemory includes cloudglue only when opted in, deep, keyed, with a collection", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {}; // opt in (default: first attached media-descriptions index)
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(deep.some((p) => p.id === "cloudglue"), "deep resolution includes cloudglue when opted in");
      const shallow = resolveMemory(c, defaultProfile(), { deep: false });
      assert.ok(!shallow.some((p) => p.id === "cloudglue"), "non-deep resolution never includes cloudglue");
      // default (no opts) must also stay cloud-free — plain ask/brief path
      assert.ok(!resolveMemory(c, defaultProfile()).some((p) => p.id === "cloudglue"));
    });
  });
});

test("resolveMemory omits cloudglue when the case has an index but no opt-in (no silent spend)", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    // no setup.memory.cloudglue → NOT opted in, even with a media-descriptions index + key
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(!deep.some((p) => p.id === "cloudglue"));
    });
  });
});

test("resolveMemory omits cloudglue when opted in but no Cloudglue key resolves", async () => {
  await withCase(async (c, dir) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: null, HOME: dir }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(!deep.some((p) => p.id === "cloudglue"));
    });
  });
});

// ---- Finding B: an ambiguous pinned index name must NOT become a raw id -------

test("resolveMemory omits cloudglue when the pinned index name is AMBIGUOUS (fail closed, no wrong collection)", async () => {
  await withCase(async (c) => {
    // two mirror indexes share the display name "Scenes" → resolveIndexRef reports
    // ambiguity. The pinned name must NOT silently become a raw collection id.
    addIndex(c, { id: "col_a", name: "Scenes", type: "media-descriptions" });
    addIndex(c, { id: "col_b", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = { index: "Scenes" }; // pin the AMBIGUOUS name
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(
        !deep.some((p) => p.id === "cloudglue"),
        "an ambiguous pinned name must fail closed, not resolve to a raw collection id",
      );
    });
  });
});

test("resolveMemory still resolves a pinned name that is UNIQUE (ambiguity guard didn't over-reach)", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_a", name: "Scenes", type: "media-descriptions" });
    addIndex(c, { id: "col_b", name: "Other", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = { index: "Scenes" }; // unique name → resolves to col_a
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(deep.some((p) => p.id === "cloudglue"), "a unique pinned name still registers cloudglue");
    });
  });
});

test("resolveMemory still accepts a truly-unmirrored pinned id as a raw collection id", async () => {
  await withCase(async (c) => {
    // no index with this id/name in the mirror → resolveIndexRef returns {} →
    // raw remote id is the correct, preserved behavior (only ambiguity fails closed).
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = { index: "col_raw_remote" };
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(deep.some((p) => p.id === "cloudglue"), "an unmirrored pinned id still resolves as a raw remote id");
    });
  });
});

// ---- Round-4 Finding A: an 'unknown'-typed pinned index is ask-able ----------

test("resolveMemory registers cloudglue for a pinned 'unknown'-typed index (parity with ask --index)", async () => {
  await withCase(async (c) => {
    // an index added by raw id without --type stays "unknown"; `ask --index`
    // accepts it, so the Cloudglue deep tier must too (was previously rejected).
    addIndex(c, { id: "col_u", name: "Untyped", type: "unknown" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = { index: "col_u" }; // pin the untyped index
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(
        deep.some((p) => p.id === "cloudglue"),
        "an 'unknown'-typed pinned index must register cloudglue (mirrors ask --index)",
      );
    });
  });
});

test("resolveMemory rejects a pinned index whose type is neither media-descriptions nor unknown", async () => {
  await withCase(async (c) => {
    // a face-analysis index is not ask-able — still fails closed, unchanged.
    addIndex(c, { id: "col_f", name: "Faces", type: "face-analysis" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = { index: "col_f" };
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true });
      assert.ok(
        !deep.some((p) => p.id === "cloudglue"),
        "a non-ask-able (face-analysis) pinned index must not register cloudglue",
      );
    });
  });
});

test("fanOutAnswer (deep) merges the cloud citation with local ones", async () => {
  await withCase(async (c) => {
    c.writeRecord(makeRecord({ verb: "note", payload: { text: "The buyer objected to the price at the dock" }, media: { ref: "note1" } }));
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const local = new LocalMemoryProvider(c);
      const cloud = new CloudglueMemoryProvider(c, { indexId: "col_x", collectionId: "col_x", base: FIXTURE });
      const ans = await fanOutAnswer([local, cloud], "objected", {}, true);
      assert.ok(ans.citations.some((cit) => cit.recordId === "vid1.mp4"), "cloud citation present");
      assert.ok(ans.citations.some((cit) => cit.recordId !== "vid1.mp4"), "local citation present");
      assert.match(ans.text, /objected to the price/);
    });
  });
});

// ---- verb-level: ask --deep over the opted-in stubbed case --------------------

function ctx(c: ReturnType<typeof openCase>, input: string, opts: VerbContext["opts"] = {}): VerbContext {
  return { input, rest: [], opts, case: c, profile: defaultProfile() };
}

test("ask --deep answers over the case's Cloudglue collection when opted in", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key", OVERCAST_TINYCLOUD_CMD: FIXTURE }, async () => {
      const [rec] = await askVerb.run(ctx(c, "why did the buyer object?", { deep: true }));
      assert.equal(rec.state, "ready");
      assert.equal(rec.meta?.provider, "cloudglue");
      assert.match(String((rec.payload as Record<string, unknown>).text), /objected to the price/);
      const citations = (rec.payload as Record<string, unknown>).citations as Array<Record<string, unknown>>;
      assert.ok(citations.some((cit) => cit.recordId === "vid1.mp4"));
    });
  });
});

// ---- Round-3: the deep-no-provider error names Cloudglue when opted-in --------

test("ask --deep opted into Cloudglue but inactive → a Cloudglue-aware error, not a bare qmd suggestion", async () => {
  await withCase(async (c) => {
    // opted in, key present, but NO media-descriptions index attached → the cloud
    // tier can't activate, so no deepsearch provider resolves. The returned error
    // RECORD must point at the Cloudglue setup, not misdirect to `setup memory qmd`.
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const note = await captureStderr(async () => {
        const [rec] = await askVerb.run(ctx(c, "why did the buyer object?", { deep: true }));
        assert.equal(rec.state, "error");
        assert.match(rec.error ?? "", /Cloudglue/);
        // NOT the bare "no semantic memory provider … setup memory qmd" misdirection
        assert.doesNotMatch(rec.error ?? "", /^no semantic memory provider/);
      });
      // the round-2 stderr note (the specific reason) still fires alongside
      assert.match(note, /Cloudglue cloud tier inactive/);
    });
  });
});

test("ask --deep WITHOUT a Cloudglue opt-in keeps the existing qmd suggestion (unchanged)", async () => {
  await withCase(async (c) => {
    // no setup.memory.cloudglue → the deep-no-provider error stays the qmd message,
    // byte-for-byte the pre-round-3 behavior (no Cloudglue mention).
    const [rec] = await askVerb.run(ctx(c, "why did the buyer object?", { deep: true }));
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /no semantic memory provider is configured for --deep/);
    assert.match(rec.error ?? "", /overcast setup memory qmd/);
    assert.doesNotMatch(rec.error ?? "", /Cloudglue/);
  });
});

// ---- Round-4 Finding B: --memory filtering out an ACTIVE Cloudglue tier -------

test("ask --deep --memory local-grep with Cloudglue resolvable does NOT blame Cloudglue (it was filtered, not inactive)", async () => {
  await withCase(async (c) => {
    // Cloudglue opted in + keyed + a resolvable media-descriptions collection →
    // the cloudglue provider IS in `available`. Filtering to --memory local-grep
    // leaves no deepsearch provider, but that's the FILTER's doing, not a
    // Cloudglue failure — the error must not claim Cloudglue is inactive.
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key", OVERCAST_TINYCLOUD_CMD: FIXTURE }, async () => {
      const [rec] = await askVerb.run(ctx(c, "why did the buyer object?", { deep: true, memory: "local-grep" }));
      assert.equal(rec.state, "error");
      // NOT the round-3 "Cloudglue … inactive" text — Cloudglue resolved fine.
      assert.doesNotMatch(rec.error ?? "", /opted in for --deep but inactive/);
      // instead: either the --memory note or the standard qmd message.
      assert.match(rec.error ?? "", /--memory local-grep excluded|no semantic memory provider/);
    });
  });
});

// ---- opt-in surface: `setup memory cloudglue [index|off]` ---------------------

function setupCtx(c: ReturnType<typeof openCase>, dir: string, rest: string[]): VerbContext {
  return { input: "memory", rest, opts: {}, case: c, profile: defaultProfile(), home: dir, profileName: "default" };
}

test("setup memory cloudglue enables the opt-in in the case setup", async () => {
  await withCase(async (c, dir) => {
    const [rec] = await setupVerb.run(setupCtx(c, dir, ["cloudglue"]));
    assert.equal(rec.state, "ready");
    const saved = loadSetup(c);
    assert.deepEqual(saved?.memory.cloudglue, {});
  });
});

test("setup memory cloudglue <index> pins a specific media-descriptions index", async () => {
  await withCase(async (c, dir) => {
    await setupVerb.run(setupCtx(c, dir, ["cloudglue", "col_pinned"]));
    assert.deepEqual(loadSetup(c)?.memory.cloudglue, { index: "col_pinned" });
  });
});

test("setup memory cloudglue off clears the opt-in", async () => {
  await withCase(async (c, dir) => {
    await setupVerb.run(setupCtx(c, dir, ["cloudglue"]));
    await setupVerb.run(setupCtx(c, dir, ["cloudglue", "off"]));
    assert.equal(loadSetup(c)?.memory.cloudglue, undefined);
  });
});

// ---- Round-2 Finding A: the command's AbortSignal reaches the cloud provider --

test("resolveMemory threads the AbortSignal into the cloudglue provider config (deep ask is cancelable)", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const controller = new AbortController();
      const deep = resolveMemory(c, defaultProfile(), { deep: true, signal: controller.signal });
      const cloud = deep.find((p) => p.id === "cloudglue");
      assert.ok(cloud, "deep resolution includes cloudglue");
      // the config the provider forwards to tcAsk (run() passes this.ref.signal),
      // so an aborted command aborts the paid cloud query instead of leaking it.
      const ref = (cloud as unknown as { ref: { signal?: AbortSignal } }).ref;
      assert.equal(ref.signal, controller.signal, "the command's AbortSignal reaches the provider config");
    });
  });
});

test("resolveMemory without a signal leaves the cloud provider config signal undefined (backward-compatible)", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const deep = resolveMemory(c, defaultProfile(), { deep: true }); // no signal (case.ts caller)
      const cloud = deep.find((p) => p.id === "cloudglue");
      assert.ok(cloud);
      assert.equal((cloud as unknown as { ref: { signal?: AbortSignal } }).ref.signal, undefined);
    });
  });
});

// ---- Round-2 Finding B: opt-in that can't activate is NOT silent (stderr note)-

/** Capture everything written to process.stderr while `fn` runs, restoring the
 *  original writer afterward. Used to prove the cloud-tier note fires (or not). */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const target = process.stderr as unknown as { write: (chunk: string | Uint8Array) => boolean };
  const orig = target.write.bind(process.stderr);
  let out = "";
  target.write = (chunk) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    await fn();
  } finally {
    target.write = orig;
  }
  return out;
}

test("deep + opted-in but NO attached media-descriptions collection → a clear stderr note (not silent)", async () => {
  await withCase(async (c) => {
    // opted in, key present, but no media-descriptions index attached → no collection
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const note = await captureStderr(() => {
        const deep = resolveMemory(c, defaultProfile(), { deep: true });
        assert.ok(!deep.some((p) => p.id === "cloudglue"), "provider still omitted when no collection resolves");
      });
      assert.match(note, /Cloudglue cloud tier inactive/);
      assert.match(note, /no media-descriptions index/);
    });
  });
});

test("deep + opted-in but NO Cloudglue key → a distinct 'no key' stderr note", async () => {
  await withCase(async (c, dir) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: null, HOME: dir }, async () => {
      const note = await captureStderr(() => {
        resolveMemory(c, defaultProfile(), { deep: true });
      });
      assert.match(note, /Cloudglue cloud tier inactive/);
      assert.match(note, /no Cloudglue key/);
    });
  });
});

test("deep + opted-in with an AMBIGUOUS pinned index names the pin in the stderr note", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_a", name: "Scenes", type: "media-descriptions" });
    addIndex(c, { id: "col_b", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = { index: "Scenes" }; // ambiguous → fails closed
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const note = await captureStderr(() => resolveMemory(c, defaultProfile(), { deep: true }));
      assert.match(note, /pinned index 'Scenes'/);
    });
  });
});

test("NON-deep resolution never emits the cloud-tier note (plain ask / case memory status stay silent)", async () => {
  await withCase(async (c) => {
    // the exact condition that fires the note under --deep (opted in, no collection)
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const note = await captureStderr(() => {
        resolveMemory(c, defaultProfile(), { deep: false });
        resolveMemory(c, defaultProfile()); // default opts too
      });
      assert.equal(note, "", "non-deep resolution must stay silent about the cloud tier");
    });
  });
});

test("a cleanly-activating cloud tier emits NO stderr note", async () => {
  await withCase(async (c) => {
    addIndex(c, { id: "col_x", name: "Scenes", type: "media-descriptions" });
    const setup = emptySetup("cg-test");
    setup.completed = true;
    setup.memory.cloudglue = {};
    saveSetup(c, setup);
    await withEnv({ CLOUDGLUE_API_KEY: "test-key" }, async () => {
      const note = await captureStderr(() => {
        const deep = resolveMemory(c, defaultProfile(), { deep: true });
        assert.ok(deep.some((p) => p.id === "cloudglue"));
      });
      assert.equal(note, "", "a working cloud tier is silent");
    });
  });
});
