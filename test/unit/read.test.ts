import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { makeRecord } from "../../src/record.ts";
import { LocalMemoryProvider, recordText } from "../../src/providers/memory/local.ts";
import { resolveMemory, fanOutAnswer } from "../../src/providers/memory/index.ts";
import { askVerb, briefVerb } from "../../src/verbs/read.ts";
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
    assert.equal(new Set(ids).size, ids.length); // no dup citations
  });
});

test("resolveMemory always includes the local provider", async () => {
  await withCase((c) => {
    const providers = resolveMemory(c, defaultProfile());
    assert.ok(providers.some((p) => p.id === "local"));
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
    assert.match(rec.meta?.provider as string, /local/);
  });
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
