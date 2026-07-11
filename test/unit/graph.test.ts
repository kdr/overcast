import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { makeRecord, type OvercastRecord } from "../../src/record.ts";
import { buildGraphModel, harvestEntities, type GraphModel } from "../../src/signals/graph.ts";
import { renderGraphHtml } from "../../src/report/graph.ts";
import {
  parseExtractionReply,
  mergeExtractions,
  extractCachePath,
  loadExtractCache,
  runExtraction,
  type ExtractCacheLine,
} from "../../src/providers/brain/extract.ts";
import { openCase } from "../../src/case.ts";
import { addTarget } from "../../src/state/target.ts";
import { graphVerb } from "../../src/verbs/graph.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const OPTS = { caseName: "case", caseDir: "/tmp/case", now: 1_700_000_000_000 };

function rec(verb: string, payload: Record<string, unknown>, opts: { ref?: string; id?: string; state?: string } = {}): OvercastRecord {
  return makeRecord({
    verb,
    format: "json",
    payload,
    ...(opts.ref ? { media: { ref: opts.ref } } : {}),
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.state ? { state: opts.state } : {}),
  });
}

function nodeIds(m: GraphModel): string[] {
  return m.nodes.map((n) => n.id);
}

function hasEdge(m: GraphModel, source: string, target: string, kind?: string): boolean {
  return m.edges.some(
    (e) =>
      ((e.source === source && e.target === target) || (e.source === target && e.target === source)) &&
      (kind === undefined || e.kind === kind),
  );
}

// ---- structural harvest -------------------------------------------------------

test("buildGraphModel: finding links its source record and stamped target", () => {
  const watch = rec("watch", { content: "a van parked outside" }, { ref: "clip.mp4", id: "rec_src1" });
  const finding = rec("finding", { text: "white van spotted", status: "open", source_record: "rec_src1", source_verb: "watch", trigger: "human", target_id: "tgt_ab" }, { id: "rec_fnd1" });
  const m = buildGraphModel([watch, finding], {
    ...OPTS,
    targets: [{ id: "tgt_ab", kind: "prompt", value: "who owns the white van", created: "2026-01-01T00:00:00Z" }],
  });
  assert.ok(nodeIds(m).includes("fnd:rec_fnd1"));
  assert.ok(nodeIds(m).includes("tgt:tgt_ab"));
  assert.ok(hasEdge(m, "fnd:rec_fnd1", "rec:rec_src1", "finding-source"));
  assert.ok(hasEdge(m, "fnd:rec_fnd1", "tgt:tgt_ab", "finding-target"));
});

test("buildGraphModel: shared media.ref becomes one hub node linking records transitively", () => {
  const a = rec("watch", { content: "scene one" }, { ref: "shared.mp4", id: "rec_a" });
  const b = rec("listen", { transcript: "hello there" }, { ref: "shared.mp4", id: "rec_b" });
  const m = buildGraphModel([a, b], OPTS);
  const mediaNodes = m.nodes.filter((n) => n.type === "media");
  assert.equal(mediaNodes.length, 1);
  assert.equal(mediaNodes[0].ref, "shared.mp4");
  assert.ok(hasEdge(m, "rec:rec_a", "media:shared.mp4", "senses"));
  assert.ok(hasEdge(m, "rec:rec_b", "media:shared.mp4", "senses"));
  assert.equal(mediaNodes[0].degree, 2); // the hub
});

test("buildGraphModel: note links its related_record", () => {
  const capture = rec("capture", { title: "the post" }, { ref: "post.mp4", id: "rec_cap" });
  const note = rec("note", { text: "this matches the tipline photo", related_record: "rec_cap", ref: "post.mp4" }, { id: "rec_note" });
  const m = buildGraphModel([capture, note], OPTS);
  assert.ok(hasEdge(m, "rec:rec_note", "rec:rec_cap", "note-ref"));
});

