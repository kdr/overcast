// Structural guard against a recurring Bugbot class: a verb honors --limit/--since
// (often via a shared helper) but silently falls back to a default on a bad value
// instead of erroring. This locks PARITY — every verb that takes --limit/--since
// must reject an invalid one. Add new such verbs here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../../src/fs-path.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { scanVerb, monitorVerb } from "../../src/verbs/osint.ts";
import { askVerb } from "../../src/verbs/read.ts";
import { caseVerb } from "../../src/verbs/case.ts";
import { parseVerbArgs } from "../../src/registry/to-cli.ts";
import { VERBS } from "../../src/registry/verbs.ts";
import type { VerbContext, OvercastRecord, VerbSpec } from "../../src/registry/types.ts";

test("the CLI parser rejects a non-numeric OR empty value for ANY declared number flag", () => {
  const spec = { name: "x", summary: "", description: "", args: [], outputKind: "x", group: "read",
    flags: [{ name: "limit", summary: "", type: "number" }] } as unknown as VerbSpec;
  assert.ok(parseVerbArgs(spec, ["--limit", "abc"]).errors.some((e) => /--limit expects a number/.test(e)));
  assert.ok(parseVerbArgs(spec, ["--limit=nope"]).errors.some((e) => /--limit expects a number/.test(e)));
  // a blank `--limit=` must NOT coerce to 0 (Number("")===0) and silently pass an
  // inclusive lower bound downstream — the parser rejects it here, for every verb.
  assert.ok(parseVerbArgs(spec, ["--limit="]).errors.some((e) => /--limit expects a number/.test(e)));
  const okp = parseVerbArgs(spec, ["--limit", "7"]);
  assert.equal(okp.errors.length, 0);
  assert.equal(okp.opts.limit, 7);
  assert.equal(parseVerbArgs(spec, ["--limit", "0"]).errors.length, 0); // a real 0 is still valid
  // every real number flag in the registry inherits this (parse-layer, one place)
  for (const v of VERBS) {
    for (const f of v.flags.filter((f) => f.type === "number")) {
      assert.ok(
        parseVerbArgs(v, [`--${f.name}`, "notanumber"]).errors.some((e) => new RegExp(`--${f.name} expects a number`).test(e)),
        `${v.name} --${f.name} should reject a non-numeric value`,
      );
      assert.ok(
        parseVerbArgs(v, [`--${f.name}=`]).errors.some((e) => new RegExp(`--${f.name} expects a number`).test(e)),
        `${v.name} --${f.name} should reject a blank value`,
      );
    }
  }
});

test("expandHome expands a leading ~ / ~/ and leaves everything else alone", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/Downloads/clip.mov"), join(homedir(), "Downloads/clip.mov"));
  assert.equal(expandHome("/abs/path.mp4"), "/abs/path.mp4");
  assert.equal(expandHome("rel/path.mp4"), "rel/path.mp4");
  assert.equal(expandHome("https://x/v.mp4"), "https://x/v.mp4");
  assert.equal(expandHome("~user/x"), "~user/x"); // another user's home is left to the shell
});

test("parseVerbArgs expands a leading ~/ in the positional AND path flags (no shell to do it)", () => {
  const spec = { name: "face", summary: "", description: "", args: [{ name: "input" }], outputKind: "x", group: "sense",
    flags: [{ name: "match", summary: "", type: "string" }] } as unknown as VerbSpec;
  const p = parseVerbArgs(spec, ["~/Downloads/bbq.mp4", "--match", "~/photos/me.jpg"]);
  assert.equal(p.input, join(homedir(), "Downloads/bbq.mp4"));
  assert.equal(p.opts.match, join(homedir(), "photos/me.jpg"));
});

function ctx(dir: string, input: string | undefined, rest: string[], opts: VerbContext["opts"]): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: defaultProfile(), home: dir, profileName: "default" };
}

test("every --limit verb rejects a non-numeric/non-positive value (no silent default)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-flagval-"));
  try {
    const cases: Array<[string, () => Promise<OvercastRecord[]>]> = [
      ["scan", () => scanVerb.run(ctx(dir, undefined, [], { limit: "abc" }))],
      ["monitor", () => monitorVerb.run(ctx(dir, undefined, [], { once: true, limit: "abc" }))],
      ["ask", () => askVerb.run(ctx(dir, "what?", [], { limit: "abc" }))],
      ["case records", () => caseVerb.run(ctx(dir, "records", [], { limit: "abc" }))],
      ["case search", () => caseVerb.run(ctx(dir, "memory", ["search", "x"], { limit: "abc" }))],
    ];
    for (const [name, run] of cases) {
      const recs = await run();
      // monitor wraps its enumerate error in a per-pass summary, so check all records
      assert.ok(
        recs.some((r) => r.state === "error" && /invalid --limit/i.test(String(r.error ?? ""))),
        `${name}: bad --limit should produce an "invalid --limit" error, not a silent default`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every --since verb rejects an unparseable value (no silent 'no time bound')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-flagval2-"));
  try {
    const cases: Array<[string, () => Promise<OvercastRecord[]>]> = [
      ["scan", () => scanVerb.run(ctx(dir, undefined, [], { since: "garbage" }))],
      ["ask", () => askVerb.run(ctx(dir, "what?", [], { since: "garbage" }))],
      ["case records", () => caseVerb.run(ctx(dir, "records", [], { since: "garbage" }))],
    ];
    for (const [name, run] of cases) {
      const recs = await run();
      assert.ok(
        recs.some((r) => r.state === "error" && /invalid --since/i.test(String(r.error ?? ""))),
        `${name}: bad --since should produce an "invalid --since" error, not a silent no-op`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
