// The `shipped:` ref scheme (plan 07 Stage B): token resolution at spawn time,
// the unresolvable-ref error record at the runExecProvider seam, and the
// profile-healing table (old absolute install paths → location-independent refs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isShippedRef,
  resolveShippedRefToken,
  resolveShippedArgv,
  healShippedToken,
  healCommandString,
  healDescriptor,
  findShippedTokenIssues,
  shippedRefResolution,
  ShippedRefError,
} from "../../src/providers/shipped-ref.ts";
import { runExecProvider } from "../../src/providers/run.ts";
import { loadProfile, saveProfile } from "../../src/profile.ts";

test("resolveShippedRefToken resolves shipped provider files to absolute existing paths", () => {
  const abs = resolveShippedRefToken("shipped:providers/senses/enhance/ela.py");
  assert.ok(abs, "ela.py ref resolves in the repo build");
  assert.ok(abs!.startsWith("/"), "resolution is absolute");
  assert.ok(existsSync(abs!), "resolved path exists");
  assert.ok(resolveShippedRefToken("shipped:scripts/visual-db-uv.sh"), "scripts/ refs resolve too");
  // non-refs and empty relpaths resolve to nothing
  assert.equal(resolveShippedRefToken("python3"), undefined);
  assert.equal(resolveShippedRefToken("shipped:"), undefined);
  assert.equal(isShippedRef("shipped:"), false);
});

test("resolveShippedArgv resolves ref tokens in place and throws ShippedRefError on a missing one", () => {
  const argv = resolveShippedArgv(["python3", "shipped:providers/senses/enhance/ela.py", "--input", "x.jpg"]);
  assert.equal(argv[0], "python3");
  assert.ok(argv[1].endsWith("/providers/senses/enhance/ela.py"));
  assert.deepEqual(argv.slice(2), ["--input", "x.jpg"]);
  assert.throws(
    () => resolveShippedArgv(["bash", "shipped:providers/senses/nope/missing.sh"]),
    (e: unknown) => e instanceof ShippedRefError && /lacks the shipped provider files/.test((e as Error).message),
  );
});

test("runExecProvider: an unresolvable shipped: ref yields an error record, not a throw", async () => {
  const rec = await runExecProvider("enhance", "python3 shipped:providers/senses/nope/missing.py", "in.jpg");
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /lacks the shipped provider files/);
  assert.equal(rec.media?.ref, "in.jpg");
});

test("runExecProvider: a resolvable shipped: ref actually spawns the shipped script", async () => {
  // ela.py is stdlib-safe up to input validation — an input-not-found error
  // record proves the ref resolved and the real script ran (offline, no deps).
  const rec = await runExecProvider("enhance", "python3 shipped:providers/senses/enhance/ela.py", "/nope/missing.jpg");
  if (/ENOENT/.test(rec.error ?? "")) return; // python3 absent on this runner → skip
  assert.match(rec.error ?? "", /input not found/);
  assert.equal(rec.state, "error");
});

test("healShippedToken rewrites recognized old absolute paths to shipped: refs (move-mapping table)", () => {
  const cases: Array<[string, string]> = [
    ["/opt/old/examples/providers/enhance/ela.py", "shipped:providers/senses/enhance/ela.py"],
    ["/opt/old/examples/providers/fal/enhance.sh", "shipped:providers/senses/fal/enhance.sh"],
    ["/opt/old/examples/providers/detect/detect.py", "shipped:providers/senses/detect/detect.py"],
    ["/opt/old/examples/providers/geocode/geocode.sh", "shipped:providers/senses/geocode/geocode.sh"],
    ["/opt/old/examples/providers/sources/tiktok.sh", "shipped:providers/sources/tiktok.sh"],
    ["/opt/old/examples/providers/visual-db/clip_match.py", "shipped:providers/engines/visual-db/clip_match.py"],
    ["/opt/old/examples/providers/audio-db/audio_match.py", "shipped:providers/engines/audio-db/audio_match.py"],
    ["/opt/old/examples/providers/screenshot/render.mjs", "shipped:providers/engines/screenshot/render.mjs"],
    // Stage-A-era resolved providers/ paths + the uv setup script
    ["/some/install/providers/senses/local/enhance.sh", "shipped:providers/senses/local/enhance.sh"],
    ["/some/install/providers/sources/web.sh", "shipped:providers/sources/web.sh"],
    ["/some/install/scripts/visual-db-uv.sh", "shipped:scripts/visual-db-uv.sh"],
  ];
  for (const [oldPath, ref] of cases) assert.equal(healShippedToken(oldPath), ref, oldPath);
});

