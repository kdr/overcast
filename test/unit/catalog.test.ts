import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { providerChoices, findProviderChoice, PROVIDER_PRESETS } from "../../src/providers/catalog.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `run` command of the owl-local (see) catalog choice, resolved now. */
function owlLocalRun(): string {
  const c = providerChoices().find((c) => c.id === "owl-local" && c.verb === "see");
  assert.ok(c?.descriptor && "run" in c.descriptor, "owl-local see choice has an exec descriptor");
  return (c!.descriptor as { run: string }).run;
}

test("voice-print catalog choice + preset are registered for the voice verb", () => {
  const choice = findProviderChoice("voice", "voice-print");
  assert.ok(choice, "voice-print choice exists");
  assert.equal(choice!.descriptor?.type, "inproc");
  const init = (choice!.descriptor as { init?: { command?: string } }).init?.command ?? "";
  assert.match(init, /visual-db-uv\.sh --voice/);
  assert.ok(choice!.env?.includes("OVERCAST_VOICE_MODEL"));
  assert.deepEqual(PROVIDER_PRESETS["voice-print"], [{ verb: "voice", choice: "voice-print" }]);
});

test("owl-local detector honors $DETECT_PY (venv python), else falls back to python3", () => {
  const saved = process.env.DETECT_PY;
  try {
    delete process.env.DETECT_PY;
    assert.match(owlLocalRun(), /^python3 .*detect\.py$/, "no DETECT_PY → python3");

    process.env.DETECT_PY = "/venv/bin/python";
    const run = owlLocalRun();
    assert.ok(run.startsWith("/venv/bin/python "), `DETECT_PY should win, got: ${run}`);
    // the interpreter is persisted as given; the script travels as a shipped: ref
    assert.match(run, /shipped:providers\/senses\/detect\/detect\.py$/);
  } finally {
    if (saved === undefined) delete process.env.DETECT_PY;
    else process.env.DETECT_PY = saved;
  }
});

test("ela / panorama / nominatim are catalog choices with shipped: ref descriptors", () => {
  const ela = findProviderChoice("enhance", "ela");
  assert.ok(ela, "ela choice exists");
  assert.equal(ela!.descriptor?.run, "python3 shipped:providers/senses/enhance/ela.py");
  assert.equal(ela!.descriptor?.describe, "python3 shipped:providers/senses/enhance/ela.py describe");
  assert.equal(ela!.indexableDefault, true, "matches fal enhance");
  assert.ok(!ela!.descriptor!.run!.includes("{{input}}"), "no {{input}} → input appended last (documented bind semantics)");

  const panorama = findProviderChoice("enhance", "panorama");
  assert.ok(panorama, "panorama choice exists");
  assert.equal(panorama!.descriptor?.run, "python3 shipped:providers/senses/enhance/panorama.py");
  assert.equal(panorama!.indexableDefault, true);

  const nominatim = findProviderChoice("geocode", "nominatim");
  assert.ok(nominatim, "nominatim choice exists");
  assert.equal(nominatim!.descriptor?.run, "bash shipped:providers/senses/geocode/geocode.sh --input {{input}}");
  assert.equal(nominatim!.indexableDefault, false, "geocode is opt-in enrichment, not indexable evidence");
});

test("NO catalog descriptor persists an absolute path — every script reference is a shipped: ref", () => {
  const saved = process.env.DETECT_PY;
  try {
    delete process.env.DETECT_PY; // DETECT_PY deliberately persists the venv interpreter path when set
    for (const choice of providerChoices()) {
      const d = choice.descriptor;
      if (!d) continue;
      const commands = [
        d.run,
        d.describe,
        typeof d.init === "string" ? d.init : d.init?.command,
      ].filter((c): c is string => typeof c === "string");
      for (const cmd of commands) {
        for (const token of cmd.split(/\s+/)) {
          assert.ok(!token.startsWith("/"), `${choice.verb}:${choice.id} persists an absolute path token: ${token}`);
          if (/\.(sh|py|mjs)$/.test(token)) {
            assert.ok(token.startsWith("shipped:"), `${choice.verb}:${choice.id} script reference must be a shipped: ref: ${token}`);
          }
        }
      }
    }
  } finally {
    if (saved === undefined) delete process.env.DETECT_PY;
    else process.env.DETECT_PY = saved;
  }
});

// Regression (Bugbot #104: "Sidecar omits visual-db script"): a `shipped:` ref
// resolves beside the executable in the compiled bun binary, so EVERY ref target
// must be copied there by scripts/bun-sidecar.mjs. The `providers/` tree is copied
// wholesale; any ref OUTSIDE providers/ (e.g. shipped:scripts/visual-db-uv.sh)
// needs its own copy step, or `provider init`/describe breaks on the binary.
test("every non-providers/ shipped: ref the catalog emits is mirrored into the bun sidecar", () => {
  const sidecar = readFileSync(join(REPO, "scripts", "bun-sidecar.mjs"), "utf8");
  const copiesProvidersTree = /join\(OUT, "providers"\)/.test(sidecar);
  const refs = new Set<string>();
  for (const choice of providerChoices()) {
    for (const cmd of [choice.descriptor?.run, choice.descriptor?.describe,
      typeof choice.descriptor?.init === "string" ? choice.descriptor.init : choice.descriptor?.init?.command]) {
      if (typeof cmd !== "string") continue;
      for (const token of cmd.split(/\s+/)) if (token.startsWith("shipped:")) refs.add(token.slice("shipped:".length));
    }
  }
  assert.ok(refs.size > 0, "sanity: the catalog emits shipped: refs");
  for (const rel of refs) {
    if (rel.startsWith("providers/")) {
      assert.ok(copiesProvidersTree, "bun-sidecar must copy the providers/ tree");
      continue;
    }
    const base = rel.split("/").pop()!;
    assert.ok(sidecar.includes(base), `bun-sidecar.mjs must copy '${rel}' into the sidecar (ref won't resolve on the binary otherwise)`);
  }
});
