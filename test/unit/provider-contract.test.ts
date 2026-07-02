// Contract guard for the shipped example providers. The same handful of bugs kept
// recurring across these ~14 near-identical scripts (Bugbot reported each file
// separately): describe emitting invalid JSON, and a value-less trailing flag
// crashing the interpreter (bash `set -u` "unbound variable" / Python IndexError).
// This locks the contract for ALL of them at once. Add new providers to PROVIDERS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  py("python/listen.py"),
  py("hf/enhance.py"),
  py("detect/detect.py"),
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
