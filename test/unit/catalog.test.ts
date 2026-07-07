import { test } from "node:test";
import assert from "node:assert/strict";
import { providerChoices } from "../../src/providers/catalog.ts";

/** The `run` command of the owl-local (see) catalog choice, resolved now. */
function owlLocalRun(): string {
  const c = providerChoices().find((c) => c.id === "owl-local" && c.verb === "see");
  assert.ok(c?.descriptor && "run" in c.descriptor, "owl-local see choice has an exec descriptor");
  return (c!.descriptor as { run: string }).run;
}

test("owl-local detector honors $DETECT_PY (venv python), else falls back to python3", () => {
  const saved = process.env.DETECT_PY;
  try {
    delete process.env.DETECT_PY;
    assert.match(owlLocalRun(), /^python3 .*detect\.py$/, "no DETECT_PY → python3");

    process.env.DETECT_PY = "/venv/bin/python";
    const run = owlLocalRun();
    assert.ok(run.startsWith("/venv/bin/python "), `DETECT_PY should win, got: ${run}`);
    assert.match(run, /detect\.py$/); // the script path is resolved via shippedPath (absolute where installed)
  } finally {
    if (saved === undefined) delete process.env.DETECT_PY;
    else process.env.DETECT_PY = saved;
  }
});
