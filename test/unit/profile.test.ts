import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProfile,
  loadProfile,
  saveProfile,
  resolveHome,
  resolveCloudglue,
} from "../../src/profile.ts";

test("defaultProfile binds watch to the tinycloud exec provider, BYO brain", () => {
  const p = defaultProfile();
  assert.equal(p.name, "default");
  assert.equal(p.llm, undefined); // brain not forced
  assert.equal(p.providers?.watch.type, "exec");
  assert.match(p.providers!.watch.run!, /tinycloud watch/);
});

test("resolveHome honors --home > $OVERCAST_HOME > default", () => {
  const saved = process.env.OVERCAST_HOME;
  try {
    delete process.env.OVERCAST_HOME;
    assert.match(resolveHome(), /\.overcast$/);
    process.env.OVERCAST_HOME = "/tmp/och";
    assert.equal(resolveHome(), "/tmp/och");
    assert.equal(resolveHome({ home: "/explicit" }), "/explicit");
  } finally {
    if (saved === undefined) delete process.env.OVERCAST_HOME;
    else process.env.OVERCAST_HOME = saved;
  }
});

test("save + load profile round-trips through the real fs home", () => {
  const home = mkdtempSync(join(tmpdir(), "oc-home-"));
  try {
    const p = defaultProfile("myprofile");
    p.llm = { provider: "cloudglue", model: "tinycloud:advanced" };
    saveProfile(p, { home });
    const loaded = loadProfile({ home, profile: "myprofile" });
    assert.equal(loaded.name, "myprofile");
    assert.equal(loaded.llm?.model, "tinycloud:advanced");
    // missing profile → built-in default
    assert.equal(loadProfile({ home, profile: "nope" }).providers?.watch.type, "exec");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveCloudglue strips trailing /v1 and reads a key", () => {
  const savedKey = process.env.CLOUDGLUE_API_KEY;
  const savedBase = process.env.CLOUDGLUE_BASE_URL;
  try {
    process.env.CLOUDGLUE_API_KEY = "cg-test";
    process.env.CLOUDGLUE_BASE_URL = "https://api.cloudglue.dev/v1";
    const cfg = resolveCloudglue();
    assert.equal(cfg.apiKey, "cg-test");
    assert.equal(cfg.baseUrl, "https://api.cloudglue.dev");
  } finally {
    if (savedKey === undefined) delete process.env.CLOUDGLUE_API_KEY;
    else process.env.CLOUDGLUE_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.CLOUDGLUE_BASE_URL;
    else process.env.CLOUDGLUE_BASE_URL = savedBase;
  }
});
