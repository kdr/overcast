import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  scanManifests,
  manifestChoices,
  manifestPresets,
  manifestSourceEntries,
  manifestSourceDescriptor,
  manifestHostRoutes,
} from "../../src/providers/manifests.ts";
import { validateManifest } from "../../src/providers/manifest-schema.ts";
import { resolveShippedRefToken } from "../../src/providers/shipped-ref.ts";

// The catalog + source registry are built from per-directory provider.json
// manifests scanned at runtime. These guards keep the shipped manifests valid and
// self-consistent (the CI-side successor to the hand-listed catalog checks).

test("every shipped provider.json validates against the schema", () => {
  const loaded = scanManifests().filter((l) => l.origin === "shipped");
  assert.ok(loaded.length >= 30, `expected the shipped manifests to be discovered, got ${loaded.length}`);
  for (const lm of loaded) {
    const res = validateManifest(lm.manifest);
    assert.ok(res.ok, `${lm.dir}/provider.json invalid: ${res.errors.join("; ")}`);
  }
});

test("all expected shipped sense packages + source types are present", () => {
  const senseIds = new Set(manifestChoices().map((c) => `${c.verb}:${c.id}`));
  for (const id of [
    "see:hf", "enhance:hf", "see:fal", "enhance:fal", "reconstruct:fal", "see:tinycloud",
    "listen:elevenlabs", "enhance:elevenlabs", "see:owl-local", "enhance:local-models",
    "enhance:ela", "enhance:panorama", "geocode:nominatim",
  ]) {
    assert.ok(senseIds.has(id), `missing sense choice ${id}`);
  }
  const types = new Set(manifestSourceEntries().map((e) => e.type));
  for (const t of [
    "youtube", "tiktok", "x", "web", "lens", "dl", "gdelttv", "overpass", "firms", "dispatch",
    "instagram", "telegram", "facesearch", "webcam", "dork", "shodan", "username", "person",
    "phone", "property", "plate", "browser", "flights", "yandeximg",
  ]) {
    assert.ok(types.has(t), `missing source type ${t}`);
  }
});

test("sense (verb,id) and source type+aliases are unique across manifests", () => {
  const seenChoice = new Set<string>();
  for (const c of manifestChoices()) {
    const key = `${c.verb}:${c.id}`;
    assert.ok(!seenChoice.has(key), `duplicate sense choice ${key}`);
    seenChoice.add(key);
  }
  const seenType = new Set<string>();
  for (const e of manifestSourceEntries()) {
    for (const t of [e.type, ...(e.aliases ?? [])]) {
      assert.ok(!seenType.has(t), `duplicate source type/alias ${t}`);
      seenType.add(t);
    }
  }
});

test("every sense descriptor + source base resolves to a file that exists in this build", () => {
  for (const c of manifestChoices()) {
    for (const cmd of [c.descriptor?.run, c.descriptor?.describe,
      typeof c.descriptor?.init === "string" ? c.descriptor.init : c.descriptor?.init?.command]) {
      if (typeof cmd !== "string") continue;
      for (const token of cmd.split(/\s+/)) {
        if (!token.startsWith("shipped:")) continue;
        assert.ok(resolveShippedRefToken(token), `${c.verb}:${c.id} ref does not resolve: ${token}`);
      }
    }
  }
  for (const e of manifestSourceEntries()) {
    const desc = manifestSourceDescriptor(e.type);
    assert.ok(desc, `source ${e.type} has no descriptor`);
    const script = desc!.base[desc!.base.length - 1];
    assert.ok(existsSync(script), `source ${e.type} script does not exist: ${script}`);
  }
});

test("source aliases resolve to the same descriptor; unknown types return undefined", () => {
  const x = manifestSourceDescriptor("x");
  const twitter = manifestSourceDescriptor("twitter");
  assert.ok(x && twitter, "x and its twitter alias both resolve");
  assert.equal(x!.base[x!.base.length - 1], twitter!.base[twitter!.base.length - 1], "alias runs the same script");
  assert.equal(manifestSourceDescriptor("no-such-source"), undefined);
});

test("source doctor descriptors are well-formed (env checks carry env, probes carry notes)", () => {
  for (const e of manifestSourceEntries()) {
    const d = e.doctor;
    if (!d) continue;
    if (d.check === "env_all" || d.check === "env_any") {
      assert.ok(Array.isArray(d.env) && d.env.length > 0, `${e.type} ${d.check} needs env[]`);
      assert.ok(d.missingNote, `${e.type} needs a missingNote`);
    }
    assert.ok(d.okNote, `${e.type} doctor needs an okNote`);
  }
});

test("manifest presets + host routes are consistent", () => {
  const presets = manifestPresets();
  // hf/fal/elevenlabs/owl-local/local-models presets come from manifests
  for (const p of ["hf", "fal", "elevenlabs", "owl-local", "local-models"]) {
    assert.ok(presets[p], `missing manifest preset ${p}`);
  }
  // every host route points at a real source type
  const types = new Set(manifestSourceEntries().flatMap((e) => [e.type, ...(e.aliases ?? [])]));
  for (const { host, type } of manifestHostRoutes()) {
    assert.ok(types.has(type), `host ${host} routes to unknown type ${type}`);
  }
});
