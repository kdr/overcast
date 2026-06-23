import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { loadProfile, defaultProfile } from "../../src/profile.ts";
import { parseProviderSpec, setupVerb, providerVerb, doctorVerb } from "../../src/verbs/setup.ts";
import { runExecProvider, isTinycloudDefault } from "../../src/providers/run.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function ctx(dir: string, home: string, input: string | undefined, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: loadProfile({ home, profile: "default" }), home, profileName: "default" };
}

test("parseProviderSpec handles exec / http / inproc / bare forms", () => {
  assert.deepEqual(parseProviderSpec("exec:./p.sh"), { type: "exec", run: "./p.sh" });
  assert.deepEqual(parseProviderSpec("http://localhost:8090"), { type: "http", endpoint: "http://localhost:8090" });
  assert.deepEqual(parseProviderSpec("inproc:./m.ts"), { type: "inproc", module: "./m.ts" });
  assert.deepEqual(parseProviderSpec("python3 x.py"), { type: "exec", run: "python3 x.py" });
});

test("setup provider persists a binding to the profile; doctor + provider list see it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-setup-"));
  const home = mkdtempSync(join(tmpdir(), "oc-home-"));
  try {
    const [rec] = await setupVerb.run(ctx(dir, home, "provider", ["see", "http://localhost:9000"]));
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).bound, "see");

    // persisted: a fresh load sees the binding
    const p = loadProfile({ home, profile: "default" });
    assert.equal(p.providers?.see.type, "http");
    assert.equal(p.providers?.see.endpoint, "http://localhost:9000");

    // provider list reflects it
    const [lst] = await providerVerb.run(ctx(dir, home, "list"));
    const providers = (lst.payload as Record<string, unknown>).providers as Record<string, unknown>;
    assert.ok("see" in providers);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor reports core checks (pi/ffmpeg/ffprobe runnable) with structured results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-"));
  try {
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean }>;
    const byName = new Map(checks.map((c) => [c.name, c.ok]));
    assert.equal(byName.get("pi"), true);
    assert.equal(byName.get("ffmpeg"), true); // vendored ffmpeg must run
    assert.equal(byName.get("ffprobe"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("isTinycloudDefault distinguishes the default binding from a custom one", () => {
  assert.equal(isTinycloudDefault("tinycloud watch {{input}} --json"), true);
  assert.equal(isTinycloudDefault("python3 listen.py"), false);
  assert.equal(isTinycloudDefault(undefined), false);
});

test("runExecProvider passes a custom provider's record through verbatim", async () => {
  // a provider that emits its own record (with state + custom provider meta).
  // renderCommand splits on whitespace, so use a small script as the provider.
  const dir = mkdtempSync(join(tmpdir(), "oc-run-"));
  try {
    const script = join(dir, "p.sh");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(script, '#!/usr/bin/env bash\necho "{\\"verb\\":\\"see\\",\\"payload\\":{\\"caption\\":\\"hi\\"},\\"meta\\":{\\"provider\\":\\"vlm-x\\"},\\"state\\":\\"ready\\"}"\n');
    chmodSync(script, 0o755);
    const rec = await runExecProvider("see", `bash ${script}`, "img.jpg");
    assert.equal(rec.verb, "see");
    assert.equal(rec.state, "ready");
    assert.equal((rec.payload as Record<string, unknown>).caption, "hi");
    assert.equal(rec.meta?.provider, "vlm-x"); // provider's own meta honored
    assert.equal(rec.media?.ref, "img.jpg");

    // a provider that emits nothing → error record
    const bad = await runExecProvider("see", `bash -c true`, "img.jpg");
    assert.equal(bad.state, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
