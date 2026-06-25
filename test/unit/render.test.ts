import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRecord } from "../../src/record.ts";
import {
  renderRecord,
  payloadFields,
  payloadBytes,
  fieldText,
  humanSize,
} from "../../src/render.ts";

test("humanSize formats bytes/KB/MB", () => {
  assert.equal(humanSize(412), "412B");
  assert.equal(humanSize(1536), "1.5KB");
  assert.equal(humanSize(48 * 1024), "48KB");
  assert.equal(humanSize(2 * 1024 * 1024), "2.0MB");
});

test("payloadBytes measures string vs object payloads", () => {
  assert.equal(payloadBytes(makeRecord({ verb: "x", payload: "abcde" })), 5);
  const obj = makeRecord({ verb: "x", payload: { a: 1 } });
  assert.equal(payloadBytes(obj), Buffer.byteLength(JSON.stringify({ a: 1 })));
});

test("fieldText is the canonical pageable form (string/scalar/object) and guards circular", () => {
  assert.equal(fieldText("hello"), "hello");
  assert.equal(fieldText(42), "42");
  assert.equal(fieldText(null), "");
  assert.equal(fieldText({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
  // circular value must NOT throw (records are disk-parsed, but be defensive)
  const circ: Record<string, unknown> = {};
  circ.self = circ;
  assert.doesNotThrow(() => fieldText(circ));
});

test("payloadFields: manifest chars === the text the pager slices", () => {
  const content = "a".repeat(5000);
  const detailed = { segments: [1, 2, 3], title: "t" };
  const rec = makeRecord({ verb: "watch", payload: { content, transcript: "", detailed } });
  const fields = payloadFields(rec.payload);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  // string field: chars === string length, matches what paging would report as `total`
  assert.equal(byName.content.type, "string");
  assert.equal(byName.content.chars, content.length);
  assert.equal(byName.content.chars, fieldText(content).length);
  // object field: chars === pretty-JSON length (same text the pager slices)
  assert.equal(byName.detailed.type, "object");
  assert.equal(byName.detailed.chars, fieldText(detailed).length);
  assert.equal(byName.detailed.count, 2);
});

test("payloadFields: a string payload is reported as a single (text) field", () => {
  const fields = payloadFields("just a plain string payload");
  assert.equal(fields.length, 1);
  assert.equal(fields[0].name, "(text)");
  assert.equal(fields[0].chars, "just a plain string payload".length);
});

test("renderRecord preview shows per-field sizes and no pointer for a small payload", () => {
  const rec = makeRecord({ verb: "ask", payload: { text: "short answer", question: "q?" } });
  const out = renderRecord(rec, { mode: "preview" });
  assert.match(out, /\[ask\] state=ready payload:/);
  assert.match(out, /text/);
  assert.doesNotMatch(out, /case memory get/); // small → no paging pointer
});

test("renderRecord full inlines a within-budget payload (agent sees the answer)", () => {
  const rec = makeRecord({ verb: "ask", payload: { text: "The tribe opposed the energy park.", question: "who?" } });
  const out = renderRecord(rec, { mode: "full", budget: 8000 });
  assert.match(out, /The tribe opposed the energy park\./); // full text present
});

test("renderRecord full renders a nested field exactly as paging would (fieldText)", () => {
  const detailed = { segments: [1, 2, 3], title: "t" };
  const rec = makeRecord({ verb: "watch", payload: { detailed } });
  const out = renderRecord(rec, { mode: "full", budget: 8000 });
  assert.ok(out.includes(fieldText(detailed))); // inline form === pageable form (pretty JSON)
});

test("renderRecord full degrades an over-budget payload to preview + paging pointer", () => {
  const big = "X".repeat(50_000);
  const rec = makeRecord({ id: "rec_big01", verb: "watch", payload: { content: big, transcript: "" } });
  const out = renderRecord(rec, { mode: "full", budget: 8000 });
  assert.doesNotMatch(out, /X{500}/); // NOT inlined whole (preview width is ~200)
  assert.match(out, /content \(/); // size reported
  assert.match(out, /case memory get rec_big01 --field <name>/); // pointer to page it
});

test("renderRecord force inlines regardless of budget (explicit page slice)", () => {
  const big = "Y".repeat(20_000);
  const rec = makeRecord({ verb: "case", payload: { chunk: big, field: "content", next_offset: 20000 } });
  const out = renderRecord(rec, { mode: "full", budget: 8000, force: true });
  assert.match(out, /YYYYYYYYYY/); // inlined despite exceeding budget
});

test("renderRecord points a string payload to --offset paging (no --field)", () => {
  const rec = makeRecord({ id: "rec_str01", verb: "x", payload: "Z".repeat(20_000) });
  const out = renderRecord(rec, { mode: "full", budget: 8000 });
  assert.match(out, /case memory get rec_str01 --offset 0/);
});

test("renderRecord surfaces an error record", () => {
  const rec = makeRecord({ verb: "watch", payload: {}, error: "boom", state: "error" });
  assert.match(renderRecord(rec), /error=boom/);
});