test("healShippedToken leaves demos, intra-examples moves, unknowns, and unresolvable targets untouched", () => {
  const untouched = [
    "/opt/old/examples/providers/bash/watch.sh", // authoring demo — not shipped
    "/opt/old/examples/providers/hf/enhance.py", // moved WITHIN examples
    "/opt/old/examples/providers/sources/mcp-bridge.ts", // moved WITHIN examples
    "/custom/tools/mydetect.py", // user-authored custom path
    "/opt/old/examples/providers/enhance/does-not-exist.py", // maps, but the ref doesn't resolve
    "/gone/providers/senses/fal/does-not-exist.sh", // current-layout path with no shipped target
    "providers/senses/enhance/ela.py", // relative — never healed
    "tinycloud", // bare command
  ];
  for (const tok of untouched) assert.equal(healShippedToken(tok), tok, tok);
});

test("healCommandString heals only matching tokens, preserving the rest of the command", () => {
  assert.equal(
    healCommandString("bash /opt/old/examples/providers/fal/enhance.sh --input {{input}}"),
    "bash shipped:providers/senses/fal/enhance.sh --input {{input}}",
  );
  const custom = "bash /custom/see.sh --input {{input}}";
  assert.equal(healCommandString(custom), custom);
});

test("healDescriptor heals run/describe/init.command in place", () => {
  const desc = healDescriptor({
    type: "exec" as const,
    run: "python3 /opt/old/examples/providers/enhance/ela.py --input {{input}}",
    describe: "python3 /opt/old/examples/providers/enhance/ela.py describe",
    init: { command: "bash /opt/old/scripts/visual-db-uv.sh --face" },
  });
  assert.equal(desc.run, "python3 shipped:providers/senses/enhance/ela.py --input {{input}}");
  assert.equal(desc.describe, "python3 shipped:providers/senses/enhance/ela.py describe");
  assert.equal((desc.init as { command: string }).command, "bash shipped:scripts/visual-db-uv.sh --face");
});

test("loadProfile heals an old-style profile in memory; save persists the refs; custom paths survive", () => {
  const home = mkdtempSync(join(tmpdir(), "oc-heal-"));
  try {
    mkdirSync(join(home, "profiles"), { recursive: true });
    writeFileSync(
      join(home, "profiles", "default.json"),
      JSON.stringify({
        name: "default",
        providers: {
          enhance: {
            type: "exec",
            run: "python3 /opt/old/examples/providers/enhance/ela.py --input {{input}}",
            init: { command: "python3 /opt/old/examples/providers/enhance/ela.py init" },
            describe: "python3 /opt/old/examples/providers/enhance/ela.py describe",
          },
          see: { type: "exec", run: "bash /custom/see.sh --input {{input}}" },
        },
      }),
    );
    const p = loadProfile({ home });
    assert.equal(p.providers?.enhance.run, "python3 shipped:providers/senses/enhance/ela.py --input {{input}}");
    assert.equal(p.providers?.see.run, "bash /custom/see.sh --input {{input}}", "custom binding untouched");
    // persisted naturally on the next save
    saveProfile(p, { home });
    const onDisk = readFileSync(join(home, "profiles", "default.json"), "utf8");
    assert.ok(onDisk.includes("shipped:providers/senses/enhance/ela.py"), "ref persisted");
    assert.ok(!onDisk.includes("/opt/old/examples/providers"), "old absolute path gone");
    assert.ok(onDisk.includes("/custom/see.sh"), "custom path persisted verbatim");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("findShippedTokenIssues flags unresolvable refs + stale shipped paths, ignores healthy/custom tokens", () => {
  assert.deepEqual(findShippedTokenIssues("python3 shipped:providers/senses/enhance/ela.py describe"), []);
  assert.deepEqual(findShippedTokenIssues("bash /custom/gone/see.sh --input {{input}}"), [], "custom paths are not doctor's business");
  assert.deepEqual(findShippedTokenIssues("bash shipped:providers/senses/nope/missing.sh"), [
    { kind: "unresolvable_ref", token: "shipped:providers/senses/nope/missing.sh" },
  ]);
  assert.deepEqual(findShippedTokenIssues("bash /gone/providers/senses/fal/does-not-exist.sh --input {{input}}"), [
    { kind: "stale_path", token: "/gone/providers/senses/fal/does-not-exist.sh" },
  ]);
  assert.deepEqual(findShippedTokenIssues("python3 /gone/examples/providers/enhance/does-not-exist.py"), [
    { kind: "stale_path", token: "/gone/examples/providers/enhance/does-not-exist.py" },
  ]);
});

test("shippedRefResolution maps each descriptor ref to its resolved path (null when missing)", () => {
  const res = shippedRefResolution({
    type: "exec",
    run: "python3 shipped:providers/senses/enhance/ela.py",
    describe: "python3 shipped:providers/senses/enhance/ela.py describe",
    init: { command: "bash shipped:providers/senses/nope/missing.sh init" },
  });
  assert.ok(res, "refs found");
  assert.ok(res!["shipped:providers/senses/enhance/ela.py"]?.endsWith("/providers/senses/enhance/ela.py"));
  assert.equal(res!["shipped:providers/senses/nope/missing.sh"], null);
  assert.equal(shippedRefResolution({ type: "exec", run: "tinycloud watch {{input}} --json" }), undefined);
});
