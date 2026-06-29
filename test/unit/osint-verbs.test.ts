import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { scanVerb, captureVerb, monitorVerb } from "../../src/verbs/osint.ts";
import { exitCodeForRecords } from "../../src/cli.ts";
import { addSource } from "../../src/state/source.ts";
import { saveSeen } from "../../src/state/seen.ts";
import { addTarget } from "../../src/state/target.ts";
import { addIndex, addMember } from "../../src/state/index.ts";
import { emptySetup, saveSetup } from "../../src/state/setup.ts";
import { FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import { makeRecord } from "../../src/record.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SOURCE = join(HERE, "..", "fixtures", "fake-source.sh");
const FAKE_WATCH = join(HERE, "..", "fixtures", "fake-watch.sh");
const FAKE_TINYCLOUD = join(HERE, "..", "fixtures", "fake-tinycloud.sh");

let dir: string;
let clip: string;
let clip2: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-osintv-"));
  // two distinct clips → the fixture's two hits are genuinely two items (monitor
  // dedups by media.ref, so they must differ to count as two).
  clip = join(dir, "src.mp4");
  clip2 = join(dir, "src2.mp4");
  for (const c of [clip, clip2]) {
    execFileSync(
      FFMPEG_PATH,
      ["-y", "-f", "lavfi", "-i", "testsrc=size=96x72:rate=10:duration=1", "-pix_fmt", "yuv420p", c],
      { stdio: "ignore" },
    );
  }
  // wire the fixture source provider + the clips it points at
  process.env.OVERCAST_SOURCE_FIXTURE_CMD = `bash ${FAKE_SOURCE}`;
  process.env.OVERCAST_FIXTURE_CLIP = clip;
  process.env.OVERCAST_FIXTURE_CLIP2 = clip2;
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OVERCAST_SOURCE_FIXTURE_CMD;
  delete process.env.OVERCAST_FIXTURE_CLIP;
  delete process.env.OVERCAST_FIXTURE_CLIP2;
});