test("buildGraphModel: exif records sharing a serial hang off one device node", () => {
  const a = rec("exif", { summary: "meta", make: "Canon", model: "EOS R5", serial: "SN9" }, { ref: "a.jpg", id: "rec_x1" });
  const b = rec("exif", { summary: "meta", make: "Canon", model: "EOS R5", serial: "SN9" }, { ref: "b.jpg", id: "rec_x2" });
  const m = buildGraphModel([a, b], OPTS);
  const dev = m.nodes.find((n) => n.type === "device");
  assert.ok(dev, "device node exists");
  assert.match(dev!.label, /Canon EOS R5 \(serial SN9\)/);
  assert.ok(hasEdge(m, dev!.id, "rec:rec_x1", "device-member"));
  assert.ok(hasEdge(m, dev!.id, "rec:rec_x2", "device-member"));
  // the clustered serial must NOT also spawn a duplicate entity node
  assert.equal(m.nodes.filter((n) => n.type === "entity" && n.entityType === "serial").length, 0);
});

test("buildGraphModel: match-verb records link query media to matched media", () => {
  const img = rec("image", { op: "match", index: "logos", summary: "1 match", matches: [{ label: "logo", db_img_path: "/refs/logo.jpg", num_inliers: 42 }] }, { ref: "frame.png", id: "rec_im" });
  const m = buildGraphModel([img], OPTS);
  assert.ok(nodeIds(m).includes("media:/refs/logo.jpg"));
  assert.ok(hasEdge(m, "rec:rec_im", "media:/refs/logo.jpg", "match"));
  assert.ok(hasEdge(m, "rec:rec_im", "media:frame.png", "senses"));
});

test("buildGraphModel: cluster ingest yields person nodes", () => {
  const cl = rec("cluster", { op: "ingest", index: "faces", summary: "1 face", faces: [{ cluster_id: "p_1", label: "Alice", similarity: null }] }, { ref: "alice.jpg", id: "rec_cl" });
  const m = buildGraphModel([cl], OPTS);
  const person = m.nodes.find((n) => n.type === "person");
  assert.ok(person);
  assert.equal(person!.label, "Alice");
  assert.ok(hasEdge(m, person!.id, "rec:rec_cl", "match"));
});

test("buildGraphModel: place nodes from payload.place and coarse GPS dedupe", () => {
  const a = rec("exif", { summary: "meta", place: "Lisbon, Portugal", gps: { lat: 38.7223, lng: -9.1393 } }, { ref: "a.jpg", id: "rec_p1" });
  const b = rec("exif", { summary: "meta", gps: { lat: 38.7224, lng: -9.1391 } }, { ref: "b.jpg", id: "rec_p2" });
  const c = rec("exif", { summary: "meta", gps: { lat: 38.7226, lng: -9.1394 } }, { ref: "c.jpg", id: "rec_p3" });
  const m = buildGraphModel([a, b, c], OPTS);
  const places = m.nodes.filter((n) => n.type === "place");
  // one named place + ONE coarse gps bucket for the two nameless neighbors (~20m apart)
  assert.equal(places.length, 2);
  assert.ok(places.some((p) => p.label === "Lisbon, Portugal"));
});

test("harvestEntities: email/phone/handle/url/domain/hashtag; timestamps and ids stay out", () => {
  const ents = harvestEntities(
    "Contact alice@example.com or +351 912 345 678, also (415) 555-0100. " +
      "Posted by @some_user at https://example.org/p/1 #protest — " +
      "recorded 2026-07-01 12:34:56, id rec_a1b2c3d4e5f60708, color #fff",
  );
  const by = (t: string) => ents.filter((e) => e.type === t).map((e) => e.label);
  assert.deepEqual(by("email"), ["alice@example.com"]);
  assert.equal(by("phone").length, 2);
  assert.deepEqual(by("handle"), ["@some_user"]);
  assert.deepEqual(by("url"), ["https://example.org/p/1"]);
  assert.deepEqual(by("domain"), ["example.org"]);
  assert.deepEqual(by("hashtag"), ["#protest"]); // #fff (hex color) rejected
  // no phone harvested from the date/time or the record id digits
  assert.ok(!by("phone").some((p) => p.includes("2026") || p.includes(":")));
});

