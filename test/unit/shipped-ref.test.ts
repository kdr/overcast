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
import { resolveInstalledRefToken, InstalledRefError } from "../../src/providers/installed-ref.ts";

// installed: refs resolve against the TARGET home (Bugbot #110): transparency
// (shippedRefResolution) and doctor (findShippedTokenIssues) must use the passed
// home, not $OVERCAST_HOME, so setup show/plan don't display null and doctor
// doesn't false-flag a valid custom-home binding.
test("shippedRefResolution + findShippedTokenIssues honor the passed home for installed: refs (Bugbot #110)", () => {
  const home = mkdtempSync(join(tmpdir(), "oc-refhome-"));
  const savedHome = process.env.OVERCAST_HOME;
  delete process.env.OVERCAST_HOME;
  try {
    const pkgDir = join(home, "providers", "vlm");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "run.sh"), "echo hi\n");
    const desc = { type: "exec" as const, run: "bash installed:vlm/run.sh --input {{input}}", describe: "bash installed:vlm/run.sh describe" };
    // transparency resolves at the target home, null at the default
    assert.ok(shippedRefResolution(desc, home)?.["installed:vlm/run.sh"], "resolved path at target home");
    assert.equal(shippedRefResolution(desc)?.["installed:vlm/run.sh"], null, "null at the default home");
    // doctor doesn't false-flag a valid binding at the target home
    assert.equal(findShippedTokenIssues("bash installed:vlm/run.sh describe", home).length, 0, "no issue at target home");
    assert.equal(findShippedTokenIssues("bash installed:vlm/run.sh describe").length, 1, "flagged at the default home");
  } finally {
    if (savedHome === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// installed: ref scheme (manifests plan, Stage B) — resolved at the same spawn
// seam as shipped:, but authored by `provider install`, NEVER by healing.
test("installed: refs resolve at spawn, error when the package is gone, and are NEVER healed", () => {
  const home = mkdtempSync(join(tmpdir(), "oc-installed-ref-"));
  const savedHome = process.env.OVERCAST_HOME;
  process.env.OVERCAST_HOME = home;
  try {
    const pkgDir = join(home, "providers", "acme");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "run.sh"), "echo hi\n");

    // resolves through the shared spawn seam
    assert.equal(resolveInstalledRefToken("installed:acme/run.sh"), join(pkgDir, "run.sh"));
    assert.deepEqual(resolveShippedArgv(["bash", "installed:acme/run.sh"]), ["bash", join(pkgDir, "run.sh")]);
    // a missing package throws the installed-specific error at the seam
    assert.throws(() => resolveShippedArgv(["bash", "installed:gone/run.sh"]), InstalledRefError);
    // doctor surfaces the stale binding
    assert.deepEqual(
      findShippedTokenIssues("bash installed:gone/run.sh").map((i) => i.kind),
      ["unresolvable_ref"],
    );
    // healing is shipped-only: an installed: token passes through untouched
    // (healCommandString only rewrites absolute paths), honoring locked decision 4.
    const desc = { type: "exec" as const, run: "bash installed:acme/run.sh --input {{input}}" };
    healDescriptor(desc);
    assert.equal(desc.run, "bash installed:acme/run.sh --input {{input}}");
    assert.equal(healShippedToken("installed:acme/run.sh"), "installed:acme/run.sh");
  } finally {
    if (savedHome === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

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
    ["/opt/old/examples/providers/sources/tiktok.sh", "shipped:providers/sources/tiktok/tiktok.sh"],
    ["/opt/old/examples/providers/visual-db/clip_match.py", "shipped:providers/engines/visual-db/clip_match.py"],
    ["/opt/old/examples/providers/audio-db/audio_match.py", "shipped:providers/engines/audio-db/audio_match.py"],
    ["/opt/old/examples/providers/screenshot/render.mjs", "shipped:providers/engines/screenshot/render.mjs"],
  ];
  for (const [oldPath, ref] of cases) assert.equal(healShippedToken(oldPath), ref, oldPath);
});

test("healShippedToken heals a current-layout path ONLY as a same-file portability upgrade (not a user fork)", () => {
  // A resolved absolute path that IS the shipped file → rewrite to the ref (pure
  // portability; the very same file runs). This is the Stage-A-era resolved-path
  // and same-install case.
  const real = resolveShippedRefToken("shipped:providers/senses/enhance/ela.py");
  assert.ok(real && existsSync(real), "precondition: ela.py resolves in this build");
  assert.equal(healShippedToken(real!), "shipped:providers/senses/enhance/ela.py");

  // A user fork that reuses the providers/<class>/ layout but is a DIFFERENT file
  // (lives elsewhere) must be left untouched — never silently redirected to the
  // packaged script. Regression for the Bugbot "healing rewrites custom paths".
  const forkHome = mkdtempSync(join(tmpdir(), "oc-fork-"));
  try {
    const fork = join(forkHome, "providers", "senses", "fal", "see.sh");
    mkdirSync(join(forkHome, "providers", "senses", "fal"), { recursive: true });
    writeFileSync(fork, "#!/usr/bin/env bash\n# my own fork\n");
    assert.ok(resolveShippedRefToken("shipped:providers/senses/fal/see.sh"), "packaged see.sh exists (would-be target)");
    assert.equal(healShippedToken(fork), fork, "user fork left untouched, not redirected to the shipped script");
  } finally {
    rmSync(forkHome, { recursive: true, force: true });
  }
});

test("healShippedToken leaves demos, intra-examples moves, unknowns, and unresolvable targets untouched", () => {
  const untouched = [
    "/opt/old/examples/providers/bash/watch.sh", // authoring demo — not shipped
    "/opt/old/examples/providers/hf/enhance.py", // moved WITHIN examples
    "/opt/old/examples/providers/sources/mcp-bridge.ts", // moved WITHIN examples
    "/custom/tools/mydetect.py", // user-authored custom path
    "/opt/old/examples/providers/enhance/does-not-exist.py", // maps, but the ref doesn't resolve
    "/gone/providers/senses/fal/does-not-exist.sh", // current-layout path with no shipped target
    "/gone/providers/senses/fal/see.sh", // current-layout, gone, target resolves → ambiguous (moved fork?), left for doctor
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

test("findShippedTokenIssues flags unresolvable refs + stale shipped paths, ignores healthy/PATH tokens", () => {
  assert.deepEqual(findShippedTokenIssues("python3 shipped:providers/senses/enhance/ela.py describe"), []);
  assert.deepEqual(findShippedTokenIssues("bash shipped:providers/senses/nope/missing.sh"), [
    { kind: "unresolvable_ref", token: "shipped:providers/senses/nope/missing.sh" },
  ]);
  // stale = a gone absolute path whose shipped ref DOES resolve here (re-apply fixes it).
  assert.deepEqual(findShippedTokenIssues("bash /gone/providers/senses/fal/see.sh --input {{input}}"), [
    { kind: "stale_path", token: "/gone/providers/senses/fal/see.sh" },
  ]);
  assert.deepEqual(findShippedTokenIssues("python3 /gone/examples/providers/enhance/ela.py describe"), [
    { kind: "stale_path", token: "/gone/examples/providers/enhance/ela.py" },
  ]);
  // A PATH-resolved command (no separator) or a `{{input}}` placeholder is never a
  // file we can judge — left alone even though existsSync is false.
  assert.deepEqual(findShippedTokenIssues("tinycloud watch {{input}} --json"), []);
});

test("findShippedTokenIssues flags a gone absolute script path even when it's NOT a shipped ref (Bugbot #104: moved demo / deleted fork breaks silently)", () => {
  // The demo moved examples/providers/hf/enhance.py -> python/enhance.py, so an old
  // absolute bind to the former neither heals (no shipped ref) nor resolved — it
  // would fail silently at spawn. Doctor now surfaces it as `missing_script`.
  assert.deepEqual(findShippedTokenIssues("python3 /repo/examples/providers/hf/enhance.py {{input}}"), [
    { kind: "missing_script", token: "/repo/examples/providers/hf/enhance.py" },
  ]);
  // A user's own moved/deleted custom provider is the same class — also flagged.
  assert.deepEqual(findShippedTokenIssues("bash /custom/gone/see.sh --input {{input}}"), [
    { kind: "missing_script", token: "/custom/gone/see.sh" },
  ]);
  // A shipped-shaped path whose ref doesn't resolve either is still a broken bind → flagged.
  assert.deepEqual(findShippedTokenIssues("bash /gone/providers/senses/fal/does-not-exist.sh"), [
    { kind: "missing_script", token: "/gone/providers/senses/fal/does-not-exist.sh" },
  ]);
  // Guard against false positives: a RELATIVE path is cwd-dependent, so a gone one
  // says nothing reliable — left alone (only absolute script paths are judged).
  assert.deepEqual(findShippedTokenIssues("python3 examples/providers/hf/enhance.py {{input}}"), []);
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
