import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The install feature reads $OVERCAST_HOME via resolveHome({}); set it BEFORE the
// modules resolve any home. Each test invalidates the manifest cache after
// mutating the installed tree.
let HOME: string;
function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), "oc-install-home-"));
  process.env.OVERCAST_HOME = h;
  return h;
}

const {
  installProvider,
  removeProvider,
  listInstalled,
  createProviderScaffold,
  hashProviderTree,
} = await import("../../src/verbs/provider-install.ts");
const { invalidateManifestCache, manifestSourceDescriptor, scanManifests } = await import("../../src/providers/manifests.ts");
const { providerChoices, findProviderChoice } = await import("../../src/providers/catalog.ts");
const { resolveInstalledRefToken } = await import("../../src/providers/installed-ref.ts");
const { builtinDescriptor } = await import("../../src/providers/sources/index.ts");

/** Write a minimal valid source package to <dir>/<name>/ and return its path. */
function writeSourcePkg(dir: string, name: string, type = name): string {
  const pkg = join(dir, name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "provider.json"), JSON.stringify({
    manifest_version: 1, name, version: "1.0.0",
    entries: [{
      kind: "source", type,
      label: `${name} src`, summary: "test source",
      base: ["bash", `installed:${name}/run.sh`],
      needs: "none", hosts: [`${type}.example`],
      doctor: { check: "keyless", okNote: `${type} ready` },
    }],
  }, null, 2));
  writeFileSync(join(pkg, "run.sh"), "#!/usr/bin/env bash\necho '[]'\n");
  return pkg;
}

function rec(records: ReturnType<typeof installProvider>) {
  return records[0];
}