test("buildGraphModel: entities link to the records that mention them", () => {
  const scan = rec("scan", { title: "post", snippet: "DM me at bob@mail.net", url: "https://social.example/p/9" }, { id: "rec_s1" });
  const m = buildGraphModel([scan], OPTS);
  assert.ok(hasEdge(m, "ent:email:bob@mail.net", "rec:rec_s1", "mentions"));
  assert.ok(hasEdge(m, "ent:domain:social.example", "rec:rec_s1", "mentions"));
});

test("buildGraphModel: memoryRecords boundary — operational records and suggested findings stay out", () => {
  const evidence = rec("watch", { content: "real evidence" }, { ref: "e.mp4", id: "rec_ok" });
  const operational = rec("map", { mode: "map", points: 3 }, { id: "rec_map" });
  const suggested = rec("finding", { text: "auto lead", status: "suggested", source_record: "rec_ok", source_verb: "watch", trigger: "face-match" }, { id: "rec_sug" });
  const dismissedRoot = rec("finding", { text: "bad lead", status: "open", source_record: "rec_ok", source_verb: "watch", trigger: "human" }, { id: "rec_dis" });
  const dismissReview = rec("finding", { finding_id: "rec_dis", status: "dismissed" }, { id: "rec_rev" });
  const m = buildGraphModel([evidence, operational, suggested, dismissedRoot, dismissReview], OPTS);
  assert.ok(nodeIds(m).includes("rec:rec_ok"));
  assert.ok(!nodeIds(m).includes("rec:rec_map"), "operational map record must not appear");
  assert.ok(!nodeIds(m).includes("fnd:rec_sug"), "suggested finding must not appear");
  assert.ok(!nodeIds(m).includes("fnd:rec_dis"), "dismissed finding must not appear");
});

test("buildGraphModel: target links evidence via the shared thread matcher", () => {
  const watch = rec("watch", { content: "the white van circled the block twice" }, { ref: "clip.mp4", id: "rec_ev" });
  const m = buildGraphModel([watch], {
    ...OPTS,
    targets: [{ id: "tgt_v", kind: "prompt", value: "white van", created: "2026-01-01T00:00:00Z" }],
  });
  assert.ok(hasEdge(m, "tgt:tgt_v", "rec:rec_ev", "target-evidence"));
});

test("buildGraphModel: --focus keeps only the 2-hop neighborhood", () => {
  // chain: noteB → recA → mediaA ; island: recC → mediaC
  const a = rec("watch", { content: "anchor scene" }, { ref: "a.mp4", id: "rec_a" });
  const b = rec("note", { text: "note about anchor", related_record: "rec_a" }, { id: "rec_b" });
  const c = rec("watch", { content: "unrelated" }, { ref: "c.mp4", id: "rec_c" });
  const m = buildGraphModel([a, b, c], { ...OPTS, focus: "rec_a" });
  assert.ok(nodeIds(m).includes("rec:rec_a"));
  assert.ok(nodeIds(m).includes("media:a.mp4"));
  assert.ok(nodeIds(m).includes("rec:rec_b"));
  assert.ok(!nodeIds(m).includes("rec:rec_c"), "unconnected record excluded by --focus");
  assert.ok(!nodeIds(m).includes("media:c.mp4"));
});

test("buildGraphModel: --limit trims lowest-degree entities first, never finding-linked records", () => {
  const watch = rec("watch", { content: "mail x@y.zz and w@q.rr and https://one.example and #tag1 and #tag2" }, { ref: "clip.mp4", id: "rec_w" });
  const finding = rec("finding", { text: "important", status: "open", source_record: "rec_w", source_verb: "watch", trigger: "human" }, { id: "rec_f" });
  const full = buildGraphModel([watch, finding], OPTS);
  assert.ok(full.nodes.length > 4);
  const m = buildGraphModel([watch, finding], { ...OPTS, limit: 3 });
  assert.equal(m.nodes.length, 3);
  assert.ok(m.stats.truncated > 0);
  assert.ok(nodeIds(m).includes("rec:rec_w"), "finding-linked record survives the trim");
  assert.ok(nodeIds(m).includes("fnd:rec_f"), "finding survives the trim");
  assert.equal(m.nodes.filter((n) => n.type === "entity").length, 0, "entities trimmed first");
});

