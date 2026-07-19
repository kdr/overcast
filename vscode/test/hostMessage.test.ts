// Admission rules for host→webview messages (webview/src/hostMessage.ts).
// A security boundary with no test is a decorative one, so the stray-sender
// cases are pinned here rather than left to a code review to re-derive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptHostMessage, isHostMsg, originAllowed } from "../webview/src/hostMessage.ts";

const SELF = "vscode-webview://0deadbeef-1111-2222-3333-444455556666";

test("originAllowed: only the panel's own origin", () => {
  assert.ok(originAllowed(SELF, SELF));
  // a DIFFERENT vscode-webview panel must not reach this handler
  assert.ok(!originAllowed("vscode-webview://ffffffff-9999-8888-7777-666655554444", SELF));
  // opaque / sandboxed frames
  assert.ok(!originAllowed("", SELF));
  assert.ok(!originAllowed("null", SELF));
  // plain remote pages
  assert.ok(!originAllowed("https://example.com", SELF));
  // prefix games around the real origin
  assert.ok(!originAllowed(SELF + ".evil.test", SELF));
  assert.ok(!originAllowed("https://evil.test/" + SELF, SELF));
});

test("originAllowed: an OPAQUE self origin rejects rather than matching its twin", () => {
  // both `""` and `"null"` are opaque — a sandboxed frame reports `"null"` too,
  // so equality alone would admit exactly the sender this is meant to reject
  assert.ok(!originAllowed("", ""));
  assert.ok(!originAllowed("null", "null"));
  assert.ok(!originAllowed("null", ""));
  assert.ok(!originAllowed("", "null"));
  assert.ok(!originAllowed("https://example.com", ""));
  assert.ok(!originAllowed("https://example.com", "null"));
});

test("isHostMsg: requires the discriminant the host contract is built on", () => {
  assert.ok(isHostMsg({ type: "init" }));
  assert.ok(!isHostMsg({ noType: true }));
  assert.ok(!isHostMsg(null));
  assert.ok(!isHostMsg("init"));
  assert.ok(!isHostMsg(42));
  assert.ok(!isHostMsg({ type: 7 })); // non-string discriminant
});

test("acceptHostMessage: both gates must pass", () => {
  const msg = { type: "init", view: "record", state: {} };
  assert.deepEqual(acceptHostMessage({ origin: SELF, data: msg }, SELF), msg);
  // right shape, wrong sender
  assert.equal(acceptHostMessage({ origin: "https://evil.test", data: msg }, SELF), undefined);
  // right sender, junk payload
  assert.equal(acceptHostMessage({ origin: SELF, data: { nope: 1 } }, SELF), undefined);
});