test("install: pending plan without --yes, then installs with --yes and is discovered", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  const pkg = writeSourcePkg(work, "acme");

  const pending = rec(installProvider(pkg, {}));
  assert.equal(pending.state, "pending");
  assert.equal(pending.payload.confirmation_required, true);
  assert.equal(existsSync(join(HOME, "providers", "acme")), false, "nothing written before --yes");

  const done = rec(installProvider(pkg, { yes: true }));
  assert.equal(done.state, "ready");
  assert.ok(existsSync(join(HOME, "providers", "acme", "provider.json")));
  assert.ok(existsSync(join(HOME, "providers", "acme", ".overcast-install.json")), "provenance stamped");

  invalidateManifestCache();
  const desc = manifestSourceDescriptor("acme");
  assert.ok(desc, "installed source type resolves via the registry");
  assert.ok(desc!.base[desc!.base.length - 1].endsWith("acme/run.sh"), "base resolved to the installed script");

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("install: sense package binds an installed: ref that resolves", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  const pkg = join(work, "vlm");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "provider.json"), JSON.stringify({
    manifest_version: 1, name: "vlm", version: "1.0.0",
    entries: [{
      kind: "sense", id: "vlm", verb: "see", label: "vlm", summary: "test vlm",
      descriptor: { type: "exec", run: "bash installed:vlm/run.sh --input {{input}}", init: "bash installed:vlm/run.sh init", describe: "bash installed:vlm/run.sh describe" },
    }],
  }, null, 2));
  writeFileSync(join(pkg, "run.sh"), "#!/usr/bin/env bash\necho '{}'\n");

  assert.equal(rec(installProvider(pkg, { yes: true })).state, "ready");
  invalidateManifestCache();
  const choice = providerChoices().find((c) => c.id === "vlm" && c.verb === "see");
  assert.ok(choice, "installed sense choice appears in the catalog");
  assert.match(choice!.descriptor!.run!, /installed:vlm\/run\.sh --input \{\{input\}\}/);
  assert.ok(resolveInstalledRefToken("installed:vlm/run.sh"), "installed: ref resolves to the on-disk script");

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("install: rejects collision with a shipped source type + reserved names", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  invalidateManifestCache();

  const collide = writeSourcePkg(work, "evil", "tiktok"); // shipped type
  const r1 = rec(installProvider(collide, { yes: true }));
  assert.equal(r1.state, "error");
  assert.match(r1.error ?? "", /source type 'tiktok' already provided/);

  const reserved = writeSourcePkg(work, "senses", "senses");
  const r2 = rec(installProvider(reserved, { yes: true }));
  assert.equal(r2.state, "error");
  assert.match(r2.error ?? "", /reserved/);

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("upgrade: same-name install needs --upgrade; --upgrade replaces + re-stamps", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  const pkg = writeSourcePkg(work, "acme");
  assert.equal(rec(installProvider(pkg, { yes: true })).state, "ready");
  invalidateManifestCache();

  const again = rec(installProvider(pkg, { yes: true }));
  assert.equal(again.state, "error");
  assert.match(again.error ?? "", /already installed/);

  const up = rec(installProvider(pkg, { yes: true, upgrade: true }));
  assert.equal(up.state, "ready");
  assert.equal(up.payload.upgraded, true);

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("tamper: editing an installed file flips listInstalled().tampered", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  const pkg = writeSourcePkg(work, "acme");
  installProvider(pkg, { yes: true });
  invalidateManifestCache();
  assert.equal(listInstalled().find((p) => p.name === "acme")?.tampered, false);

  appendFileSync(join(HOME, "providers", "acme", "run.sh"), "\n# edited\n");
  assert.equal(listInstalled().find((p) => p.name === "acme")?.tampered, true, "sha mismatch after edit");

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("remove: pending without --yes, removes with --yes, cache refreshes", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  const pkg = writeSourcePkg(work, "acme");
  installProvider(pkg, { yes: true });
  invalidateManifestCache();
  assert.ok(manifestSourceDescriptor("acme"));

  assert.equal(rec(removeProvider("acme", {})).state, "pending");
  assert.ok(existsSync(join(HOME, "providers", "acme")), "not removed without --yes");

  assert.equal(rec(removeProvider("acme", { yes: true })).state, "ready");
  assert.equal(existsSync(join(HOME, "providers", "acme")), false);
  assert.equal(manifestSourceDescriptor("acme"), undefined, "registry no longer resolves it");

  assert.equal(rec(removeProvider("nope", { yes: true })).state, "error");

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("create: scaffolds a package that validates + installs cleanly", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-create-"));
  const created = rec(createProviderScaffold("myfeed", "source", work));
  assert.equal(created.state, "ready");
  const dir = created.payload.dir as string;
  assert.ok(existsSync(join(dir, "provider.json")) && existsSync(join(dir, "myfeed.sh")));

  invalidateManifestCache();
  const installed = rec(installProvider(dir, { yes: true }));
  assert.equal(installed.state, "ready", `scaffold should install: ${installed.error}`);

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("install/remove honor an explicit home, not the process default (Bugbot #110)", () => {
  const savedEnv = process.env.OVERCAST_HOME;
  delete process.env.OVERCAST_HOME; // prove it uses the arg, not $OVERCAST_HOME
  const homeA = mkdtempSync(join(tmpdir(), "oc-homeA-"));
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  try {
    const pkg = writeSourcePkg(work, "acme");
    assert.equal(rec(installProvider(pkg, { yes: true }, homeA)).state, "ready");
    assert.ok(existsSync(join(homeA, "providers", "acme", "provider.json")), "installed under the passed home");
    // remove also targets the passed home
    assert.equal(rec(removeProvider("acme", { yes: true }, homeA)).state, "ready");
    assert.equal(existsSync(join(homeA, "providers", "acme")), false);
  } finally {
    if (savedEnv === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedEnv;
    rmSync(homeA, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("collision check is scoped to the target home — no false collision across homes (Bugbot #110)", () => {
  const savedEnv = process.env.OVERCAST_HOME;
  const defHome = mkdtempSync(join(tmpdir(), "oc-defhome-"));
  const custHome = mkdtempSync(join(tmpdir(), "oc-custhome-"));
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  try {
    process.env.OVERCAST_HOME = defHome;
    installProvider(writeSourcePkg(work, "pkga", "foo"), { yes: true }); // → default home
    invalidateManifestCache();
    // a DIFFERENT-named package with the same type, into a CUSTOM home, must NOT
    // be false-flagged by the conflict in the default home.
    const r = rec(installProvider(writeSourcePkg(work, "pkgb", "foo"), { yes: true }, custHome));
    assert.equal(r.state, "ready", `cross-home install should not collide: ${r.error}`);
    // but the same type INTO the default home (where it exists) still collides.
    invalidateManifestCache();
    const r2 = rec(installProvider(writeSourcePkg(work, "pkgc", "foo"), { yes: true }));
    assert.equal(r2.state, "error");
    assert.match(r2.error ?? "", /source type 'foo' already provided/);
  } finally {
    if (savedEnv === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedEnv;
    rmSync(defHome, { recursive: true, force: true });
    rmSync(custHome, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("collision check reserves types of an invalid installed package the scan dropped (Bugbot #110)", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  installProvider(writeSourcePkg(work, "acme", "acme"), { yes: true }, HOME);
  // corrupt to valid JSON but schema-invalid (drop required version) → the scan
  // drops it, but its type is still recoverable from disk for the collision check.
  const mp = join(HOME, "providers", "acme", "provider.json");
  const bad = JSON.parse(readFileSync(mp, "utf8"));
  delete bad.version;
  writeFileSync(mp, JSON.stringify(bad));
  invalidateManifestCache();
  const r = rec(installProvider(writeSourcePkg(work, "other", "acme"), { yes: true }, HOME));
  assert.equal(r.state, "error");
  assert.match(r.error ?? "", /source type 'acme' already provided/);
  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("install: refuses a tarball whose members escape via .. / absolute path (Bugbot #110)", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-tar-"));
  // build a tarball with a `../escape.txt` member (escapes the extraction dir):
  // stage sub/provider.json + escape.txt one level up, tar from sub with `../`.
  mkdirSync(join(work, "sub"), { recursive: true });
  writeFileSync(join(work, "escape.txt"), "evil");
  writeFileSync(join(work, "sub", "provider.json"), "{}");
  const tgz = join(work, "evil.tgz");
  // -P preserves the `../` member (GNU tar strips leading `../` on create by
  // default; BSD tar keeps it). Then VERIFY the crafted member actually survived —
  // if this env's tar sanitized it away, we can't exercise the guard, so skip
  // rather than assert against a tarball that isn't actually malicious.
  const made = spawnSync("tar", ["-Pczf", tgz, "-C", join(work, "sub"), "provider.json", "../escape.txt"], { encoding: "utf8" });
  const listed = (spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" }).stdout || "").split("\n").map((e) => e.trim());
  const hasUnsafeMember = listed.some((e) => e.startsWith("/") || e.split("/").includes(".."));
  if (made.status !== 0 || !hasUnsafeMember) {
    rmSync(work, { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
    return;
  }
  const r = rec(installProvider(tgz, { yes: true }));
  assert.equal(r.state, "error");
  assert.match(r.error ?? "", /unsafe member|path traversal/);
  assert.equal(existsSync(join(HOME, "escape.txt")), false, "nothing written outside the package dir");

  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("install: refuses a tarball containing a symlink member (write-through escape)", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-symlink-"));
  const pkg = join(work, "pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "provider.json"), "{}");
  // a symlink member pointing outside the staging dir — a follow-up file member
  // under it could write through it during extraction, so install must refuse
  // the tarball at listing time (before extraction).
  try {
    symlinkSync("/tmp", join(pkg, "escape"));
  } catch {
    rmSync(work, { recursive: true, force: true }); // platform without symlink support
    rmSync(HOME, { recursive: true, force: true });
    return;
  }
  const tgz = join(work, "sym.tgz");
  const made = spawnSync("tar", ["-czf", tgz, "-C", pkg, "provider.json", "escape"], { encoding: "utf8" });
  // verify the symlink actually survived AS a link member (some tars deref)
  const vlist = spawnSync("tar", ["-tvzf", tgz], { encoding: "utf8" }).stdout || "";
  const isLink = vlist.split("\n").some((l) => l.trim() && (l.trim()[0] === "l" || / -> | link to /.test(l)));
  if (made.status !== 0 || !isLink) {
    rmSync(work, { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
    return;
  }
  const r = rec(installProvider(tgz, { yes: true }));
  assert.equal(r.state, "error");
  assert.match(r.error ?? "", /link member|symlink/);
  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("install: a regular file whose name contains ' -> ' is NOT misflagged as a link (Bugbot #118)", () => {
  HOME = freshHome();
  const work = mkdtempSync(join(tmpdir(), "oc-install-arrow-"));
  const pkg = writeSourcePkg(work, "arrowpkg", "arrowtype");
  // a regular file whose NAME contains the symlink/hardlink notation strings —
  // the link check must key on the tar type char, not this text
  writeFileSync(join(pkg, "a -> b link to c.txt"), "regular file, not a link");
  const tgz = join(work, "arrow.tgz");
  const made = spawnSync("tar", ["-czf", tgz, "-C", work, "arrowpkg"], { encoding: "utf8" });
  // sanity: the odd name survived AND is listed as a regular file (type '-')
  const vlist = spawnSync("tar", ["-tvzf", tgz], { encoding: "utf8" }).stdout || "";
  const arrowLine = vlist.split("\n").find((l) => l.includes("a -> b link to c.txt"));
  if (made.status !== 0 || !arrowLine || arrowLine.trim()[0] !== "-") {
    rmSync(work, { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
    return;
  }
  const r = rec(installProvider(tgz, { yes: true }));
  assert.notEqual(r.state, "error", `must not reject a valid package: ${r.error ?? ""}`);
  assert.doesNotMatch(r.error ?? "", /link member/);
  rmSync(work, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("builtinDescriptor resolves an installed source type at the target home (Bugbot #110)", () => {
  const savedEnv = process.env.OVERCAST_HOME;
  delete process.env.OVERCAST_HOME;
  const home = mkdtempSync(join(tmpdir(), "oc-bd-home-"));
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  try {
    installProvider(writeSourcePkg(work, "acme"), { yes: true }, home);
    const d = builtinDescriptor("acme", home);
    assert.ok(d && d.base[d.base.length - 1].endsWith("acme/run.sh"), "resolved (base absolute) at the target home");
    assert.equal(builtinDescriptor("acme"), undefined, "not resolved at the default home");
  } finally {
    if (savedEnv === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedEnv;
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("findProviderChoice honors the target home for an installed choice (Bugbot #110)", () => {
  const savedEnv = process.env.OVERCAST_HOME;
  delete process.env.OVERCAST_HOME;
  const home = mkdtempSync(join(tmpdir(), "oc-fpc-home-"));
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  try {
    const vlm = join(work, "vlm");
    mkdirSync(vlm, { recursive: true });
    writeFileSync(join(vlm, "provider.json"), JSON.stringify({
      manifest_version: 1, name: "vlm", version: "1.0.0",
      entries: [{ kind: "sense", id: "vlm", verb: "see", label: "a", summary: "b",
        descriptor: { type: "exec", run: "bash installed:vlm/run.sh --input {{input}}" } }],
    }));
    writeFileSync(join(vlm, "run.sh"), "echo '{}'\n");
    installProvider(vlm, { yes: true }, home);
    assert.ok(findProviderChoice("see", "vlm", home), "installed choice found via the target home");
    assert.equal(findProviderChoice("see", "vlm"), undefined, "not found via the default home");
  } finally {
    if (savedEnv === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedEnv;
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("scanManifests reflects on-disk installed changes with no explicit invalidation (Bugbot #110)", () => {
  const savedEnv = process.env.OVERCAST_HOME;
  delete process.env.OVERCAST_HOME;
  const home = mkdtempSync(join(tmpdir(), "oc-fresh-home-"));
  const work = mkdtempSync(join(tmpdir(), "oc-install-src-"));
  try {
    installProvider(writeSourcePkg(work, "acme"), { yes: true }, home);
    assert.ok(scanManifests(home).some((l) => l.pkg === "acme"), "installed package is scanned");
    // remove the package dir directly (no invalidateManifestCache) — a stale cache
    // would keep serving it; the installed root is scanned fresh every call.
    rmSync(join(home, "providers", "acme"), { recursive: true, force: true });
    assert.ok(!scanManifests(home).some((l) => l.pkg === "acme"), "removed package no longer served");
  } finally {
    if (savedEnv === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = savedEnv;
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("hashProviderTree ignores the provenance file (stable across stamping)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-hash-"));
  writeFileSync(join(dir, "a.txt"), "hello");
  const before = hashProviderTree(dir);
  writeFileSync(join(dir, ".overcast-install.json"), JSON.stringify({ sha256: before }));
  assert.equal(hashProviderTree(dir), before, "provenance file excluded from the tree hash");
  rmSync(dir, { recursive: true, force: true });
});
