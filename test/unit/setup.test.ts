import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openCase } from "../../src/case.ts";
import { loadProfile, defaultProfile } from "../../src/profile.ts";
import { parseProviderSpec, setupVerb, providerVerb, doctorVerb } from "../../src/verbs/setup.ts";
import { installProvider } from "../../src/verbs/provider-install.ts";
import { invalidateManifestCache } from "../../src/providers/manifests.ts";
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

test("provider describe redacts a secret echoed by the describe command (Bugbot #68 follow-up)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-setup-"));
  const home = mkdtempSync(join(tmpdir(), "oc-home-"));
  try {
    const SECRET = "apify_api_0123456789abcdefghij"; // matches SECRET_VALUE_RE in src/env.ts
    // bind `see` to a provider whose `describe` echoes a credential to stdout
    await setupVerb.run(ctx(dir, home, "provider", ["see", `exec:sh -c 'echo connecting ${SECRET}'`]));
    const [rec] = await providerVerb.run(ctx(dir, home, "describe", ["see"]));
    const describe = String((rec.payload as Record<string, unknown>).describe);
    assert.match(describe, /\[REDACTED\]/, "the echoed secret must be redacted in the persisted describe field");
    assert.doesNotMatch(describe, new RegExp(SECRET), "raw secret must not land on disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
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
    assert.equal(setup.meta?.transient, true);
    assert.ok((setup.payload as Record<string, unknown>).profile);

    const [provider] = await providerVerb.run(ctx(dir, home, undefined));
    const payload = provider.payload as Record<string, unknown>;
    assert.equal(provider.state, "ready");
    assert.equal(provider.meta?.transient, true);
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
    const x = checks.find((c) => c.name === "source:x");
    assert.equal(x?.ok, false);
    assert.match(x?.detail ?? "", /APIFY_TOKEN missing/);
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

test("provider setup can bind face to deepface-local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-provider-deepface-"));
  const home = mkdtempSync(join(tmpdir(), "oc-provider-deepface-home-"));
  try {
    const [apply] = await providerVerb.run(ctx(dir, home, "setup", ["apply"], { verb: "face", choice: "deepface-local", profile: "local", yes: true }));
    assert.equal(apply.state, "ready");
    const p = loadProfile({ home, profile: "local" });
    assert.equal(p.providers?.face.type, "inproc");
    assert.equal(p.providers?.face.backend, "deepface-local");
    assert.equal(p.providers?.face.id, "deepface-local");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider describe returns deepface-local descriptor metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-provider-deepface-desc-"));
  const home = mkdtempSync(join(tmpdir(), "oc-provider-deepface-desc-home-"));
  try {
    const [apply] = await providerVerb.run(ctx(dir, home, "setup", ["apply"], { verb: "face", choice: "deepface-local", profile: "local", yes: true }));
    assert.equal(apply.state, "ready");

    const [desc] = await providerVerb.run(ctx(dir, home, "describe", ["face"], { profile: "local" }));
    assert.equal(desc.state, "ready");
    const payload = desc.payload as Record<string, unknown>;
    const descriptor = payload.descriptor as Record<string, unknown>;
    assert.equal(descriptor.type, "inproc");
    assert.equal(descriptor.backend, "deepface-local");
    assert.equal(descriptor.id, "deepface-local");
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

test("provider setup show lists an installed choice at the target home (Bugbot #110)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-show-"));
  const home = mkdtempSync(join(tmpdir(), "oc-showhome-"));
  const savedHome = process.env.OVERCAST_HOME;
  delete process.env.OVERCAST_HOME; // prove ctx.home is used, not $OVERCAST_HOME
  try {
    const src = join(dir, "vlm");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "provider.json"), JSON.stringify({
      manifest_version: 1, name: "vlm", version: "1.0.0",
      entries: [{ kind: "sense", id: "vlm", verb: "see", label: "a", summary: "b",
        descriptor: { type: "exec", run: "bash installed:vlm/run.sh --input {{input}}" } }],
    }));
    writeFileSync(join(src, "run.sh"), "echo '{}'\n");
    assert.equal(installProvider(src, { yes: true }, home)[0].state, "ready");
    invalidateManifestCache();
    const [rec] = await providerVerb.run(ctx(dir, home, "setup", ["show"]));
    const choices = (rec.payload as Record<string, unknown>).choices as Array<{ id: string; verb: string }>;
    assert.ok(choices.some((c) => c.id === "vlm" && c.verb === "see"), "installed choice shown for the target home");
  } finally {
    if (savedHome === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor flags a tampered installed provider package (Bugbot #110)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-tamper-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-tamper-"));
  const savedHome = process.env.OVERCAST_HOME;
  process.env.OVERCAST_HOME = home; // listInstalled() resolves the installed root via env
  try {
    const src = join(dir, "acme");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "provider.json"), JSON.stringify({
      manifest_version: 1, name: "acme", version: "1.0.0",
      entries: [{ kind: "source", type: "acme", label: "a", summary: "b",
        base: ["bash", "installed:acme/run.sh"], doctor: { check: "keyless", okNote: "ok" } }],
    }));
    writeFileSync(join(src, "run.sh"), "echo '[]'\n");
    assert.equal(installProvider(src, { yes: true })[0].state, "ready");
    invalidateManifestCache();

    // clean install → doctor check present and ok
    let [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    let checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    let ip = checks.find((c) => c.name === "installed-providers");
    assert.ok(ip && ip.ok, "clean installed package → installed-providers ok");

    // tamper a file → doctor must flag it
    appendFileSync(join(home, "providers", "acme", "run.sh"), "\n# tampered\n");
    invalidateManifestCache();
    [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    ip = checks.find((c) => c.name === "installed-providers");
    assert.ok(ip && !ip.ok, "tampered package → installed-providers not ok");
    assert.match(ip!.detail, /acme/);

    // corrupt the manifest to valid-JSON-but-schema-invalid → the scan drops it;
    // doctor must still surface it as an invalid installed package (not silent).
    const mp = join(home, "providers", "acme", "provider.json");
    const bad = JSON.parse(readFileSync(mp, "utf8"));
    delete bad.version;
    writeFileSync(mp, JSON.stringify(bad));
    invalidateManifestCache();
    [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    ip = checks.find((c) => c.name === "installed-providers");
    assert.ok(ip && !ip.ok, "invalid installed manifest → installed-providers not ok");
    assert.match(ip!.detail, /acme \(invalid manifest\)/);
  } finally {
    if (savedHome === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedHome;
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

test("doctor flags provider bindings with unresolvable shipped: refs or stale absolute paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-refs-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-refs-"));
  try {
    // an unresolvable ref survives healing (it never resolves) — doctor's case
    await setupVerb.run(ctx(dir, home, "provider", ["enhance", "exec:python3 shipped:providers/senses/nope/missing.py"]));
    // a stale absolute shipped path: gone on disk, but its shipped ref DOES
    // resolve here (a real shipped filename) — re-apply fixes it, so doctor flags it
    await setupVerb.run(ctx(dir, home, "provider", ["see", "exec:bash /gone/providers/senses/fal/see.sh"]));
    // a gone absolute CUSTOM/demo script (no shipped ref): now flagged as
    // `missing script` — it can't heal but WILL fail at spawn (Bugbot #104).
    await setupVerb.run(ctx(dir, home, "provider", ["listen", "exec:bash /custom/gone/listen.sh"]));
    // a healthy shipped ref and a healthy EXISTING custom path must NOT be flagged
    await setupVerb.run(ctx(dir, home, "provider", ["exif", "exec:bash shipped:providers/senses/exif/exif.sh"]));
    const okScript = join(dir, "my-voice.sh");
    writeFileSync(okScript, "#!/usr/bin/env bash\n");
    await setupVerb.run(ctx(dir, home, "provider", ["voice", `exec:bash ${okScript}`]));
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const paths = checks.find((c) => c.name === "provider-paths");
    assert.equal(paths?.ok, false);
    assert.match(paths?.detail ?? "", /unresolvable shipped:providers\/senses\/nope\/missing\.py/);
    assert.match(paths?.detail ?? "", /stale path \/gone\/providers\/senses\/fal\/see\.sh/);
    assert.match(paths?.detail ?? "", /missing script \/custom\/gone\/listen\.sh/);
    assert.match(paths?.detail ?? "", /provider setup apply --verb <verb> --choice <id> --yes/);
    assert.doesNotMatch(paths?.detail ?? "", /exif\.sh/, "healthy shipped ref is not flagged");
    assert.doesNotMatch(paths?.detail ?? "", /my-voice\.sh/, "an existing custom path is not flagged");
    const warnings = (rec.payload as Record<string, unknown>).warnings as string[];
    assert.ok(warnings.some((w) => /missing shipped provider files/.test(w)), `expected shipped-path warning; got ${JSON.stringify(warnings)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_EXIFTOOL = join(HERE, "..", "fixtures", "fake-exiftool.sh");
const FAKE_C2PATOOL = join(HERE, "..", "fixtures", "fake-c2patool.sh");

test("doctor honors OVERCAST_EXIFTOOL_CMD / OVERCAST_C2PATOOL_CMD overrides (present binaries)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-fx-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-fx-"));
  const prevX = process.env.OVERCAST_EXIFTOOL_CMD;
  const prevC = process.env.OVERCAST_C2PATOOL_CMD;
  process.env.OVERCAST_EXIFTOOL_CMD = `bash ${FAKE_EXIFTOOL}`;
  process.env.OVERCAST_C2PATOOL_CMD = `bash ${FAKE_C2PATOOL}`;
  try {
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean }>;
    const byName = new Map(checks.map((c) => [c.name, c.ok]));
    assert.equal(byName.get("exiftool"), true);
    assert.equal(byName.get("c2patool"), true);
  } finally {
    if (prevX === undefined) delete process.env.OVERCAST_EXIFTOOL_CMD;
    else process.env.OVERCAST_EXIFTOOL_CMD = prevX;
    if (prevC === undefined) delete process.env.OVERCAST_C2PATOOL_CMD;
    else process.env.OVERCAST_C2PATOOL_CMD = prevC;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor flags a missing exiftool/c2patool (override → nonexistent) with an install hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-fx2-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-fx2-"));
  const prevX = process.env.OVERCAST_EXIFTOOL_CMD;
  const prevC = process.env.OVERCAST_C2PATOOL_CMD;
  process.env.OVERCAST_EXIFTOOL_CMD = "oc-no-such-exiftool-binary";
  process.env.OVERCAST_C2PATOOL_CMD = "oc-no-such-c2patool-binary";
  try {
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const exif = checks.find((c) => c.name === "exiftool");
    const c2pa = checks.find((c) => c.name === "c2patool");
    assert.equal(exif?.ok, false);
    assert.match(exif?.detail ?? "", /brew install exiftool/);
    assert.equal(c2pa?.ok, false);
    assert.match(c2pa?.detail ?? "", /c2patool/);
  } finally {
    if (prevX === undefined) delete process.env.OVERCAST_EXIFTOOL_CMD;
    else process.env.OVERCAST_EXIFTOOL_CMD = prevX;
    if (prevC === undefined) delete process.env.OVERCAST_C2PATOOL_CMD;
    else process.env.OVERCAST_C2PATOOL_CMD = prevC;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

const FAKE_YTDLP = join(HERE, "..", "fixtures", "fake-ytdlp.sh");

test("doctor honors OVERCAST_YTDLP_CMD and reports curl_cffi impersonation as OK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-yt-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-yt-"));
  const prev = process.env.OVERCAST_YTDLP_CMD;
  process.env.OVERCAST_YTDLP_CMD = `bash ${FAKE_YTDLP}`;
  try {
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const yt = checks.find((c) => c.name === "yt-dlp");
    assert.equal(yt?.ok, true);
    assert.match(yt?.detail ?? "", /curl_cffi impersonation OK/);
    assert.doesNotMatch(yt?.detail ?? "", /released ~\d+ days ago/, "a current version must not trip the staleness nudge");
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_YTDLP_CMD;
    else process.env.OVERCAST_YTDLP_CMD = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor flags an impersonation-less + stale yt-dlp build (the brew/apt shape)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-yt2-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-yt2-"));
  const prev = process.env.OVERCAST_YTDLP_CMD;
  const prevImp = process.env.FAKE_YTDLP_IMPERSONATION;
  const prevVer = process.env.FAKE_YTDLP_VERSION;
  process.env.OVERCAST_YTDLP_CMD = `bash ${FAKE_YTDLP}`;
  process.env.FAKE_YTDLP_IMPERSONATION = "0";
  process.env.FAKE_YTDLP_VERSION = "2020.01.01"; // always > 90 days old
  try {
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const yt = checks.find((c) => c.name === "yt-dlp");
    assert.equal(yt?.ok, true, "present-but-degraded stays ok (most hosts still work)");
    assert.match(yt?.detail ?? "", /NO curl_cffi impersonation/);
    assert.match(yt?.detail ?? "", /yt-dlp\[default,curl-cffi\]/);
    assert.match(yt?.detail ?? "", /released ~\d+ days ago/);
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_YTDLP_CMD;
    else process.env.OVERCAST_YTDLP_CMD = prev;
    if (prevImp === undefined) delete process.env.FAKE_YTDLP_IMPERSONATION;
    else process.env.FAKE_YTDLP_IMPERSONATION = prevImp;
    if (prevVer === undefined) delete process.env.FAKE_YTDLP_VERSION;
    else process.env.FAKE_YTDLP_VERSION = prevVer;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor flags a missing yt-dlp (override → nonexistent) with the impersonation-capable install hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-yt3-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-yt3-"));
  const prev = process.env.OVERCAST_YTDLP_CMD;
  process.env.OVERCAST_YTDLP_CMD = "oc-no-such-ytdlp-binary";
  try {
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const yt = checks.find((c) => c.name === "yt-dlp");
    assert.equal(yt?.ok, false);
    assert.match(yt?.detail ?? "", /yt-dlp\[default,curl-cffi\]/);
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_YTDLP_CMD;
    else process.env.OVERCAST_YTDLP_CMD = prev;
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

// ---- field papercut: provider describe/init accept --verb --------------------

test("provider describe/init accept --verb <verb> as well as the positional", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-descverb-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dvhome-"));
  try {
    await setupVerb.run(ctx(dir, home, "provider", ["see", "exec:sh -c 'echo see-desc'"]));
    const [flagged] = await providerVerb.run(ctx(dir, home, "describe", [], { verb: "see" }));
    assert.equal(flagged.state, "ready");
    assert.equal((flagged.payload as Record<string, unknown>).verb, "see");
    // the positional keeps priority when both are given
    const [both] = await providerVerb.run(ctx(dir, home, "describe", ["see"], { verb: "listen" }));
    assert.equal((both.payload as Record<string, unknown>).verb, "see");
    // neither → the usage error now names both forms
    const [neither] = await providerVerb.run(ctx(dir, home, "describe", []));
    assert.equal(neither.state, "error");
    assert.match(neither.error ?? "", /--verb <verb>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- field report §2.10: yt-dlp needs a JS runtime ---------------------------

test("doctor's yt-dlp check reports the JS runtime (yt-dlp needs one for some YouTube formats)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-doc-ytjs-"));
  const home = mkdtempSync(join(tmpdir(), "oc-dhome-ytjs-"));
  const prev = process.env.OVERCAST_YTDLP_CMD;
  process.env.OVERCAST_YTDLP_CMD = `bash ${FAKE_YTDLP}`;
  try {
    const [rec] = await doctorVerb.run(ctx(dir, home, undefined));
    const checks = (rec.payload as Record<string, unknown>).checks as Array<{ name: string; ok: boolean; detail: string }>;
    const yt = checks.find((c) => c.name === "yt-dlp");
    // the test process runs under node, so SOME runtime is always on PATH here —
    // the assertion is that the check reports one either way (OK or the miss hint)
    assert.match(yt?.detail ?? "", /JS runtime OK \((deno|node|bun)\)|NO JavaScript runtime/);
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_YTDLP_CMD;
    else process.env.OVERCAST_YTDLP_CMD = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