test("buildGraphModel: --limit never trims the --focus anchor", () => {
  // several same-rank leaf entities around one record; focus on ONE entity —
  // without the anchor pin it would trim among the first (lowest-degree entity).
  const watch = rec("watch", { content: "mail anchor@spot.zz and w@q.rr and https://one.example and #tag1 and #tag2" }, { ref: "clip.mp4", id: "rec_w" });
  const m = buildGraphModel([watch], { ...OPTS, focus: "anchor@spot.zz", limit: 2 });
  assert.ok(m.stats.truncated > 0, "limit engaged");
  assert.ok(nodeIds(m).includes("ent:email:anchor@spot.zz"), "focus anchor survives the trim");
});

test("buildGraphModel: --since drops old dated evidence, keeps undated", () => {
  const oldRec = rec("watch", { content: "old" }, { ref: "old.mp4", id: "rec_old" });
  (oldRec.meta as Record<string, unknown>).time = "2020-01-01T00:00:00Z";
  const newRec = rec("watch", { content: "new" }, { ref: "new.mp4", id: "rec_new" });
  (newRec.meta as Record<string, unknown>).time = "2026-07-01T00:00:00Z";
  const undated = rec("watch", { content: "undated" }, { ref: "u.mp4", id: "rec_und" });
  delete (undated.meta as Record<string, unknown>).time;
  const m = buildGraphModel([oldRec, newRec, undated], { ...OPTS, sinceCutoff: Date.parse("2026-01-01T00:00:00Z") });
  const recNodes = m.nodes.filter((n) => n.type === "record").map((n) => n.recordId).sort();
  assert.deepEqual(recNodes, ["rec_new", "rec_und"]);
});

test("buildGraphModel: --since is capture-time-aware — exif payload.created beats ingest time (map parity)", () => {
  // old geotagged photo ingested TODAY: capture time must exclude it
  const oldPhoto = rec("exif", { created: "2020:03:01 12:00:00", gps: { lat: 1, lng: 2 } }, { ref: "old.jpg", id: "rec_oldphoto" });
  (oldPhoto.meta as Record<string, unknown>).time = "2026-07-01T00:00:00Z";
  // recent capture on an old-ingested record: capture time must keep it
  const newPhoto = rec("exif", { created: "2026:06:30 12:00:00" }, { ref: "new.jpg", id: "rec_newphoto" });
  (newPhoto.meta as Record<string, unknown>).time = "2020-01-01T00:00:00Z";
  const m = buildGraphModel([oldPhoto, newPhoto], { ...OPTS, sinceCutoff: Date.parse("2026-01-01T00:00:00Z") });
  const recNodes = m.nodes.filter((n) => n.type === "record").map((n) => n.recordId);
  assert.deepEqual(recNodes, ["rec_newphoto"]);
});

test("buildGraphModel: --since co-includes the out-of-window source record of an in-window finding", () => {
  const oldWatch = rec("watch", { content: "old clip evidence" }, { ref: "old.mp4", id: "rec_src" });
  (oldWatch.meta as Record<string, unknown>).time = "2020-01-01T00:00:00Z";
  const finding = rec("finding", { text: "confirmed sighting", status: "open", source_record: "rec_src", source_verb: "watch", trigger: "human" }, { id: "rec_f" });
  (finding.meta as Record<string, unknown>).time = "2026-07-01T00:00:00Z";
  const m = buildGraphModel([oldWatch, finding], { ...OPTS, sinceCutoff: Date.parse("2026-01-01T00:00:00Z") });
  assert.ok(nodeIds(m).includes("fnd:rec_f"));
  assert.ok(nodeIds(m).includes("rec:rec_src"), "finding provenance pulled back in");
  assert.ok(hasEdge(m, "fnd:rec_f", "rec:rec_src", "finding-source"));
  assert.equal(m.stats.evidenceRecords, 2, "co-included source counts as considered evidence");
});

