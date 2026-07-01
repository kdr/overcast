import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brainSeeDisabled,
  resolveBrainChoice,
  buildSeePrompt,
  splitDescriptionOcr,
  mimeForImage,
} from "../../src/providers/brain/vision.ts";
import { parseProviderSpec } from "../../src/verbs/setup.ts";
import { seeVerb } from "../../src/verbs/senses.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import type { VerbContext } from "../../src/registry/types.ts";

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
