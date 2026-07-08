// Contract guard for the shipped example providers. The same handful of bugs kept
// recurring across these ~14 near-identical scripts (Bugbot reported each file
// separately): describe emitting invalid JSON, and a value-less trailing flag
// crashing the interpreter (bash `set -u` "unbound variable" / Python IndexError).
// This locks the contract for ALL of them at once. Add new providers to PROVIDERS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runExecProvider } from "../../src/providers/run.ts";
import { enumerateSource } from "../../src/providers/sources/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const P = (rel: string) => join(ROOT, "examples/providers", rel);

type Kind = "sense" | "source";
interface Prov {
  file: string;
  kind: Kind;
  cmd: string;
  base: string[]; // interpreter args before the subcommand
}
const sh = (file: string, kind: Kind = "sense"): Prov => ({ file, kind, cmd: "bash", base: [P(file)] });
const py = (file: string): Prov => ({ file, kind: "sense", cmd: "python3", base: [P(file)] });
const ts = (file: string): Prov => ({ file, kind: "sense", cmd: "node", base: ["--import", "tsx", P(file)] });

const PROVIDERS: Prov[] = [
  sh("bash/watch.sh"),
  sh("fal/see.sh"),
  sh("fal/enhance.sh"),
  sh("hf/see.sh"),
  sh("hf/enhance.sh"),
  sh("elevenlabs/listen.sh"),
  sh("elevenlabs/enhance.sh"),
  sh("local/enhance.sh"),
  py("python/listen.py"),
  py("hf/enhance.py"),
  py("detect/detect.py"),
  py("visual-db/enhance_voice.py"),
  py("visual-db/enhance_segment.py"),
  ts("ts/see.ts"),
  sh("sources/youtube.sh", "source"),
  sh("sources/tiktok.sh", "source"),
  sh("sources/x.sh", "source"),
  sh("sources/web.sh", "source"),
];

function run(p: Prov, args: string[]) {
  const res = spawnSync(p.cmd, [...p.base, ...args], { encoding: "utf8", timeout: 30_000 });
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "", spawnErr: res.error };
}
const missingDeps = (s: string) => /command not found|ModuleNotFoundError|No module named|Cannot find (module|package)|ENOENT/i.test(s);

test("every shipped provider's `describe` emits a valid JSON object (no unescaped interpolation)", () => {
  for (const p of PROVIDERS) {
    const r = run(p, ["describe"]);
    if (r.spawnErr || missingDeps(r.err)) continue; // interpreter/deps absent → skip, not fail
    assert.equal(r.code, 0, `${p.file}: describe should exit 0 (got ${r.code}; ${r.err.slice(0, 120)})`);
    let parsed: unknown;
    assert.doesNotThrow(() => (parsed = JSON.parse(r.out.trim())), `${p.file}: describe must be valid JSON (got: ${r.out.slice(0, 120)})`);
    assert.equal(typeof parsed, "object", `${p.file}: describe must be a JSON object`);
  }
});

test("no provider crashes the interpreter on a value-less trailing flag (set -u / IndexError)", () => {
  for (const p of PROVIDERS) {
    // the exact shape Bugbot kept finding: a value-taking flag is the last token.
    const args = p.kind === "source" ? ["enumerate", "--query"] : ["run", "--input"];
    const r = run(p, args);
    if (r.spawnErr) continue; // interpreter absent
    assert.ok(
      !/unbound variable|IndexError/i.test(r.err),
      `${p.file}: a value-less trailing flag must not crash (got: ${r.err.split("\n").find((l) => /unbound variable|IndexError/i.test(l))})`,
    );
    // if it printed anything to stdout, it must be valid JSON (a structured record),
    // not a half-built string — unless deps are missing.
    if (r.out.trim() && !missingDeps(r.err)) {
      assert.doesNotThrow(() => JSON.parse(r.out.trim()), `${p.file}: stdout on a bad flag must be valid JSON (got: ${r.out.slice(0, 120)})`);
    }
  }
});

// Security (plan 011): provider stderr flows into the persisted record `error`
// field, and the at-rest store (.overcast/records/*.jsonl) is written verbatim.
// A provider that echoes a credentialed URL / token to stderr must NOT land it on
// disk — the exec boundary redacts the stderr slice before it reaches the record.
test("provider stderr carrying a secret is redacted before it reaches the persisted error field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-stderr-redact-"));
  try {
    // A fixture provider that leaks an Apify-shaped token to stderr, then fails
    // with no JSON on stdout (→ an error record via runExecProvider/enumerateSource).
    const SECRET = "apify_api_0123456789abcdefghij"; // matches SECRET_VALUE_RE in src/env.ts
    const script = join(dir, "leak.sh");
    writeFileSync(script, `#!/usr/bin/env bash\necho "auth error: token=${SECRET} rejected" 1>&2\nexit 1\n`);

    // runExecProvider — generic exec sense provider (src/providers/run.ts)
    const rec = await runExecProvider("see", `bash ${script}`, "evidence.jpg");
    assert.equal(rec.state, "error", "non-zero exit with no JSON record → error state");
    assert.match(rec.error ?? "", /^provider exited 1:/, "error prefix unchanged (characterization)");
    assert.ok(rec.error?.includes("[REDACTED]"), `error must be redacted (got: ${rec.error})`);
    assert.ok(!rec.error?.includes(SECRET), `raw secret must not persist (got: ${rec.error})`);

    // enumerateSource — source provider (src/providers/sources/index.ts)
    const [scanRec] = await enumerateSource({ type: "test", base: ["bash", script] }, {});
    assert.equal(scanRec.state, "error");
    assert.ok(scanRec.error?.includes("[REDACTED]"), `enumerate error must be redacted (got: ${scanRec.error})`);
    assert.ok(!scanRec.error?.includes(SECRET), `enumerate must not persist raw secret (got: ${scanRec.error})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
