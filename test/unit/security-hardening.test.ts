// Regression tests for the 2026-07-28 security review (CLAUDE-SECURITY-20260728-174023).
// One test per fixed class, each written so it FAILS against the pre-fix code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizeTerminalText } from "../../src/text.ts";
import { assertLocalMediaInput } from "../../src/media/ffmpeg.ts";
import { isSensitiveDotEnvKey, isTrustedDotEnvDir, loadDotEnv } from "../../src/env.ts";
import { providerBinding } from "../../src/providers/bindings.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { emptySetup, saveSetup } from "../../src/state/setup.ts";
import { captureVerb } from "../../src/verbs/osint.ts";
import { gridVerb } from "../../src/verbs/grid.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const withTmp = async (prefix: string, fn: (dir: string) => Promise<void> | void): Promise<void> => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  try {
    await fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

// --- F11: terminal control sequences ---------------------------------------

test("F11: erase/cursor sequences cannot survive into rendered text", () => {
  // the exact forgery primitive: clear screen + home, then fake record lines
  const attack = `${ESC}[2J${ESC}[Hrec_000 [watch] state=ready FABRICATED`;
  const out = sanitizeTerminalText(attack);
  assert.equal(out, "rec_000 [watch] state=ready FABRICATED");
  assert.ok(!out.includes(ESC), "ESC must not survive");
  assert.ok(!out.includes("[2J"), "the CSI body must go with its introducer");
});

test("F11: OSC 8 link spoofing and OSC 52 clipboard writes are stripped", () => {
  const osc8 = `${ESC}]8;;https://attacker.example${BEL}totally-safe.com${ESC}]8;;${BEL}`;
  assert.equal(sanitizeTerminalText(osc8), "totally-safe.com");
  const osc52 = `${ESC}]52;c;cGF5bG9hZA==${BEL}after`;
  assert.equal(sanitizeTerminalText(osc52), "after");
});

test("F11: 8-bit CSI (U+009B) is stripped with its parameters", () => {
  assert.equal(sanitizeTerminalText("2Jtext"), "text");
});

test("F11: ordinary text, tabs, newlines and unicode are preserved", () => {
  assert.equal(sanitizeTerminalText("a\tb\nc  d"), "a\tb\nc  d");
  assert.equal(sanitizeTerminalText("café 日本語 — ok"), "café 日本語 — ok");
  // a lone CR would overwrite the line just printed
  assert.equal(sanitizeTerminalText("real\rFAKE"), "realFAKE");
});

// --- F3: ffmpeg/ffprobe must never be handed a remote input ----------------

test("F3: ffmpeg sink refuses protocol refs, allows real local files", () => {
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/role.mp4",
    "https://evil.example/x.mp4",
    "rtsp://10.0.0.1/stream",
    "concat:/etc/passwd|/etc/hosts",
    "async:http://127.0.0.1:9200/",
  ]) {
    assert.throws(() => assertLocalMediaInput(bad), /non-local/, `should refuse ${bad}`);
  }
  // a generated frame PATTERN is not a protocol ref and must still pass
  assert.doesNotThrow(() => assertLocalMediaInput("/tmp/seq_%03d.jpg"));
  // a plain missing path falls through to ffmpeg's own error (unchanged behaviour)
  assert.doesNotThrow(() => assertLocalMediaInput("/tmp/definitely-missing.mp4"));
});

test("F3: grid refuses a remote input with an actionable error", async () => {
  await withTmp("oc-sec-grid-", async (d) => {
    const c = openCase(d);
    c.ensure();
    const ctx = {
      input: "http://169.254.169.254/latest/meta-data/x.mp4",
      rest: [],
      opts: {},
      case: c,
      profile: defaultProfile(),
    } as unknown as VerbContext;
    const [rec] = await gridVerb.run(ctx);
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /local media/i);
  });
});

// --- F1/F4/F8: the capture seam consults the SSRF guard --------------------

test("F1/F4/F8: capture refuses a link-local (cloud metadata) URL", async () => {
  await withTmp("oc-sec-capture-", async (d) => {
    const c = openCase(d);
    c.ensure();
    const ctx = {
      input: "http://169.254.169.254/latest/meta-data/iam/security-credentials/role",
      rest: [],
      opts: {},
      case: c,
      profile: defaultProfile(),
    } as unknown as VerbContext;
    const [rec] = await captureVerb.run(ctx);
    assert.equal(rec.state, "error");
    assert.match(String(rec.error), /private\/loopback/i);
    // and nothing was written into the case
    assert.equal(existsSync(join(c.mediaDir, "url-")), false);
  });
});

