import { test } from "node:test";
import assert from "node:assert/strict";
import { isYeahTrigger, playerCandidates, registerYeahEasterEgg } from "../../src/extension/horatio.ts";

type InputHandler = (event: { type: "input"; text: string; source: string }) => { action: string } | void;

function fakePi() {
  let handler: InputHandler | undefined;
  const messages: string[] = [];
  const pi = {
    on: (event: string, h: InputHandler) => {
      if (event === "input") handler = h;
    },
    sendMessage: (message: { details?: { text?: string }; content?: string }) => {
      messages.push(message.details?.text ?? message.content ?? "");
    },
  };
  return { pi, input: (text: string) => handler?.({ type: "input", text, source: "interactive" }), messages };
}

test("isYeahTrigger matches /yeah and lone sunglasses, nothing else", () => {
  assert.equal(isYeahTrigger("/yeah"), true);
  assert.equal(isYeahTrigger("  /yeah  "), true);
  assert.equal(isYeahTrigger("\u{1F60E}"), true); // 😎
  assert.equal(isYeahTrigger("\u{1F576}"), true); // 🕶 bare
  assert.equal(isYeahTrigger("\u{1F576}️"), true); // 🕶️ with variation selector

  assert.equal(isYeahTrigger("/yeah!"), false);
  assert.equal(isYeahTrigger("/yeahhh"), false);
  assert.equal(isYeahTrigger("well \u{1F60E} then"), false);
  assert.equal(isYeahTrigger("\u{1F60E}\u{1F60E}"), false);
  assert.equal(isYeahTrigger("yeah"), false);
  assert.equal(isYeahTrigger(""), false);
});

test("input hook consumes triggers, plays the sting, and ignores everything else", () => {
  const { pi, input, messages } = fakePi();
  const played: string[] = [];
  registerYeahEasterEgg(pi as never, (file) => played.push(file));

  const hit = input("\u{1F60E}");
  assert.deepEqual(hit, { action: "handled" });
  assert.equal(played.length, 1);
  assert.match(played[0], /sting\.m4a$/);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /YEEEEAAAAAAAAHH!/);

  const miss = input("scan youtube:@someone \u{1F60E}");
  assert.equal(miss, undefined);
  assert.equal(played.length, 1);
  assert.equal(messages.length, 1);
});

test("playerCandidates prefers afplay on darwin and ffplay elsewhere", () => {
  const candidates = playerCandidates("/tmp/sting.m4a");
  assert.ok(candidates.length >= 1);
  if (process.platform === "darwin") {
    assert.equal(candidates[0].cmd, "afplay");
    assert.equal(candidates[1].cmd, "ffplay");
  } else {
    assert.equal(candidates[0].cmd, "ffplay");
  }
  for (const c of candidates) assert.ok(c.args.includes("/tmp/sting.m4a"));
});