test("buildGraphModel: connected components counted; stats byType populated", () => {
  const a = rec("watch", { content: "one" }, { ref: "a.mp4", id: "rec_1" });
  const b = rec("watch", { content: "two" }, { ref: "b.mp4", id: "rec_2" });
  const m = buildGraphModel([a, b], OPTS);
  assert.equal(m.stats.components, 2);
  assert.equal(m.stats.byType.record, 2);
  assert.equal(m.stats.byType.media, 2);
});

// ---- extraction parse + merge ---------------------------------------------------

test("parseExtractionReply: clean strict JSON", () => {
  const r = parseExtractionReply('{"entities":[{"name":"Bob Ray","type":"person","aliases":["B. Ray"]}],"relations":[{"source":"Bob Ray","relation":"works at","target":"Acme"}]}');
  assert.equal(r.entities.length, 1);
  assert.equal(r.entities[0].type, "person");
  assert.deepEqual(r.entities[0].aliases, ["B. Ray"]);
  assert.equal(r.relations.length, 1);
});

test("parseExtractionReply: fenced + dirty JSON with prose and malformed items", () => {
  const reply =
    "Sure! Here's the extraction:\n```json\n" +
    '{"entities":[{"name":"Acme Corp","type":"ORG"},{"type":"person"},{"name":"","type":"person"},{"name":"Zed","type":"martian"}],' +
    '"relations":[{"source":"Zed","relation":"owns","target":"Acme Corp"},{"source":"Zed","relation":"","target":"x"},"garbage"]}\n' +
    "```\nHope that helps!";
  const r = parseExtractionReply(reply);
  assert.equal(r.entities.length, 2); // nameless items skipped
  assert.equal(r.entities[0].type, "org"); // case-normalized
  assert.equal(r.entities[1].type, "other"); // unknown type coerced
  assert.equal(r.relations.length, 1); // empty-relation + garbage skipped
});

test("parseExtractionReply: trailing prose after bare JSON; no JSON at all", () => {
  const r = parseExtractionReply('{"entities":[{"name":"A","type":"person"}],"relations":[]} — extracted 1 entity.');
  assert.equal(r.entities.length, 1);
  assert.deepEqual(parseExtractionReply("I could not find any entities."), { entities: [], relations: [] });
});

test("mergeExtractions: name normalization folds aliases into one node; relations resolve through them", () => {
  const lines: ExtractCacheLine[] = [
    { recordId: "rec_1", time: "t", model: "m", entities: [{ name: "Bob Ray", type: "person", aliases: ["Bobby"] }], relations: [] },
    { recordId: "rec_2", time: "t", model: "m", entities: [{ name: "bob ray", type: "person", aliases: [] }], relations: [{ source: "Bobby", relation: "visited", target: "Warehouse 7" }] },
  ];
  const merged = mergeExtractions(lines);
  const bob = merged.entities.filter((e) => e.key === "bob ray");
  assert.equal(bob.length, 1, "same normalized name = one entity");
  assert.deepEqual(bob[0].recordIds.sort(), ["rec_1", "rec_2"]);
  assert.equal(merged.relations.length, 1);
  assert.equal(merged.relations[0].sourceKey, "bob ray"); // alias resolved
  assert.equal(merged.relations[0].targetType, "other"); // unseen endpoint lands as other
});

test("mergeExtractions: same name with different types stays two entities; same-type alias still folds", () => {
  const lines: ExtractCacheLine[] = [
    { recordId: "rec_1", time: "t", model: "m", entities: [{ name: "Jordan", type: "person", aliases: [] }], relations: [] },
    { recordId: "rec_2", time: "t", model: "m", entities: [{ name: "Jordan", type: "location", aliases: [] }], relations: [] },
    { recordId: "rec_3", time: "t", model: "m", entities: [{ name: "jordan", type: "person", aliases: [] }], relations: [] },
  ];
  const merged = mergeExtractions(lines);
  const jordans = merged.entities.filter((e) => e.key === "jordan").map((e) => e.type).sort();
  assert.deepEqual(jordans, ["location", "person"], "type is part of entity identity");
  const person = merged.entities.find((e) => e.key === "jordan" && e.type === "person");
  assert.deepEqual(person!.recordIds.sort(), ["rec_1", "rec_3"], "same-type mention still folds");
});