function ctx(opts: VerbContext["opts"] = {}, input?: string): VerbContext {
  const c = openCase(dir);
  c.ensure();
  // bind watch to the fixture provider so --pipe watch stays offline
  const profile = defaultProfile();
  profile.providers = {
    ...profile.providers,
    watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` },
  };
  return { input, rest: input ? [] : [], opts, case: c, profile };
}

test("scan enumerates the fixture source into scan.hit records", async () => {
  const c = openCase(dir);
  c.ensure();
  addSource(c, "fixture:pier9");
  const recs = await scanVerb.run(ctx());
  const hits = recs.filter((r) => r.verb === "scan" && r.state !== "error");
  assert.equal(hits.length, 2);
  assert.equal((hits[0].payload as Record<string, unknown>).source, "fixture");
  assert.equal(hits[0].media?.ref, clip);
});

test("scan falls back to local case media and face index when no sources exist", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-localscan-"));
  const prev = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    const c = openCase(d);
    c.ensure();
    const img = join(d, "face.jpg");
    const video = join(d, "clip.mp4");
    writeFileSync(img, "fake image");
    writeFileSync(video, "fake video");
    addTarget(c, "Will Smith");
    addTarget(c, img, { image: true });
    addIndex(c, { id: "idx_face", name: "faces", type: "face-analysis" });
    addMember(c, "idx_face", { ref: video });
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: {}, case: c, profile: defaultProfile() });
    const summary = recs.find((r) => r.verb === "scan")!;
    assert.equal(summary.state, "ready");
    assert.equal((summary.payload as Record<string, unknown>).op, "local");
    assert.deepEqual((summary.payload as Record<string, unknown>).media, [video]);
    assert.match(JSON.stringify((summary.payload as Record<string, unknown>).suggested_commands), /face --match/);
    assert.equal(recs.some((r) => r.verb === "face" && (r.payload as Record<string, unknown>).op === "search"), true);
  } finally {
    if (prev === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prev;
    rmSync(d, { recursive: true, force: true });
  }
});

test("capture copies a local media ref into the case store", async () => {
  const [rec] = await captureVerb.run(ctx({}, clip));
  assert.equal(rec.verb, "capture");
  assert.equal(rec.state, "ready");
  assert.ok(existsSync(rec.media!.ref));
  assert.match((rec.payload as Record<string, unknown>).path as string, /\.overcast\/media\//);
});

test("scan --pull uses setup automation and emits review findings", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-auto-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "Hacker News");
    const setup = emptySetup("auto");
    setup.completed = true;
    setup.automation = { auto_sense: ["watch"], auto_index_new: false };
    setup.findings = { mode: "review" };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile });
    assert.ok(recs.some((r) => r.verb === "watch"));
    const findings = recs.filter((r) => r.verb === "finding");
    assert.ok(findings.length >= 1);
    assert.equal((findings[0].payload as Record<string, unknown>).target, "Hacker News");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull review findings do not use substring target matches", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-finding-substring-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "mac");
    const setup = emptySetup("auto-substring");
    setup.completed = true;
    setup.automation = { auto_sense: ["watch"], auto_index_new: false };
    setup.findings = { mode: "review" };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, limit: 1 }, case: c, profile });
    assert.equal(recs.some((r) => r.verb === "watch"), true);
    assert.equal(recs.some((r) => r.verb === "finding"), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull --pipe watch sends TikTok URLs directly to tinycloud and checkpoints progress", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-tiktok-direct-"));
  const sourceScript = join(d, "tiktok-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_TTFIXTURE_CMD;
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  const url = "https://vm.tiktok.com/ZM123abc/";
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "enumerate" ]; then
  echo '[{"title":"tt","url":"${url}","source":"ttfixture","media":{"ref":"${url}"}}]'
else
  echo '{}'
fi
`);
    process.env.OVERCAST_SOURCE_TTFIXTURE_CMD = `bash ${sourceScript}`;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "ttfixture:any");
    addTarget(c, "fixture video");
    const setup = emptySetup("direct-pipe-finding");
    setup.completed = true;
    setup.findings = { mode: "review" };
    saveSetup(c, setup);

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, pipe: "watch", limit: 1 }, case: c, profile: defaultProfile() });
    const progress = recs.filter((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).op === "pull_progress");
    assert.equal(progress.some((r) => (r.payload as Record<string, unknown>).via === "direct-url"), true);
    const watch = recs.find((r) => r.verb === "watch");
    assert.equal(watch?.media?.ref, url);
    assert.equal(recs.some((r) => r.verb === "finding"), true);
    assert.equal(c.records().some((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).title === "tt"), true);
    assert.equal(c.records().some((r) => r.verb === "watch" && r.media?.ref === watch?.media?.ref), true);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_TTFIXTURE_CMD;
    else process.env.OVERCAST_SOURCE_TTFIXTURE_CMD = prevSource;
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor explicit --pipe emits review findings", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-pipe-finding-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "Hacker News");
    const setup = emptySetup("monitor-pipe-finding");
    setup.completed = true;
    setup.findings = { mode: "review" };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true, pipe: "watch" }, case: c, profile });
    assert.equal(recs.some((r) => r.verb === "watch"), true);
    assert.equal(recs.some((r) => r.verb === "finding"), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull: a partial-success pull exits 0 with subsumed failures tagged non_fatal", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-partial-"));
  const sourceScript = join(d, "partial-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_PARTIALFIX_CMD;
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  const url = "https://vm.tiktok.com/ZM123abc/";
  try {
    // one hit with a TikTok ref (completes via direct sense) + one ref-less hit
    // (a processed failure) → a genuine partial success.
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "enumerate" ]; then
  echo '[{"title":"ok","url":"${url}","source":"partialfix","media":{"ref":"${url}"}},{"title":"no ref","source":"partialfix"}]'
else
  echo '{}'
fi
`);
    process.env.OVERCAST_SOURCE_PARTIALFIX_CMD = `bash ${sourceScript}`;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "partialfix:any");

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, pipe: "watch" }, case: c, profile: defaultProfile() });
    const final = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "complete")!;
    // partial success: at least one completed AND at least one failed
    assert.equal(final.state, "ready");
    assert.ok((final.payload as Record<string, unknown>).completed as number >= 1);
    assert.ok((final.payload as Record<string, unknown>).failed as number >= 1);
    // the ref-less failure is still recorded, but tagged non_fatal so it can't
    // independently fail the run...
    const failure = recs.find((r) => r.state === "error" && /no media\.ref or url/.test(String(r.error)));
    assert.ok(failure, "expected a ref-less pull failure record");
    assert.equal(failure!.meta?.non_fatal, true);
    // ...while the authoritative summary stays untagged and drives the exit code → 0
    assert.equal(final.meta?.non_fatal, undefined);
    assert.equal(exitCodeForRecords(recs), 0);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_PARTIALFIX_CMD;
    else process.env.OVERCAST_SOURCE_PARTIALFIX_CMD = prevSource;
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull marks hits without refs as processed failures", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-refless-"));
  const sourceScript = join(d, "refless-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_REFLESS_CMD;
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "enumerate" ]; then
  echo '[{"title":"no ref","source":"refless"}]'
else
  echo '{}'
fi
`);
    process.env.OVERCAST_SOURCE_REFLESS_CMD = `bash ${sourceScript}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "refless:any");

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile: defaultProfile() });
    const final = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "complete")!;
    assert.equal(final.state, "error");
    assert.equal((final.payload as Record<string, unknown>).processed, 1);
    assert.equal((final.payload as Record<string, unknown>).failed, 1);
    assert.equal(recs.some((r) => r.verb === "scan" && r.state === "ready" && (r.payload as Record<string, unknown>).title === "no ref"), true);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_REFLESS_CMD;
    else process.env.OVERCAST_SOURCE_REFLESS_CMD = prevSource;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor marks hits without refs as process errors", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-refless-"));
  const sourceScript = join(d, "refless-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_REFLESS_CMD;
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "enumerate" ]; then
  echo '[{"title":"no ref","source":"refless"}]'
else
  echo '{}'
fi
`);
    process.env.OVERCAST_SOURCE_REFLESS_CMD = `bash ${sourceScript}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "refless:any");

    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true }, case: c, profile: defaultProfile() });
    const summary = recs.find((r) => r.verb === "monitor")!;
    assert.equal(summary.state, "error");
    assert.equal((summary.payload as Record<string, unknown>).total_hits, 1);
    assert.equal((summary.payload as Record<string, unknown>).process_errors, 1);
    assert.equal(recs.some((r) => r.verb === "monitor" && /no fetchable ref or url/.test(String(r.error))), true);
    assert.equal(recs.some((r) => r.verb === "scan" && r.state === "ready" && (r.payload as Record<string, unknown>).title === "no ref"), true);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_REFLESS_CMD;
    else process.env.OVERCAST_SOURCE_REFLESS_CMD = prevSource;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor explicit invalid --pipe does not fall back to default watch", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-explicit-no-fallback-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true, pipe: "bogus" }, case: c, profile });
    const summary = recs.find((r) => r.verb === "monitor")!;
    assert.equal(summary.state, "error");
    assert.equal((summary.payload as Record<string, unknown>).process_errors, 2);
    assert.equal(recs.some((r) => r.verb === "watch"), false);
    assert.equal(recs.some((r) => r.verb === "monitor" && /unknown --pipe/.test(String(r.error))), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan explicit invalid --pipe marks pull failures instead of defaulting to success", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-explicit-no-success-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, pipe: "bogus" }, case: c, profile });
    const final = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "complete")!;
    assert.equal(final.state, "error");
    assert.equal((final.payload as Record<string, unknown>).processed, 2);
    assert.equal((final.payload as Record<string, unknown>).failed, 2);
    assert.equal(recs.some((r) => r.verb === "watch"), false);
    assert.equal(recs.some((r) => r.verb === "scan" && /unknown --pipe/.test(String(r.error))), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull runs first direct auto-sense for TikTok then captures for remaining senses", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-tiktok-auto-chain-"));
  const sourceScript = join(d, "tiktok-source.sh");
  const seeScript = join(d, "see-local.sh");
  const prevSource = process.env.OVERCAST_SOURCE_TIKTOK_CMD;
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  const url = "https://vm.tiktok.com/ZMchain123/";
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
op="\${1:-enumerate}"; shift || true
case "$op" in
  enumerate)
    echo '[{"title":"tt","url":"${url}","source":"tiktok","media":{"ref":"${url}"}}]'
    ;;
  fetch)
    out=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --out) out="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    cp ${JSON.stringify(clip)} "$out"
    echo "{\"kind\":\"video\",\"path\":\"$out\",\"source\":\"tiktok\"}"
    ;;
  *) echo '{}' ;;
esac
`);
    writeFileSync(seeScript, [
      "#!/usr/bin/env bash",
      "input=\"$1\"",
      "case \"$input\" in",
      "  http*) echo \"see should receive captured media, got $input\" >&2; exit 9 ;;",
      "esac",
      "printf '{\"verb\":\"see\",\"state\":\"ready\",\"media\":{\"ref\":%s},\"payload\":{\"caption\":\"captured tiktok video\"}}\\n' \"$(printf '%s' \"$input\" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')\"",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", sourceScript]);
    execFileSync("chmod", ["755", seeScript]);
    process.env.OVERCAST_SOURCE_TIKTOK_CMD = `bash ${sourceScript}`;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "tiktok:#zurich");
    const setup = emptySetup("direct-chain");
    setup.completed = true;
    setup.automation = { auto_sense: ["watch", "see"], auto_index_new: false };
    setup.providers = {
      see: {
        verb: "see",
        choice: "custom",
        descriptor: { type: "exec", run: `bash ${seeScript} {{input}}` },
      },
    };
    saveSetup(c, setup);

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, limit: 1 }, case: c, profile: defaultProfile() });
    const progress = recs.filter((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).op === "pull_progress");
    assert.equal(progress.some((r) => (r.payload as Record<string, unknown>).via === "direct-url"), true);
    assert.equal(recs.some((r) => r.verb === "watch" && r.media?.ref === url), true);
    const cap = recs.find((r) => r.verb === "capture")!;
    assert.ok(cap.media?.ref);
    assert.match(cap.media.ref, /\.overcast\/media\//);
    assert.equal(recs.some((r) => r.verb === "see" && r.media?.ref === cap.media?.ref), true);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_TIKTOK_CMD;
    else process.env.OVERCAST_SOURCE_TIKTOK_CMD = prevSource;
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull progress counts capture-path sense failures", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-progress-failure-"));
  const failWatch = join(d, "fail-watch.sh");
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    writeFileSync(failWatch, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' '{\"verb\":\"watch\",\"state\":\"error\",\"error\":\"watch failed\",\"payload\":{\"error\":\"watch failed\"}}'",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", failWatch]);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${failWatch} {{input}}` } };

    const prevClip = process.env.OVERCAST_FIXTURE_CLIP;
    const prevClip2 = process.env.OVERCAST_FIXTURE_CLIP2;
    process.env.OVERCAST_FIXTURE_CLIP = clip;
    process.env.OVERCAST_FIXTURE_CLIP2 = clip2;
    try {
      const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, pipe: "watch" }, case: c, profile });
      const final = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "complete")!;
      assert.equal(final.state, "error");
      assert.equal((final.payload as Record<string, unknown>).processed, 2);
      assert.equal((final.payload as Record<string, unknown>).failed, 2);
      assert.equal((final.payload as Record<string, unknown>).completed, 0);
    } finally {
      if (prevClip === undefined) delete process.env.OVERCAST_FIXTURE_CLIP;
      else process.env.OVERCAST_FIXTURE_CLIP = prevClip;
      if (prevClip2 === undefined) delete process.env.OVERCAST_FIXTURE_CLIP2;
      else process.env.OVERCAST_FIXTURE_CLIP2 = prevClip2;
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull partial sense errors are non-fatal progress", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-partial-nonfatal-"));
  const failSee = join(d, "fail-see.sh");
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    writeFileSync(failSee, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' '{\"verb\":\"see\",\"state\":\"error\",\"error\":\"see failed\",\"payload\":{\"error\":\"see failed\"}}'",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", failSee]);
    const setup = emptySetup("partial-nonfatal");
    setup.completed = true;
    setup.automation = { auto_sense: ["watch", "see"], auto_index_new: false };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = {
      ...profile.providers,
      watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` },
      see: { type: "exec", run: `bash ${failSee} {{input}}` },
    };

    const prevClip = process.env.OVERCAST_FIXTURE_CLIP;
    process.env.OVERCAST_FIXTURE_CLIP = clip;
    try {
      const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, limit: 1 }, case: c, profile });
      const processed = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "processed")!;
      const final = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "complete")!;
      const see = recs.find((r) => r.verb === "see")!;
      assert.equal(processed.state, "ready");
      assert.equal((processed.payload as Record<string, unknown>).outcome, "completed_with_error");
      assert.equal(final.state, "ready");
      assert.equal((final.payload as Record<string, unknown>).completed, 2);
      assert.equal((final.payload as Record<string, unknown>).failed, 2);
      assert.equal(see.state, "error");
      assert.equal(see.meta?.non_fatal, true);
    } finally {
      if (prevClip === undefined) delete process.env.OVERCAST_FIXTURE_CLIP;
      else process.env.OVERCAST_FIXTURE_CLIP = prevClip;
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull keeps capture credential gaps separate from hard failures", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-cred-gap-"));
  const sourceScript = join(d, "cred-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_CRED_CMD;
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  enumerate)
    echo '[{"title":"needs creds","url":"https://example.test/video.mp4","source":"cred"}]'
    ;;
  fetch)
    echo 'missing token' >&2
    exit 13
    ;;
  *)
    echo '{}'
    ;;
esac
`);
    process.env.OVERCAST_SOURCE_CRED_CMD = `bash ${sourceScript}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "cred:any");

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile: defaultProfile() });
    const final = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "complete")!;
    assert.equal(final.state, "needs_credentials");
    assert.equal((final.payload as Record<string, unknown>).processed, 1);
    assert.equal((final.payload as Record<string, unknown>).failed, 0);
    assert.equal((final.payload as Record<string, unknown>).process_cred_gaps, 1);
    assert.equal(recs.some((r) => r.verb === "capture" && r.state === "needs_credentials"), true);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_CRED_CMD;
    else process.env.OVERCAST_SOURCE_CRED_CMD = prevSource;
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull complete status includes enumerate failures", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-enum-fail-"));
  const sourceScript = join(d, "enum-cred-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_ENUMCRED_CMD;
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "enumerate" ]; then
  echo 'missing token' >&2
  exit 13
else
  echo '{}'
fi
`);
    process.env.OVERCAST_SOURCE_ENUMCRED_CMD = `bash ${sourceScript}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "enumcred:any");
    addSource(c, "bogus:x");

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile: defaultProfile() });
    const final = recs.find((r) => r.verb === "scan" && (r.payload as Record<string, unknown>).stage === "complete")!;
    assert.equal(final.state, "error");
    assert.equal((final.payload as Record<string, unknown>).processed, 0);
    assert.equal((final.payload as Record<string, unknown>).failed, 1);
    assert.equal((final.payload as Record<string, unknown>).process_cred_gaps, 1);
    assert.equal((final.payload as Record<string, unknown>).enumerate_errors, 1);
    assert.equal((final.payload as Record<string, unknown>).enumerate_cred_gaps, 1);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_ENUMCRED_CMD;
    else process.env.OVERCAST_SOURCE_ENUMCRED_CMD = prevSource;
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull default watch emits review findings when no auto-sense chain is configured", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-default-watch-finding-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "Hacker News");
    const setup = emptySetup("default-watch-finding");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: false };
    setup.findings = { mode: "review" };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile });
    assert.ok(recs.some((r) => r.verb === "watch"));
    const findings = recs.filter((r) => r.verb === "finding");
    assert.ok(findings.length >= 1);
    assert.equal((findings[0].payload as Record<string, unknown>).target, "Hacker News");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan --pull does not duplicate existing review findings for the same media target", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-finding-dedupe-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "Hacker News");
    const setup = emptySetup("finding-dedupe");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: false };
    setup.findings = { mode: "review" };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const first = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile });
    assert.ok(first.some((r) => r.verb === "finding"));
    for (const rec of first) c.writeRecord(rec);

    const second = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: openCase(d), profile });
    assert.equal(second.filter((r) => r.verb === "finding").length, 0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("auto-sense chain dedupes findings across verbs for the same media target", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-finding-chain-dedupe-"));
  const seeScript = join(d, "see-target.sh");
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "Hacker News");
    writeFileSync(seeScript, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' '{\"verb\":\"see\",\"state\":\"ready\",\"payload\":{\"caption\":\"Hacker News screen\"}}'",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", seeScript]);
    const setup = emptySetup("finding-chain-dedupe");
    setup.completed = true;
    setup.automation = { auto_sense: ["watch", "see"], auto_index_new: false };
    setup.findings = { mode: "review" };
    setup.providers = {
      see: {
        verb: "see",
        choice: "custom",
        descriptor: { type: "exec", run: `bash ${seeScript} {{input}}` },
      },
    };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile });
    const findings = recs.filter((r) => r.verb === "finding");
    assert.equal(findings.length, 2);
    assert.equal(findings.every((r) => (r.payload as Record<string, unknown>).source_verb === "watch"), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("dismissed automated findings can be re-detected for review", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-finding-redetect-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "Hacker News");
    const setup = emptySetup("finding-redetect");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: false };
    setup.findings = { mode: "review" };
    saveSetup(c, setup);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const first = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile });
    const firstFindings = first.filter((r) => r.verb === "finding");
    assert.ok(firstFindings.length >= 1);
    for (const rec of first) c.writeRecord(rec);
    for (const finding of firstFindings) {
      c.writeRecord(makeRecord({ verb: "finding", payload: { finding_id: finding.id, status: "dismissed" }, state: "ready" }));
    }

    const second = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: openCase(d), profile });
    assert.ok(second.filter((r) => r.verb === "finding").length >= 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan auto-index reuses the in-flight default watch instead of watching twice", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-auto-index-watch-"));
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    const countFile = join(d, "watch-count");
    const watchScript = join(d, "watch-count.sh");
    writeFileSync(watchScript, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `count_file=${JSON.stringify(countFile)}`,
      "n=0",
      "[ -f \"$count_file\" ] && n=$(cat \"$count_file\")",
      "printf '%s' \"$((n + 1))\" > \"$count_file\"",
      `cat ${JSON.stringify(join(HERE, "..", "fixtures", "watch-envelope.json"))}`,
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", watchScript]);
    const setup = emptySetup("auto-index-watch");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: true };
    setup.indexes = [{ id: "col_fake123", name: "fixture", type: "media-descriptions", default_signals: ["index add"] }];
    saveSetup(c, setup);
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${watchScript} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile });
    assert.equal(recs.filter((r) => r.verb === "watch").length, 2);
    assert.equal(readFileSync(countFile, "utf8"), "2");
  } finally {
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan explicit --pipe watch also auto-indexes new media when configured", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-pipe-auto-index-"));
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    const setup = emptySetup("pipe-auto-index");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: true };
    setup.indexes = [{ id: "col_fake123", name: "fixture", type: "media-descriptions", default_signals: ["index add"] }];
    saveSetup(c, setup);
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, pipe: "watch" }, case: c, profile });
    assert.equal(recs.filter((r) => r.verb === "watch").length, 2);
    assert.equal(recs.filter((r) => r.verb === "index" && (r.payload as Record<string, unknown>).op === "add").length, 2);
  } finally {
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor --pipe watch sends TikTok URLs directly to tinycloud", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-tiktok-direct-"));
  const sourceScript = join(d, "tiktok-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_TTFIXTURE_CMD;
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  const url = "https://vm.tiktok.com/ZMmonitor123/";
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "enumerate" ]; then
  echo '[{"title":"tt","url":"${url}","source":"ttfixture","media":{"ref":"${url}"}}]'
else
  echo '{}'
fi
`);
    process.env.OVERCAST_SOURCE_TTFIXTURE_CMD = `bash ${sourceScript}`;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    const c = openCase(d);
    c.ensure();
    addSource(c, "ttfixture:any");

    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true, pipe: "watch" }, case: c, profile: defaultProfile() });
    const summary = recs.find((r) => r.verb === "monitor")!;
    assert.equal((summary.payload as Record<string, unknown>).new_items, 1);
    assert.equal(recs.some((r) => r.verb === "capture"), false);
    const watch = recs.find((r) => r.verb === "watch");
    assert.equal(watch?.media?.ref, url);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_TTFIXTURE_CMD;
    else process.env.OVERCAST_SOURCE_TTFIXTURE_CMD = prevSource;
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor default watch reports auto-index failures as process errors", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-index-error-"));
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  const prevMode = process.env.OVERCAST_FAKE_TC_MODE;
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    const setup = emptySetup("monitor-index-error");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: true };
    setup.indexes = [{ id: "col_fake123", name: "fixture", type: "media-descriptions", default_signals: ["index add"] }];
    saveSetup(c, setup);
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    process.env.OVERCAST_FAKE_TC_MODE = "pending_error";
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };

    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true }, case: c, profile });
    const summary = recs.find((r) => r.verb === "monitor")!;
    assert.equal(summary.state, "error");
    assert.equal((summary.payload as Record<string, unknown>).new_items, 0);
    assert.equal((summary.payload as Record<string, unknown>).process_errors, 2);
  } finally {
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    if (prevMode === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
    else process.env.OVERCAST_FAKE_TC_MODE = prevMode;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor marks successful senses seen when auto-index needs credentials", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-index-cred-"));
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  const prevMode = process.env.OVERCAST_FAKE_TC_MODE;
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    const setup = emptySetup("monitor-index-cred");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: true };
    setup.indexes = [{ id: "col_fake123", name: "fixture", type: "media-descriptions", default_signals: ["index add"] }];
    saveSetup(c, setup);
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    process.env.OVERCAST_FAKE_TC_MODE = "cred";
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };
    const mkCtx = (): VerbContext => ({ input: undefined, rest: [], opts: { once: true }, case: openCase(d), profile });

    const pass1 = await monitorVerb.run(mkCtx());
    const summary1 = pass1.find((r) => r.verb === "monitor")!;
    assert.equal(summary1.state, "needs_credentials");
    assert.equal((summary1.payload as Record<string, unknown>).new_items, 2);
    assert.equal((summary1.payload as Record<string, unknown>).process_cred_gaps, 2);
    assert.equal(pass1.filter((r) => r.verb === "watch").length, 2);
    assert.equal(pass1.filter((r) => r.verb === "index" && r.state === "needs_credentials").length, 2);
    for (const rec of pass1) c.writeRecord(rec);

    const pass2 = await monitorVerb.run(mkCtx());
    const summary2 = pass2.find((r) => r.verb === "monitor")!;
    assert.equal(summary2.state, "needs_credentials");
    assert.equal((summary2.payload as Record<string, unknown>).new_items, 0);
    assert.equal((summary2.payload as Record<string, unknown>).process_cred_gaps, 2);
    assert.equal(pass2.some((r) => r.verb === "watch"), false);
    assert.equal(pass2.filter((r) => r.verb === "index" && r.state === "needs_credentials").length, 2);
  } finally {
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    if (prevMode === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
    else process.env.OVERCAST_FAKE_TC_MODE = prevMode;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor retries URL-sense index gaps against the captured local media", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-url-index-retry-"));
  const sourceScript = join(d, "tiktok-source.sh");
  const prevSource = process.env.OVERCAST_SOURCE_TTRETRY_CMD;
  const prevTc = process.env.OVERCAST_TINYCLOUD_CMD;
  const prevMode = process.env.OVERCAST_FAKE_TC_MODE;
  const url = "https://www.tiktok.com/@retry/video/7614529664446483725";
  try {
    writeFileSync(sourceScript, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "enumerate" ]; then
  echo '[{"title":"retry url","url":"${url}","source":"ttretry","media":{"ref":"${url}"}}]'
else
  echo '{}'
fi
`);
    process.env.OVERCAST_SOURCE_TTRETRY_CMD = `bash ${sourceScript}`;
    process.env.OVERCAST_TINYCLOUD_CMD = `bash ${FAKE_TINYCLOUD}`;
    process.env.OVERCAST_FAKE_TC_MODE = "cred";
    const c = openCase(d);
    c.ensure();
    addSource(c, "ttretry:any");
    const local = clip;
    const setup = emptySetup("monitor-url-index-retry");
    setup.completed = true;
    setup.automation = { auto_sense: [], auto_index_new: true };
    setup.indexes = [{ id: "col_fake123", name: "fixture", type: "media-descriptions", default_signals: ["index add"] }];
    saveSetup(c, setup);
    saveSeen(c, new Set([`url:${url}`]));
    c.writeRecord(makeRecord({ verb: "capture", payload: { path: local, source_ref: url }, media: { ref: local }, state: "ready" }));
    c.writeRecord(makeRecord({ verb: "watch", payload: { title: "direct url watch" }, media: { ref: url }, state: "ready" }));
    c.writeRecord(makeRecord({ verb: "index", payload: { op: "add" }, media: { ref: local }, state: "needs_credentials" }));

    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true }, case: c, profile: defaultProfile() });
    const summary = recs.find((r) => r.verb === "monitor")!;
    assert.equal(summary.state, "needs_credentials");
    assert.equal((summary.payload as Record<string, unknown>).new_items, 0);
    assert.equal((summary.payload as Record<string, unknown>).process_cred_gaps, 1);
    assert.equal(recs.some((r) => r.verb === "watch"), false);
    assert.equal(recs.some((r) => r.verb === "capture"), false);
    assert.equal(recs.some((r) => r.verb === "index" && r.media?.ref === local && r.state === "needs_credentials"), true);
  } finally {
    if (prevSource === undefined) delete process.env.OVERCAST_SOURCE_TTRETRY_CMD;
    else process.env.OVERCAST_SOURCE_TTRETRY_CMD = prevSource;
    if (prevTc === undefined) delete process.env.OVERCAST_TINYCLOUD_CMD;
    else process.env.OVERCAST_TINYCLOUD_CMD = prevTc;
    if (prevMode === undefined) delete process.env.OVERCAST_FAKE_TC_MODE;
    else process.env.OVERCAST_FAKE_TC_MODE = prevMode;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor counts partial auto-sense success while surfacing failed senses", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monitor-partial-sense-"));
  const failWatch = join(d, "fail-watch.sh");
  const okListen = join(d, "ok-listen.sh");
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    const setup = emptySetup("monitor-partial-sense");
    setup.completed = true;
    setup.automation = { auto_sense: ["watch", "listen"], auto_index_new: false };
    saveSetup(c, setup);
    writeFileSync(failWatch, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' '{\"verb\":\"watch\",\"state\":\"error\",\"error\":\"watch failed\",\"payload\":{\"error\":\"watch failed\"}}'",
      "",
    ].join("\n"));
    writeFileSync(okListen, [
      "#!/usr/bin/env bash",
      "input=\"$1\"",
      "printf '{\"verb\":\"listen\",\"state\":\"ready\",\"media\":{\"ref\":%s},\"payload\":{\"transcript\":\"ok\"}}\\n' \"$(printf '%s' \"$input\" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')\"",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", failWatch]);
    execFileSync("chmod", ["755", okListen]);
    const profile = defaultProfile();
    profile.providers = {
      ...profile.providers,
      watch: { type: "exec", run: `bash ${failWatch} {{input}}` },
      listen: { type: "exec", run: `bash ${okListen} {{input}}` },
    };

    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true }, case: c, profile });
    const summary = recs.find((r) => r.verb === "monitor")!;
    assert.equal(summary.state, "error");
    assert.equal((summary.payload as Record<string, unknown>).new_items, 2);
    assert.equal((summary.payload as Record<string, unknown>).process_errors, 2);
    assert.equal(recs.filter((r) => r.verb === "watch" && r.state === "error").length, 2);
    assert.equal(recs.filter((r) => r.verb === "listen" && r.state === "ready").length, 2);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan auto-sense see passes case targets as owl-local labels", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-auto-see-detect-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "license plate");
    const seeScript = join(d, "see-detect.sh");
    writeFileSync(seeScript, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "args=\"$*\"",
      "case \"$args\" in",
      "  *\"--detect license plate\"*) ;;",
      "  *) echo \"missing detect args: $args\" >&2; exit 9 ;;",
      "esac",
      "printf '{\"verb\":\"see\",\"state\":\"ready\",\"payload\":{\"args\":%s}}\\n' \"$(printf '%s' \"$args\" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')\"",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", seeScript]);
    const setup = emptySetup("auto-see-detect");
    setup.completed = true;
    setup.automation = { auto_sense: ["see"], auto_index_new: false };
    setup.providers = {
      see: {
        verb: "see",
        choice: "owl-local",
        descriptor: { type: "exec", run: `bash ${seeScript} {{input}}` },
      },
    };
    saveSetup(c, setup);

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile: defaultProfile() });
    const see = recs.find((r) => r.verb === "see")!;
    assert.equal(see.state, "ready");
    assert.match((see.payload as Record<string, unknown>).args as string, /--detect license plate/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("scan auto-sense see does not use stale case owl-local policy with a profile see binding", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-scan-auto-see-profile-"));
  try {
    const c = openCase(d);
    c.ensure();
    addSource(c, "fixture:pier9");
    addTarget(c, "license plate");
    const setup = emptySetup("auto-see-profile");
    setup.completed = true;
    setup.automation = { auto_sense: ["see"], auto_index_new: false };
    setup.providers = {
      see: {
        verb: "see",
        choice: "owl-local",
        descriptor: { type: "exec", run: "python3 /tmp/stale/detect.py {{input}}" },
      },
    };
    saveSetup(c, setup);

    const seeScript = join(d, "see-profile.sh");
    writeFileSync(seeScript, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "args=\"$*\"",
      "case \"$args\" in",
      "  *\"--detect\"*) echo \"unexpected detect args: $args\" >&2; exit 9 ;;",
      "esac",
      "printf '{\"verb\":\"see\",\"state\":\"ready\",\"payload\":{\"args\":%s}}\\n' \"$(printf '%s' \"$args\" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')\"",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", seeScript]);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, see: { type: "exec", run: `bash ${seeScript} {{input}}` } };

    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile });
    const see = recs.find((r) => r.verb === "see")!;
    assert.equal(see.state, "ready");
    assert.doesNotMatch((see.payload as Record<string, unknown>).args as string, /--detect/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor --once diffs the seen-set: new items first pass, none second", async () => {
  // fresh case so seen.json starts empty
  const d2 = mkdtempSync(join(tmpdir(), "oc-mon-"));
  try {
    const c = openCase(d2);
    c.ensure();
    addSource(c, "fixture:pier9");
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };
    const mkCtx = (): VerbContext => ({ input: undefined, rest: [], opts: { once: true, pipe: "watch" }, case: openCase(d2), profile });

    const pass1 = await monitorVerb.run(mkCtx());
    const summary1 = pass1.find((r) => r.verb === "monitor")!;
    assert.equal((summary1.payload as Record<string, unknown>).new_items, 2);
    // captured + watched the new items
    assert.ok(pass1.some((r) => r.verb === "capture"));
    assert.ok(pass1.some((r) => r.verb === "watch"));

    const pass2 = await monitorVerb.run(mkCtx());
    const summary2 = pass2.find((r) => r.verb === "monitor")!;
    assert.equal((summary2.payload as Record<string, unknown>).new_items, 0);
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});

test("monitor surfaces a source enumerate error (not a silent 'nothing new')", async () => {
  const d3 = mkdtempSync(join(tmpdir(), "oc-monerr-"));
  try {
    const c = openCase(d3);
    c.ensure();
    // a source type with no provider → enumerateAll yields an error record
    addSource(c, "bogus:x");
    const profile = defaultProfile();
    const recs = await monitorVerb.run({ input: undefined, rest: [], opts: { once: true }, case: openCase(d3), profile });
    const summary = recs.find((r) => r.verb === "monitor")!;
    assert.equal(summary.state, "error");
    assert.ok((summary.payload as Record<string, unknown>).source_errors);
    // the error record itself is surfaced, not swallowed
    assert.ok(recs.some((r) => r.state === "error" && r !== summary));
  } finally {
    rmSync(d3, { recursive: true, force: true });
  }
});

test("capture rejects an unresolved ref instead of shipping it to yt-dlp", async () => {
  const [rec] = await captureVerb.run(ctx({}, "scan_doesnotexist"));
  assert.equal(rec.state, "error");
  assert.match(rec.error ?? "", /could not resolve ref/);
});

import { parseInterval } from "../../src/verbs/osint.ts";

test("parseInterval parses s/m/h/d cadences", () => {
  assert.equal(parseInterval("30s"), 30_000);
  assert.equal(parseInterval("15m"), 900_000);
  assert.equal(parseInterval("6h"), 21_600_000);
  assert.equal(parseInterval("1d"), 86_400_000);
  assert.equal(parseInterval("nope"), undefined);
});

test("monitor --every loops with seen-set diff across passes (capped)", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monloop-"));
  process.env.OVERCAST_MONITOR_MAX_PASSES = "2";
  try {
    const c = openCase(d); c.ensure();
    addSource(c, "fixture:x");
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${FAKE_WATCH} {{input}}` } };
    // the loop persists each pass's records to the case store; assert on those
    await monitorVerb.run({ input: undefined, rest: [], opts: { every: "1s", pipe: "watch" }, case: openCase(d), profile });
    const summaries = openCase(d).records()
      .filter((r) => r.verb === "monitor")
      .map((r) => (r.payload as Record<string, unknown>).new_items);
    assert.equal(summaries.length, 2, "ran 2 passes");
    assert.equal(summaries[0], 2, "pass 1: 2 new");
    assert.equal(summaries[1], 0, "pass 2: 0 new (seen-set held across loop)");
  } finally {
    delete process.env.OVERCAST_MONITOR_MAX_PASSES;
    rmSync(d, { recursive: true, force: true });
  }
});

