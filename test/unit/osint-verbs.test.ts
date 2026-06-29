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
import { addSource } from "../../src/state/source.ts";
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

test("scan auto-sense see passes case targets as local-detect labels", async () => {
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
        choice: "local-detect",
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