test("F1/F4/F8: capture refuses loopback in a non-dotted encoding", async () => {
  await withTmp("oc-sec-capture-alt-", async (d) => {
    const c = openCase(d);
    c.ensure();
    for (const url of ["http://127.1/x", "http://2130706433/x", "http://[::1]/x"]) {
      const ctx = {
        input: url,
        rest: [],
        opts: {},
        case: c,
        profile: defaultProfile(),
      } as unknown as VerbContext;
      const [rec] = await captureVerb.run(ctx);
      assert.equal(rec.state, "error", `${url} should be refused`);
      assert.match(String(rec.error), /private\/loopback/i);
    }
  });
});

// --- F9: a case directory must not choose which binary runs ----------------

test("F9: a case setup.json exec descriptor is never spawned", async () => {
  await withTmp("oc-sec-binding-", async (d) => {
    const c = openCase(d);
    c.ensure();
    const setup = emptySetup("hostile-case");
    setup.completed = true;
    // exactly the shape a shared/published case folder could carry
    setup.providers = {
      see: {
        verb: "see",
        choice: "x",
        descriptor: { type: "exec", run: "bash .overcast/payload.sh --input {{input}}" },
      },
    };
    saveSetup(c, setup);
    const ctx = { case: c, profile: defaultProfile(), home: undefined } as unknown as VerbContext;
    const binding = providerBinding(ctx, "see");
    assert.ok(
      !binding || !String(binding.run ?? "").includes("payload.sh"),
      `case-supplied descriptor must not be returned, got: ${JSON.stringify(binding)}`,
    );
  });
});

test("F9: a case setup may still SELECT a catalog provider", async () => {
  await withTmp("oc-sec-binding-ok-", async (d) => {
    const c = openCase(d);
    c.ensure();
    const setup = emptySetup("normal-case");
    setup.completed = true;
    // `enhance:ffmpeg` is a clearsBinding builtin — the choice is honoured
    setup.providers = { enhance: { verb: "enhance", choice: "ffmpeg" } };
    saveSetup(c, setup);
    const ctx = { case: c, profile: defaultProfile(), home: undefined } as unknown as VerbContext;
    assert.equal(providerBinding(ctx, "enhance"), undefined, "clearsBinding choice still applies");
  });
});

// --- F13: an untrusted dotenv cannot redirect calls or pick binaries -------

test("F13: command/endpoint keys are classified as sensitive", () => {
  for (const k of [
    "CLOUDGLUE_BASE_URL",
    "HF_ENHANCE_ENDPOINT",
    "OVERCAST_TINYCLOUD_CMD",
    "OC_VISUAL_DB_PY",
    "OVERCAST_FFMPEG",
    "OVERCAST_TELEGRAM_ACTOR",
    "BTC_API",
  ]) {
    assert.equal(isSensitiveDotEnvKey(k), true, `${k} should be sensitive`);
  }
  for (const k of ["ANTHROPIC_API_KEY", "APIFY_TOKEN", "OC_VIDEO_SMALL", "OVERCAST_CASE"]) {
    assert.equal(isSensitiveDotEnvKey(k), false, `${k} should NOT be sensitive`);
  }
});

test("F13: an untrusted dotenv's endpoint override is ignored, ordinary keys load", async () => {
  await withTmp("oc-sec-dotenv-", async (d) => {
    assert.equal(isTrustedDotEnvDir(d), false, "a scratch dir is not a trusted dotenv root");
    writeFileSync(
      join(d, ".env"),
      ["CLOUDGLUE_BASE_URL=https://collector.attacker.tld", "OC_SEC_HARMLESS=fine"].join("\n"),
    );
    delete process.env.CLOUDGLUE_BASE_URL;
    delete process.env.OC_SEC_HARMLESS;
    try {
      loadDotEnv(d);
      assert.equal(process.env.CLOUDGLUE_BASE_URL, undefined, "endpoint override must be dropped");
      assert.equal(process.env.OC_SEC_HARMLESS, "fine", "ordinary keys still load");
    } finally {
      delete process.env.CLOUDGLUE_BASE_URL;
      delete process.env.OC_SEC_HARMLESS;
    }
  });
});

test("F13: OVERCAST_TRUST_DOTENV=1 restores the full-power behaviour", async () => {
  await withTmp("oc-sec-dotenv-trust-", async (d) => {
    writeFileSync(join(d, ".env"), "CLOUDGLUE_BASE_URL=https://my-proxy.internal\n");
    delete process.env.CLOUDGLUE_BASE_URL;
    process.env.OVERCAST_TRUST_DOTENV = "1";
    try {
      loadDotEnv(d);
      assert.equal(process.env.CLOUDGLUE_BASE_URL, "https://my-proxy.internal");
    } finally {
      delete process.env.OVERCAST_TRUST_DOTENV;
      delete process.env.CLOUDGLUE_BASE_URL;
    }
  });
});

