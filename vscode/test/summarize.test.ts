// Pure-logic tests for src/chat/summarize.ts (no vscode import — plain node --test).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerText,
  caseSummary,
  citedRecordIds,
  failureMessage,
  formatAge,
  MAX_FIELD_CHARS,
  MAX_JSON_CHARS,
  recordBlurb,
  scanHits,
  summarizeRecord,
  summarizeVerbResult,
  toModelJson,
} from "../src/chat/summarize.ts";
import type { OvercastRecord } from "../src/types.ts";

const rec = (over: Partial<OvercastRecord>): OvercastRecord => ({
  id: "rec_1",
  verb: "see",
  format: "json",
  payload: {},
  ...over,
});

test("summarizeRecord: always keeps id/verb/state, defaults state to ready", () => {
  const out = summarizeRecord(rec({ payload: { caption: "a cat" } }));
  assert.equal(out.id, "rec_1");
  assert.equal(out.verb, "see");
  assert.equal(out.state, "ready");
  assert.deepEqual(out.payload, { caption: "a cat" });
});

test("summarizeRecord: keeps error + media, and explicit state", () => {
  const out = summarizeRecord(
    rec({ state: "error", error: "no provider", media: { ref: "/clip.mp4", at: 3 } }),
  );
  assert.equal(out.state, "error");
  assert.equal(out.error, "no provider");
  assert.deepEqual(out.media, { ref: "/clip.mp4", at: 3 });
});

test("summarizeRecord: caps long string fields to MAX_FIELD_CHARS", () => {
  const long = "word ".repeat(1000); // 5000 chars of prose (whitespace = not binary)
  const out = summarizeRecord(rec({ payload: { content: long } }));
  const content = (out.payload as { content: string }).content;
  assert.ok(content.length <= MAX_FIELD_CHARS, `got ${content.length}`);
  assert.ok(content.endsWith("…"));
});

test("summarizeRecord: fieldCap override lets ask answers survive", () => {
  const long = "ab ".repeat(500); // 1500 chars of prose
  const out = summarizeRecord(rec({ verb: "ask", payload: { text: long } }), { fieldCap: 2000 });
  assert.equal((out.payload as { text: string }).text.length, 1500);
});

test("summarizeRecord: drops number arrays, bulk keys, and base64 blobs", () => {
  const out = summarizeRecord(
    rec({
      payload: {
        summary: "1 face",
        embedding: [0.1, 0.2, 0.3],
        boxes: [{ x: 1 }],
        face_landmarks: [1, 2, 3],
        vector: [9, 9],
        thumbnail: "data:image/png;base64,AAAABBBB",
        blob: "QUJD" + "Z".repeat(400),
      },
    }),
  );
  const p = out.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(p), ["summary"]);
});

test("toModelJson: caps total JSON length", () => {
  const big = { text: "z".repeat(MAX_JSON_CHARS * 2) };
  const s = toModelJson(big);
  assert.ok(s.length <= MAX_JSON_CHARS + 32);
  assert.ok(s.endsWith("…(truncated)"));
});

test("summarizeVerbResult: picks the verb record over trailing findings", () => {
  const records: OvercastRecord[] = [
    rec({ id: "rec_note", verb: "note", payload: { text: "hi" } }),
    rec({ id: "rec_find", verb: "finding", payload: { text: "lead" } }),
  ];
  const json = summarizeVerbResult(records, "note");
  assert.ok(json.includes("rec_note"));
  assert.ok(!json.includes("rec_find"));
});

test("scanHits: extracts fields, skips pull_progress + error rows", () => {
  const records: OvercastRecord[] = [
    rec({ id: "h1", verb: "scan", payload: { title: "T1", url: "http://a", snippet: "s", source: "web" } }),
    rec({ id: "p", verb: "scan", payload: { op: "pull_progress" } }),
    rec({ id: "e", verb: "scan", state: "error", payload: { title: "boom" } }),
    rec({ id: "x", verb: "note", payload: { text: "not a hit" } }),
  ];
  const hits = scanHits(records);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { id: "h1", title: "T1", url: "http://a", snippet: "s", source: "web" });
});

test("formatAge: humanizes seconds and handles never", () => {
  assert.equal(formatAge(null), "never");
  assert.equal(formatAge(undefined), "never");
  assert.equal(formatAge(10), "just now");
  assert.equal(formatAge(120), "2m ago");
  assert.equal(formatAge(7200), "2h ago");
  assert.equal(formatAge(172800), "2d ago");
});

test("caseSummary: maps threads, sources, leads, and record count", () => {
  const summary = caseSummary({
    info: { name: "Op Harbor" },
    store: { records: 42 },
    threads: [
      {
        id: "t1",
        value: "the barge",
        kind: "thing",
        question: "who owns the barge?",
        status: "active",
        stage: "digging",
        evidence: { watch: 2, see: 1 },
        funnel: { scan: 0, captures: 0, senses: 0, matches: 0 },
        findings: {},
        recent: { day: 0, week: 0 },
        activityBins: [],
        recentIds: [],
        recentEvidenceIds: [],
        findingIds: ["f1", "f2"],
      },
    ],
    coverage: [
      { id: "s1", spec: "youtube:@x", type: "youtube", enabled: true, lastScanAgeSeconds: 3600, hits: 5, captured: 1, sensed: 1, gap: false },
      { id: "s2", spec: "web:q", type: "web", enabled: true, lastScanAgeSeconds: null, hits: 0, captured: 0, sensed: 0, gap: true },
    ],
    triage: [{ id: "l1", text: "lead" }],
  } as never);
  assert.equal(summary.case, "Op Harbor");
  assert.equal(summary.records, 42);
  assert.equal(summary.suggestedLeads, 1);
  assert.equal(summary.threads.length, 1);
  assert.deepEqual(summary.threads[0], {
    line: "who owns the barge?",
    status: "active",
    stage: "digging",
    evidence: 3,
    findings: 2,
  });
  assert.equal(summary.sources[0].lastScan, "1h ago");
  assert.equal(summary.sources[1].lastScan, "never");
  assert.equal(summary.sources[1].gap, true);
});

test("answerText + citedRecordIds: pull the answer and citations", () => {
  const askRec = rec({
    verb: "ask",
    payload: {
      text: "The barge is registered to Acme.",
      citations: [
        { recordId: "rec_a", at: 3, verb: "watch" },
        { recordId: "rec_b", verb: "note" },
        { verb: "see" },
      ],
    },
  });
  assert.equal(answerText(askRec), "The barge is registered to Acme.");
  assert.deepEqual(citedRecordIds(askRec), ["rec_a", "rec_b"]);
});

test("recordBlurb: text, else media, else payload keys", () => {
  assert.equal(recordBlurb(rec({ payload: { summary: "one hit" } })), "one hit");
  assert.equal(recordBlurb(rec({ payload: {}, media: { ref: "/x.mp4" } })), "media: /x.mp4");
  assert.equal(recordBlurb(rec({ payload: { a: 1, b: 2 } })), "payload: a, b");
});

test("failureMessage: needs_credentials keeps the CLI message verbatim", () => {
  const m = failureMessage({ kind: "needs_credentials", message: "APIFY_TOKEN not set" });
  assert.ok(m.includes("APIFY_TOKEN not set"));
  assert.ok(m.includes("overcast setup"));
  assert.equal(failureMessage({ kind: "usage", message: "bad flag" }).startsWith("overcast rejected"), true);
  assert.equal(failureMessage({ kind: "error", message: "boom" }), "overcast failed: boom");
});