test("monitor --every redacts secrets in streamed stdout and alert files", async () => {
  const d = mkdtempSync(join(tmpdir(), "oc-monredact-"));
  process.env.OVERCAST_MONITOR_MAX_PASSES = "1";
  const secretWatch = join(d, "secret-watch.sh");
  const alertFile = join(d, "alerts.jsonl");
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  try {
    const c = openCase(d); c.ensure();
    addSource(c, "fixture:x");
    writeFileSync(secretWatch, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' '{\"verb\":\"watch\",\"state\":\"ready\",\"payload\":{\"content\":\"CLOUDGLUE_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\"}}'",
      "",
    ].join("\n"));
    execFileSync("chmod", ["755", secretWatch]);
    const profile = defaultProfile();
    profile.providers = { ...profile.providers, watch: { type: "exec", run: `bash ${secretWatch} {{input}}` } };
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    await monitorVerb.run({ input: undefined, rest: [], opts: { every: "1s", pipe: "watch", alert: alertFile }, case: openCase(d), profile });
    const stdout = chunks.join("");
    const alerts = readFileSync(alertFile, "utf8");
    assert.doesNotMatch(stdout, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(alerts, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(stdout, /CLOUDGLUE_API_KEY=\[REDACTED\]/);
    assert.match(alerts, /CLOUDGLUE_API_KEY=\[REDACTED\]/);
  } finally {
    process.stdout.write = originalWrite;
    delete process.env.OVERCAST_MONITOR_MAX_PASSES;
    rmSync(d, { recursive: true, force: true });
  }
});
