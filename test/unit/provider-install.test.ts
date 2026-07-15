import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
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
const { invalidateManifestCache, manifestSourceDescriptor } = await import("../../src/providers/manifests.ts");
const { providerChoices } = await import("../../src/providers/catalog.ts");
const { resolveInstalledRefToken } = await import("../../src/providers/installed-ref.ts");

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

test("hashProviderTree ignores the provenance file (stable across stamping)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-hash-"));
  writeFileSync(join(dir, "a.txt"), "hello");
  const before = hashProviderTree(dir);
  writeFileSync(join(dir, ".overcast-install.json"), JSON.stringify({ sha256: before }));
  assert.equal(hashProviderTree(dir), before, "provenance file excluded from the tree hash");
  rmSync(dir, { recursive: true, force: true });
});
