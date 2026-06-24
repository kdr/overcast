import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { scanVerb, captureVerb, monitorVerb } from "../../src/verbs/osint.ts";
import { addSource } from "../../src/state/source.ts";
import { FFMPEG_PATH } from "../../src/media/ffmpeg.ts";
import type { VerbContext } from "../../src/registry/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SOURCE = join(HERE, "..", "fixtures", "fake-source.sh");
const FAKE_WATCH = join(HERE, "..", "fixtures", "fake-watch.sh");

let dir: string;
let clip: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-osintv-"));
  clip = join(dir, "src.mp4");
  execFileSync(
    FFMPEG_PATH,
    ["-y", "-f", "lavfi", "-i", "testsrc=size=96x72:rate=10:duration=1", "-pix_fmt", "yuv420p", clip],
    { stdio: "ignore" },
  );
  // wire the fixture source provider + the clip it points at
  process.env.OVERCAST_SOURCE_FIXTURE_CMD = `bash ${FAKE_SOURCE}`;
  process.env.OVERCAST_FIXTURE_CLIP = clip;
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OVERCAST_SOURCE_FIXTURE_CMD;
  delete process.env.OVERCAST_FIXTURE_CLIP;
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

test("capture copies a local media ref into the case store", async () => {
  const [rec] = await captureVerb.run(ctx({}, clip));
  assert.equal(rec.verb, "capture");
  assert.equal(rec.state, "ready");
  assert.ok(existsSync(rec.media!.ref));
  assert.match((rec.payload as Record<string, unknown>).path as string, /\.overcast\/media\//);
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