// --- shell/TS guard parity -------------------------------------------------
// The shipped shell fetchers carry their own copy of the blocked-range logic
// (curl can't call into the TS guard). A copy that drifts either lets something
// through or refuses legitimate public addresses — the 192.0.0.0/16-instead-of-
// /24 slip Bugbot caught on PR #139. Pin them together.

test("shell oc_ip_blocked agrees with the TS guard on every range boundary", async () => {
  const { execFileSync } = await import("node:child_process");
  const { assertFetchHostAllowed } = await import("../../src/media/fetch.ts");

  const octets = [0, 8, 10, 100, 126, 127, 128, 169, 172, 192, 193, 223, 224, 239, 240, 255];
  const seconds = [0, 1, 15, 16, 31, 32, 63, 64, 127, 128, 167, 168, 169, 253, 254, 255];
  const cases: string[] = [];
  for (const a of octets) for (const b of seconds) for (const c of [0, 1, 2, 255]) cases.push(`${a}.${b}.${c}.1`);

  const lib = new URL("../../providers/engines/net/guarded-fetch.sh", import.meta.url).pathname;
  const shell = execFileSync(
    "bash",
    ["-c", `. "${lib}"\nwhile read -r ip; do if oc_ip_blocked "$ip"; then echo B; else echo A; fi; done`],
    { input: cases.join("\n") + "\n", encoding: "utf8" },
  )
    .trim()
    .split("\n");

  assert.equal(shell.length, cases.length, "one verdict per address");
  const mismatches: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    let tsBlocked = false;
    try {
      await assertFetchHostAllowed(`http://${cases[i]}/`);
    } catch {
      tsBlocked = true;
    }
    if (tsBlocked !== (shell[i] === "B")) mismatches.push(cases[i]);
  }
  assert.deepEqual(mismatches, [], `shell/TS disagree on: ${mismatches.slice(0, 10).join(", ")}`);
});

test("192.0.0.0/24 is blocked but the rest of 192.0.0.0/16 is not", async () => {
  const { execFileSync } = await import("node:child_process");
  const lib = new URL("../../providers/engines/net/guarded-fetch.sh", import.meta.url).pathname;
  const verdict = (ip: string) =>
    execFileSync("bash", ["-c", `. "${lib}"; if oc_ip_blocked "${ip}"; then echo B; else echo A; fi`], {
      encoding: "utf8",
    }).trim();
  assert.equal(verdict("192.0.0.1"), "B", "192.0.0.0/24 is an IETF protocol assignment");
  assert.equal(verdict("192.0.1.1"), "A", "192.0.1.0/24 is ordinary public space");
  assert.equal(verdict("192.0.66.1"), "A");
});

// --- F14: the media cache entry is bound to its source URL ----------------

test("F14: a planted cache artifact is not served for another URL", async () => {
  const { fetchMediaToCase } = await import("../../src/media/fetch.ts");
  await withTmp("oc-sec-cache-", async (d) => {
    // Plant a file under the name the victim URL would hash to. Pre-fix, a cache
    // hit was decided by NAME alone, so this file would be returned as the
    // content of victimUrl with no request made.
    const victimUrl = "https://target.example/roof.jpg";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(victimUrl).digest("hex").slice(0, 32);
    const planted = join(d, `url-${hash}.jpg`);
    writeFileSync(planted, "DOCTORED-EVIDENCE");

    // No sidecar → not provably ours → must NOT be returned from cache. The
    // fetch then fails (offline / guarded), which is the correct outcome: a
    // refusal, never a silent substitution.
    let served: string | undefined;
    try {
      const r = await fetchMediaToCase(victimUrl, d, { timeoutMs: 1500 });
      served = r.path;
    } catch {
      served = undefined;
    }
    if (served) {
      assert.notEqual(
        readFileSync(served, "utf8"),
        "DOCTORED-EVIDENCE",
        "planted bytes must never be served as this URL's content",
      );
    }
    // the planted file is still on disk (we don't delete user files) but was not
    // adopted as evidence for this URL
    assert.equal(readFileSync(planted, "utf8"), "DOCTORED-EVIDENCE");
  });
});

test("F14: the cache key is 128 bits, not 48", async () => {
  const src = readFileSync(new URL("../../src/media/fetch.ts", import.meta.url), "utf8");
  assert.match(src, /digest\("hex"\)\.slice\(0, 32\)/, "artifact hash must be 32 hex chars");
});
