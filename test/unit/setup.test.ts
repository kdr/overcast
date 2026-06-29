import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCase } from "../../src/case.ts";
import { loadProfile, defaultProfile } from "../../src/profile.ts";
import { parseProviderSpec, setupVerb, providerVerb, doctorVerb } from "../../src/verbs/setup.ts";
import { addSource } from "../../src/state/source.ts";
import { renderForFormat } from "../../src/render.ts";
import { makeRecord } from "../../src/record.ts";
import { runExecProvider, isTinycloudDefault } from "../../src/providers/run.ts";
import { renderCommand } from "../../src/providers/exec.ts";
import type { VerbContext } from "../../src/registry/types.ts";

function ctx(dir: string, home: string, input: string | undefined, rest: string[] = [], opts: VerbContext["opts"] = {}): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest, opts, case: c, profile: loadProfile({ home, profile: "default" }), home, profileName: "default" };
}

test("parseProviderSpec handles exec / http / inproc / bare forms", () => {
  // the run op is invoked with an explicit --input (documented contract) so a
  // media path is never argv[1]; init/describe attach to the bare base command.
  assert.deepEqual(parseProviderSpec("exec:./p.sh"), {
    type: "exec",
    run: "./p.sh --input {{input}}",
    init: { command: "./p.sh init" },
    describe: "./p.sh describe",
  });
  assert.deepEqual(parseProviderSpec("http://localhost:8090"), { type: "http", endpoint: "http://localhost:8090" });
  assert.deepEqual(parseProviderSpec("inproc:./m.ts"), { type: "inproc", module: "./m.ts" });
  assert.deepEqual(parseProviderSpec("python3 x.py"), {
    type: "exec",
    run: "python3 x.py --input {{input}}",
    init: { command: "python3 x.py init" },
    describe: "python3 x.py describe",
  });
  // a binding that already places {{input}} is normalized to the same --input form
  assert.deepEqual(parseProviderSpec("exec:bash w.sh {{input}}"), {
    type: "exec",
    run: "bash w.sh --input {{input}}",
    init: { command: "bash w.sh init" },
    describe: "bash w.sh describe",
  });
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
    const payload = lst.payload as Record<string, unknown>;
    const providers = payload.providers as Record<string, unknown>;
    const effective = payload.effective as Record<string, Record<string, unknown>>;
    assert.ok("see" in providers);
    assert.equal(effective.see.source, "profile");
    assert.equal(effective.watch.source, "profile");
    assert.equal(effective.face.choice, "tinycloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("bare setup and provider default to useful show/list output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-setup-defaults-"));
  const home = mkdtempSync(join(tmpdir(), "oc-home-defaults-"));
  try {
    const [setup] = await setupVerb.run(ctx(dir, home, undefined));
    assert.equal(setup.state, "ready");
    assert.ok((setup.payload as Record<string, unknown>).profile);

    const [provider] = await providerVerb.run(ctx(dir, home, undefined));
    const payload = provider.payload as Record<string, unknown>;
    assert.equal(provider.state, "ready");
    assert.equal(payload.profile, "default");
    assert.ok(payload.effective);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor --sources reports missing tiktok credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-src-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-src-"));
  const prev = process.env.APIFY_TOKEN;
  try {
    delete process.env.APIFY_TOKEN;
    addSource(openCase(dir), "tiktok:@willsmith");
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined, [], { sources: true }));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const tiktok = checks.find((c) => c.name === "source:tiktok");
    assert.equal(tiktok?.ok, false);
    assert.match(tiktok?.detail ?? "", /APIFY_TOKEN missing/);
  } finally {
    if (prev === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("rendering redacts secret-looking values", () => {
  const rec = makeRecord({ verb: "doctor", payload: { APIFY_TOKEN: "apify_api_abcdefghijklmnopqrstuvwxyz123456", text: "token=sk-abcdefghijklmnopqrstuvwxyz" } });
  const rendered = renderForFormat(rec, "json");
  assert.doesNotMatch(rendered, /apify_api_/);
  assert.doesNotMatch(rendered, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(rendered, /\[REDACTED\]/);
});

test("provider setup plan is non-mutating and apply writes catalog choices to a profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-provider-setup-"));
  const home = mkdtempSync(join(tmpdir(), "oc-provider-home-"));
  try {
    const [plan] = await providerVerb.run(ctx(dir, home, "setup", ["plan"], { verb: "listen", choice: "elevenlabs", profile: "recon" }));
    assert.equal(plan.state, "pending");
    assert.equal((plan.payload as Record<string, unknown>).saved, false);
    assert.equal(loadProfile({ home, profile: "recon" }).providers?.listen, undefined);

    const [apply] = await providerVerb.run(ctx(dir, home, "setup", ["apply"], { verb: "listen", choice: "elevenlabs", profile: "recon", yes: true }));
    assert.equal(apply.state, "ready");
    const p = loadProfile({ home, profile: "recon" });
    assert.equal(p.providers?.listen.type, "exec");
    assert.match(p.providers?.listen.run ?? "", /elevenlabs\/listen\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider setup preset can clear built-in bindings such as ffmpeg enhance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-provider-preset-"));
  const home = mkdtempSync(join(tmpdir(), "oc-provider-preset-home-"));
  try {
    const [apply] = await providerVerb.run(ctx(dir, home, "setup", ["apply"], { preset: "cloudglue", profile: "cloud", yes: true }));
    assert.equal(apply.state, "ready");
    const p = loadProfile({ home, profile: "cloud" });
    assert.equal(p.providers?.watch.type, "exec");
    assert.equal(p.providers?.listen.type, "exec");
    assert.equal(p.providers?.face.type, "exec");
    assert.equal(p.providers?.enhance, undefined);
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
    assert.equal(byName.get("ffmpeg"), true); // system ffmpeg must run
    assert.equal(byName.get("ffprobe"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor warns when configured qmd is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-qmd-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-qmd-"));
  try {
    const [setup] = await setupVerb.run(ctx(dir, home, "memory", ["qmd", "oc-no-such-qmd-binary"]));
    assert.equal(setup.state, "ready");
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const qmd = checks.find((c) => c.name === "qmd");
    assert.equal(qmd?.ok, false);
    assert.match(qmd?.detail ?? "", /npm install -g @tobilu\/qmd/);
    const warnings = (rec.payload as Record<string, unknown>).warnings as string[];
    assert.ok(warnings.some((w) => /qmd memory is configured/.test(w)), `expected qmd warning; got ${JSON.stringify(warnings)}`);
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

test("runExecProvider: state:ready + non-zero exit does NOT attach a phantom error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-run2-"));
  try {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const script = join(dir, "noisy.sh");
    // emits a ready record but exits 3 (e.g. a wrapper with a bad cleanup code)
    writeFileSync(script, '#!/usr/bin/env bash\necho "{\\"verb\\":\\"see\\",\\"payload\\":{\\"caption\\":\\"ok\\"},\\"state\\":\\"ready\\"}"\nexit 3\n');
    chmodSync(script, 0o755);
    const rec = await runExecProvider("see", `bash ${script}`, "x.jpg");
    assert.equal(rec.state, "ready");
    assert.equal(rec.error, undefined); // no phantom 'exit 3' on a ready record
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runExecProvider: a media object without a string ref falls back to the input ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-run3-"));
  try {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const script = join(dir, "noref.sh");
    writeFileSync(script, '#!/usr/bin/env bash\necho "{\\"verb\\":\\"see\\",\\"payload\\":{},\\"media\\":{\\"at\\":5},\\"state\\":\\"ready\\"}"\n');
    chmodSync(script, 0o755);
    const rec = await runExecProvider("see", `bash ${script}`, "img.jpg");
    assert.equal(rec.media?.ref, "img.jpg"); // ref-less media replaced by input
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty bound run coalesces to the default command (never an empty spawn)", () => {
  // renderCommand of "" would yield [] → spawn("") throws; the dispatch uses
  // `run || DEFAULT` so an empty/exec: binding falls back to the tinycloud default.
  const empty = "";
  const argv = renderCommand((empty || "tinycloud watch {{input}} --json"), { input: "x.mp4" });
  assert.deepEqual(argv, ["tinycloud", "watch", "x.mp4", "--json"]);
  // parseProviderSpec("exec:") is the source of an empty run
  assert.equal(parseProviderSpec("exec:").run, "");
});

test("exec providers inherit the full process environment (env vars + config files)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-env-"));
  try {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const script = join(dir, "env.sh");
    writeFileSync(script, '#!/usr/bin/env bash\necho "{\\"verb\\":\\"see\\",\\"payload\\":{\\"k\\":\\"${OVERCAST_TEST_ENV:-MISSING}\\"},\\"state\\":\\"ready\\"}"\n');
    chmodSync(script, 0o755);
    process.env.OVERCAST_TEST_ENV = "from-env";
    try {
      const rec = await runExecProvider("see", `bash ${script}`, "x.jpg");
      assert.equal((rec.payload as Record<string, unknown>).k, "from-env");
    } finally {
      delete process.env.OVERCAST_TEST_ENV;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
