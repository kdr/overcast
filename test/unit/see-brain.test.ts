import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brainSeeDisabled,
  resolveBrainChoice,
  buildSeePrompt,
  buildSeeContext,
  splitDescriptionOcr,
  mimeForImage,
  cloudglueBrainModel,
  cloudglueBrainModels,
  CLOUDGLUE_MODEL_ID,
  CLOUDGLUE_GENERAL_MEDIUM_MODEL_ID,
} from "../../src/providers/brain/vision.ts";
import { parseProviderSpec } from "../../src/verbs/setup.ts";
import { seeVerb } from "../../src/verbs/senses.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";

test("cloudglueBrainModels lists advanced (default, first) + general-medium, both image-capable", () => {
  const models = cloudglueBrainModels("https://api.example.test");
  assert.deepEqual(
    models.map((m) => m.id),
    [CLOUDGLUE_MODEL_ID, CLOUDGLUE_GENERAL_MEDIUM_MODEL_ID],
  );
  assert.equal(CLOUDGLUE_GENERAL_MEDIUM_MODEL_ID, "tinycloud:general-medium");
  for (const m of models) {
    assert.equal(m.provider, "cloudglue");
    assert.equal(m.baseUrl, "https://api.example.test");
    assert.ok(m.input.includes("image"), `${m.id} should accept image input`);
  }
  assert.equal(cloudglueBrainModel("https://api.example.test").id, CLOUDGLUE_MODEL_ID);
});

test("parseProviderSpec maps builtin:<name> to an inproc selector (prefix kept)", () => {
  assert.deepEqual(parseProviderSpec("builtin:brain"), { type: "inproc", module: "builtin:brain" });
  assert.deepEqual(parseProviderSpec("builtin:hf"), { type: "inproc", module: "builtin:hf" });
});

test("brainSeeDisabled honors off/0/false/no; anything else = enabled", () => {
  const saved = process.env.OVERCAST_SEE_BRAIN;
  try {
    for (const v of ["off", "0", "false", "no", "OFF", " No "]) {
      process.env.OVERCAST_SEE_BRAIN = v;
      assert.equal(brainSeeDisabled(), true, `expected disabled for ${JSON.stringify(v)}`);
    }
    for (const v of ["", "auto", "1", "on", "yes"]) {
      process.env.OVERCAST_SEE_BRAIN = v;
      assert.equal(brainSeeDisabled(), false, `expected enabled for ${JSON.stringify(v)}`);
    }
    delete process.env.OVERCAST_SEE_BRAIN;
    assert.equal(brainSeeDisabled(), false);
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_SEE_BRAIN;
    else process.env.OVERCAST_SEE_BRAIN = saved;
  }
});

test("resolveBrainChoice prefers an explicit profile.llm", () => {
  const p = defaultProfile();
  p.llm = { provider: "anthropic", model: "claude-opus-4-8" };
  assert.deepEqual(resolveBrainChoice(p), { provider: "anthropic", model: "claude-opus-4-8" });
});

test("buildSeePrompt: base is a detailed description; --prompt focuses; --ocr adds a TEXT format", () => {
  const base = buildSeePrompt();
  assert.match(base, /describe this image in detail/i);
  assert.match(buildSeePrompt("the license plate"), /the license plate/);
  const withOcr = buildSeePrompt(undefined, true);
  assert.match(withOcr, /DESCRIPTION:/);
  assert.match(withOcr, /TEXT:/);
});

test("splitDescriptionOcr parses the DESCRIPTION/TEXT format and 'none'", () => {
  assert.deepEqual(splitDescriptionOcr("DESCRIPTION: a red van\nTEXT: ACME CORP"), {
    caption: "a red van",
    ocr: "ACME CORP",
  });
  assert.deepEqual(splitDescriptionOcr("DESCRIPTION: a quiet street\nTEXT: none"), {
    caption: "a quiet street",
    ocr: "",
  });
  // no format → whole reply is the caption
  assert.deepEqual(splitDescriptionOcr("just a plain description"), {
    caption: "just a plain description",
    ocr: "",
  });
});

test("buildSeeContext frames the image as UNTRUSTED DATA in the system prompt (injection posture)", () => {
  // buildSeeContext is the exact Context seeWithBrain hands to the LLM, so this
  // asserts the counter-framing is actually SENT — not merely defined as a string.
  const ctx = buildSeeContext("QkFTRTY0", "/x/shot.jpg");

  // The untrusted-data counter-framing rides in the system prompt, mirroring the
  // pi-loop system prompt (src/extension/system-prompt.ts).
  assert.ok(ctx.systemPrompt, "expected a system prompt on the see context");
  assert.match(ctx.systemPrompt ?? "", /DATA, not instructions/i);
  assert.match(ctx.systemPrompt ?? "", /untrusted/i);

  // The describe/OCR task wording is preserved verbatim as the user message —
  // the framing is additive, not a rewrite of buildSeePrompt.
  const blocks = ctx.messages[0].content as Array<{ type: string; text?: string }>;
  const textBlock = blocks.find((b) => b.type === "text");
  assert.equal(textBlock?.text, buildSeePrompt());
  // ...and the untrusted image travels in the same turn.
  assert.ok(blocks.some((b) => b.type === "image"), "expected the image block");
});

test("buildSeeContext preserves --prompt focus and --ocr task wording (framing unchanged)", () => {
  const ctx = buildSeeContext("QkFTRTY0", "/x/shot.png", "the license plate", true);
  const blocks = ctx.messages[0].content as Array<{ type: string; text?: string }>;
  const textBlock = blocks.find((b) => b.type === "text");
  assert.equal(textBlock?.text, buildSeePrompt("the license plate", true));
  // Framing is identical regardless of task options.
  assert.match(ctx.systemPrompt ?? "", /DATA, not instructions/i);
});

test("mimeForImage maps extensions (default jpeg)", () => {
  assert.equal(mimeForImage("/x/a.png"), "image/png");
  assert.equal(mimeForImage("/x/a.JPG"), "image/jpeg");
  assert.equal(mimeForImage("/x/a.webp"), "image/webp");
  // every image ext kindForExt admits must map to its real MIME (Bugbot: avif/tiff went out as image/jpeg)
  assert.equal(mimeForImage("/x/a.avif"), "image/avif");
  assert.equal(mimeForImage("/x/a.tif"), "image/tiff");
  assert.equal(mimeForImage("/x/a.tiff"), "image/tiff");
  assert.equal(mimeForImage("/x/a.unknown"), "image/jpeg");
});

test("see builtin:brain forced with an unresolvable brain → clean error record (no fallback)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-seebrain-"));
  try {
    const c = openCase(dir);
    c.ensure();
    const p = defaultProfile();
    // A provider id that no builtin catalog knows → resolution fails locally
    // (no network), so the forced brain path returns an error record.
    p.llm = { provider: "no-such-provider", model: "no-such-model" };
    p.providers = { ...p.providers, see: { type: "inproc", module: "builtin:brain" } };
    const ctx: VerbContext = { input: join(dir, "shot.jpg"), rest: [], opts: {}, case: c, profile: p };
    const [rec] = await seeVerb.run(ctx);
    assert.equal(rec.verb, "see");
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /brain/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("see rejects an unknown builtin selector", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-seebad-"));
  try {
    const c = openCase(dir);
    c.ensure();
    const p = defaultProfile();
    p.providers = { ...p.providers, see: { type: "inproc", module: "builtin:bogus" } };
    const ctx: VerbContext = { input: join(dir, "shot.jpg"), rest: [], opts: {}, case: c, profile: p };
    const [rec] = await seeVerb.run(ctx);
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /builtin:bogus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