test("extraction merge lands in the graph as extracted entity nodes + relation edges", () => {
  const watch = rec("watch", { content: "surveillance footage" }, { ref: "c.mp4", id: "rec_w" });
  const lines: ExtractCacheLine[] = [
    {
      recordId: "rec_w",
      time: "t",
      model: "m",
      entities: [
        { name: "Bob Ray", type: "person", aliases: [] },
        { name: "Acme Corp", type: "org", aliases: [] },
      ],
      relations: [{ source: "Bob Ray", relation: "works at", target: "Acme Corp" }],
    },
  ];
  const m = buildGraphModel([watch], { ...OPTS, extraction: mergeExtractions(lines) });
  const bob = m.nodes.find((n) => n.id === "ent:person:bob ray");
  assert.ok(bob);
  assert.equal(bob!.extracted, true);
  assert.ok(hasEdge(m, "ent:person:bob ray", "rec:rec_w", "mentions"));
  assert.ok(hasEdge(m, "ent:person:bob ray", "ent:org:acme corp", "relation"));
  const rel = m.edges.find((e) => e.kind === "relation");
  assert.equal(rel!.label, "works at");
});

test("extract cache: load skips torn lines; runExtraction with no brain reports unavailable but keeps cached lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-graph-cache-"));
  try {
    const file = extractCachePath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const good: ExtractCacheLine = { recordId: "rec_c", time: "t", model: "m", entities: [{ name: "X", type: "person", aliases: [] }], relations: [] };
    writeFileSync(file, JSON.stringify(good) + "\n{torn line\n", "utf8");
    const cache = loadExtractCache(dir);
    assert.equal(cache.size, 1);
    assert.ok(cache.has("rec_c"));

    const cachedRec = rec("watch", { content: "cached text" }, { ref: "c.mp4", id: "rec_c" });
    const freshRec = rec("watch", { content: "fresh text" }, { ref: "f.mp4", id: "rec_f" });
    // pin an unresolvable brain so the test never picks up an ambient Cloudglue
    // key from the host env/config (deterministic + offline).
    const profile = { name: "t", providers: {}, llm: { provider: "no-such-provider", model: "no-such-model" } };
    const run = await runExtraction([cachedRec, freshRec], { profile: profile as never, caseDir: dir });
    assert.ok(run.unavailable, "missing brain surfaces as unavailable, not a throw");
    assert.equal(run.cached, 1);
    assert.equal(run.ran, 0);
    assert.equal(run.lines.length, 1); // cached line still feeds the merge
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runExtraction: sinceCutoff co-filters the corpus — out-of-window cached lines stay out of the merge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-graph-since-"));
  try {
    const file = extractCachePath(dir);
    mkdirSync(dirname(file), { recursive: true });
    const lineOld: ExtractCacheLine = { recordId: "rec_old", time: "t", model: "m", entities: [{ name: "Old Co", type: "org", aliases: [] }], relations: [] };
    const lineNew: ExtractCacheLine = { recordId: "rec_new", time: "t", model: "m", entities: [{ name: "New Co", type: "org", aliases: [] }], relations: [] };
    writeFileSync(file, JSON.stringify(lineOld) + "\n" + JSON.stringify(lineNew) + "\n", "utf8");

    const oldRec = rec("watch", { content: "old text" }, { ref: "o.mp4", id: "rec_old" });
    (oldRec.meta as Record<string, unknown>).time = "2020-01-01T00:00:00Z";
    const newRec = rec("watch", { content: "new text" }, { ref: "n.mp4", id: "rec_new" });
    (newRec.meta as Record<string, unknown>).time = "2026-07-01T00:00:00Z";
    // both records cached → no brain resolution needed (offline-safe)
    const profile = { name: "t", providers: {}, llm: { provider: "no-such-provider", model: "no-such-model" } };
    const run = await runExtraction([oldRec, newRec], { profile: profile as never, caseDir: dir, sinceCutoff: Date.parse("2026-01-01T00:00:00Z") });
    assert.equal(run.cached, 1);
    assert.deepEqual(run.lines.map((l) => l.recordId), ["rec_new"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- HTML viewer -----------------------------------------------------------------

test("renderGraphHtml: self-contained, CSP'd, data inlined, no external assets", () => {
  const watch = rec("watch", { content: "mail a@b.cc" }, { ref: "clip.mp4", id: "rec_h" });
  const m = buildGraphModel([watch], OPTS);
  const html = renderGraphHtml(m, "plain");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'unsafe-inline'/);
  assert.match(html, /const NODES=/);
  assert.match(html, /const EDGES=/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /https?:\/\/(?:cdn|unpkg|jsdelivr)/i);
  // node labels escape into the embedded JSON safely
  assert.match(html, /knowledge graph/);
});

test("renderGraphHtml: </script> in a label cannot break out of the inline script", () => {
  const evil = rec("note", { text: "</script><script>alert(1)</script>" }, { id: "rec_evil" });
  const m = buildGraphModel([evil], OPTS);
  const html = renderGraphHtml(m, "csi");
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script/);
});

// ---- verb ------------------------------------------------------------------------

function withCase(fn: (c: ReturnType<typeof openCase>, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "oc-graph-"));
  const c = openCase(dir);
  c.ensure();
  return Promise.resolve(fn(c, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function ctxFor(c: ReturnType<typeof openCase>, opts: Record<string, unknown> = {}): VerbContext {
  return {
    input: undefined,
    rest: [],
    opts: { theme: "plain", "no-open": true, ...opts },
    case: c,
    profile: { name: "test", providers: {} },
    profileName: "test",
  } as unknown as VerbContext;
}

test("graphVerb: empty case → transient pending guidance, no artifact", () =>
  withCase(async (c) => {
    const [out] = await graphVerb.run(ctxFor(c));
    assert.equal(out.state, "pending");
    assert.equal(out.meta?.transient, true);
    const p = out.payload as Record<string, unknown>;
    assert.equal(p.viewer, null);
    assert.match(String(p.note), /no evidence records/);
  }));

test("graphVerb: writes graph.html into mediaDir and emits a compact node/edge payload", () =>
  withCase(async (c) => {
    c.writeRecord(rec("watch", { content: "the white van at the docks" }, { ref: "clip.mp4", id: "rec_w1" }));
    c.writeRecord(rec("note", { text: "van also in tip photo", related_record: "rec_w1" }, { id: "rec_n1" }));
    addTarget(c, "white van", { question: "who owns it?" });
    const [out] = await graphVerb.run(ctxFor(c));
    assert.equal(out.state, "ready");
    const p = out.payload as Record<string, unknown>;
    assert.equal(p.mode, "graph");
    const viewer = String(p.viewer);
    assert.ok(viewer.endsWith("graph.html"));
    assert.ok(existsSync(viewer));
    const html = readFileSync(viewer, "utf8");
    assert.match(html, /const NODES=/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    const nodes = p.node_list as Array<Record<string, unknown>>;
    const edges = p.edge_list as Array<Record<string, unknown>>;
    assert.ok(nodes.some((n) => n.type === "target"));
    assert.ok(nodes.some((n) => n.type === "record" && n.record_id === "rec_w1"));
    assert.ok(edges.some((e) => e.kind === "note-ref"));
    assert.ok(edges.some((e) => e.kind === "target-evidence"));
    assert.equal(p.caveat, undefined, "no extraction → no caveat");
  }));

test("graphVerb: invalid flags produce error records; --focus miss explains itself", () =>
  withCase(async (c) => {
    assert.equal((await graphVerb.run(ctxFor(c, { theme: "neon" })))[0].state, "error");
    assert.equal((await graphVerb.run(ctxFor(c, { limit: -1 })))[0].state, "error");
    assert.equal((await graphVerb.run(ctxFor(c, { since: "not-a-date" })))[0].state, "error");
    c.writeRecord(rec("watch", { content: "x" }, { ref: "a.mp4", id: "rec_z" }));
    const [miss] = await graphVerb.run(ctxFor(c, { focus: "no-such-node" }));
    assert.equal(miss.state, "pending");
    assert.match(String((miss.payload as Record<string, unknown>).note), /--focus 'no-such-node' matched no node/);
  }));
