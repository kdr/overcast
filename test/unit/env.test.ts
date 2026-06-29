import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, redactSecrets } from "../../src/env.ts";

test("case dotenv override only replaces values loaded from an earlier dotenv", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oc-env-cwd-"));
  const caseDir = mkdtempSync(join(tmpdir(), "oc-env-case-"));
  const key = `OC_TEST_DOTENV_${Date.now()}`;
  const shellKey = `${key}_SHELL`;
  try {
    writeFileSync(join(cwd, ".env"), `${key}=cwd\n${shellKey}=cwd\n`);
    writeFileSync(join(caseDir, ".env"), `${key}=case\n${shellKey}=case\n`);
    process.env[shellKey] = "shell";

    loadDotEnv(cwd);
    assert.equal(process.env[key], "cwd");
    assert.equal(process.env[shellKey], "shell");

    loadDotEnv(caseDir, { override: true });
    assert.equal(process.env[key], "case");
    assert.equal(process.env[shellKey], "shell");
  } finally {
    delete process.env[key];
    delete process.env[shellKey];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(caseDir, { recursive: true, force: true });
  }
});

test("redactSecrets preserves innocent dotted evidence text", () => {
  const text = [
    "route aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccc was printed in the transcript",
    "APIFY_TOKEN=apify_api_abcdefghijklmnopqrstuvwxyz123456",
    "Authorization: sk-abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const redacted = redactSecrets(text);
  assert.match(redacted, /aaaaaaaaaaaaaaaaaaaaaaaa\.bbbbbb\.cccccc/);
  assert.doesNotMatch(redacted, /apify_api_/);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
});
