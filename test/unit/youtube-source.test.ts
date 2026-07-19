// Unit coverage for the `youtube` source's metadata-without-download surface:
// playlists-TAB enumeration (`youtube:playlists:@handle` → one hit per playlist,
// each carrying a ready `playlist_ref`), `--limit 0` = uncapped (no
// --playlist-end), and the fetch kinds `transcript` / `thumb` that replace the
// video download (captions + metadata / thumbnail image). yt-dlp itself is
// faked with a PATH shim that logs its argv and fabricates the sidecar files,
// so the REAL youtube.sh runs offline: ref→target mapping, sub-variant
// selection, VTT→text compaction, and the uncaptioned metadata-only fallback
// are all exercised end-to-end through enumerateSource/fetchSource — including
// the payload-extras ride-along at the capture mapping boundary (canonical
// keys must win over provider-reported ones).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinDescriptor,
  enumerateBudgetMs,
  enumerateSource,
  fetchSource,
  UNCAPPED_ENUMERATE_TIMEOUT_MS,
} from "../../src/providers/sources/index.ts";
import { captureVerb, scanVerb } from "../../src/verbs/osint.ts";
import { addSource } from "../../src/state/source.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
import { emptySetup } from "../../src/state/setup.ts";
import { makeRecord } from "../../src/record.ts";
import { indexableDocument } from "../../src/providers/memory/fields.ts";
import type { VerbContext } from "../../src/registry/verbs.ts";

/** A fake `yt-dlp` on PATH: logs its argv to FAKE_LOG and fabricates output /
 *  sidecar files per FAKE_MODE, so the real youtube.sh logic runs offline. */
const SHIM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
case "$FAKE_MODE" in
  flat_playlists)
    printf '%s\\n' '{"_type":"url","id":"PL111","title":"Trips","url":"https://www.youtube.com/playlist?list=PL111","uploader":"Acme","thumbnails":[{"url":"https://i.ytimg.com/p1.jpg"}]}'
    printf '%s\\n' '{"_type":"url","id":"PL222","title":"Builds","url":"https://www.youtube.com/playlist?list=PL222","uploader":"Acme"}'
    printf '%s\\n' '{"_type":"url","id":"PL333","title":"NoUrl","uploader":"Acme"}'
    ;;
  flat_videos|flat_videos_101)
    printf '%s\\n' '{"id":"vid1","title":"Video One","url":"https://youtu.be/vid1","uploader":"Acme","view_count":5,"duration":60}'
    ;;
  video) printf 'MP4' > "$out" ;;
  subs|subs_none|subs_429|subs_429_none|subs_orig_only|subs_fr_only)
    printf '%s' '{"title":"Clip Title","description":"Full description text","upload_date":"20260101","uploader":"Acme","duration":65,"view_count":9,"subtitles":{"en":[{"ext":"vtt"}]}}' > "$out.info.json"
    if [ "$FAKE_MODE" = "subs" ] || [ "$FAKE_MODE" = "subs_429" ]; then
      # numeric cue IDENTIFIERS (1, 2 — the 2 with a CRLF ending) precede their
      # timing lines and must drop; "12:30 lunch launch" (spoken time) and
      # "2026" (digit-only caption) are caption text and must survive
      printf 'WEBVTT\\nKind: captions\\nLanguage: en\\n\\n1\\n00:00:00.000 --> 00:00:01.000\\nhello world\\n\\n2\\r\\n00:00:01.000 --> 00:00:02.000\\nhello world\\n\\n00:00:02.000 --> 00:00:03.000\\n<c>second</c> line\\n\\n00:00:02.500 --> 00:00:02.900\\n<<b>b>interleaved<</i>i> tags\\n\\n00:00:02.900 --> 00:00:02.950\\nx < y stays\\n\\n00:00:03.000 --> 00:00:04.000\\n12:30 lunch launch\\n\\n00:00:04.000 --> 00:00:05.000\\n2026\\n' > "$out.en.vtt"
      printf 'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\norig variant\\n' > "$out.en-orig.vtt"
    fi
    if [ "$FAKE_MODE" = "subs_orig_only" ]; then
      printf 'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\norig only track\\n' > "$out.en-orig.vtt"
    fi
    if [ "$FAKE_MODE" = "subs_fr_only" ]; then
      printf 'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nbonjour tout le monde\\n' > "$out.fr.vtt"
    fi
    ;;
  thumb) printf 'JPG' > "$out.jpg" ;;
  *) : ;;
esac
# subs_429: the primary track + metadata landed, then a later subtitle-variant
# request was rate-limited → yt-dlp exits nonzero despite usable output.
# subs_429_none: EVERY subtitle request was rate-limited (metadata only).
case "$FAKE_MODE" in subs_429|subs_429_none) exit 1 ;; flat_videos_101) exit 101 ;; esac
exit 0
`;

function shimEnv(dir: string, mode: string): { env: NodeJS.ProcessEnv; log: string } {
  const bin = join(dir, "bin");
  const log = join(dir, "yt-dlp.log");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(join(bin, "yt-dlp"))) {
    writeFileSync(join(bin, "yt-dlp"), SHIM, { mode: 0o755 });
    chmodSync(join(bin, "yt-dlp"), 0o755);
  }
  writeFileSync(log, "");
  return {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_LOG: log },
    log,
  };
}

// ---- playlists-tab enumeration ------------------------------------------------

test("youtube playlists:@handle enumerates the playlists TAB: one hit per playlist with a ready playlist_ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env, log } = shimEnv(dir, "flat_playlists");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const hits = await enumerateSource(desc!, { query: "playlists:@acme", limit: 3, env });
    assert.equal(hits.length, 3);
    // a url-less playlists-tab entry falls back to a PLAYLIST url, never youtu.be/<playlist_id>
    const noUrl = hits[2].payload as Record<string, unknown>;
    assert.equal(noUrl.url, "https://www.youtube.com/playlist?list=PL333");
    assert.equal(hits[2].media?.ref, "https://www.youtube.com/playlist?list=PL333");
    for (const h of hits) assert.equal(h.state, "ready");
    const p0 = hits[0].payload as Record<string, unknown>;
    assert.equal(p0.title, "Trips");
    assert.equal(p0.kind, "playlist"); // extras ride through hitsToRecords
    assert.equal(p0.playlist_id, "PL111");
    assert.equal(p0.playlist_ref, "youtube:playlist:PL111");
    assert.equal(hits[0].media?.ref, "https://www.youtube.com/playlist?list=PL111");
    assert.equal(p0.thumb, "https://i.ytimg.com/p1.jpg");
    // the ref targeted the channel's /playlists tab, flat + capped
    const argv = readFileSync(log, "utf8");
    assert.match(argv, /--flat-playlist/);
    assert.match(argv, /--playlist-end 3/);
    assert.match(argv, /https:\/\/www\.youtube\.com\/@acme\/playlists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("youtube --limit 0 = uncapped: no --playlist-end for channels, ytsearchall for searches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env, log } = shimEnv(dir, "flat_videos");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const hits = await enumerateSource(desc!, { query: "@acme", limit: 0, env });
    assert.equal(hits.length, 1);
    assert.equal((hits[0].payload as Record<string, unknown>).title, "Video One");
    let argv = readFileSync(log, "utf8");
    assert.doesNotMatch(argv, /--playlist-end/);
    assert.match(argv, /https:\/\/www\.youtube\.com\/@acme\/videos/);
    // tab refs: shorts:@handle targets the shorts tab
    writeFileSync(log, "");
    await enumerateSource(desc!, { query: "shorts:@acme", limit: 5, env });
    argv = readFileSync(log, "utf8");
    assert.match(argv, /https:\/\/www\.youtube\.com\/@acme\/shorts/);
    // bare handles normalize like playlists: (shorts:acme == shorts:@acme)
    writeFileSync(log, "");
    await enumerateSource(desc!, { query: "streams:acme", limit: 5, env });
    argv = readFileSync(log, "utf8");
    assert.match(argv, /https:\/\/www\.youtube\.com\/@acme\/streams/);
    // a URL already ending with the tab must not double-append it
    writeFileSync(log, "");
    await enumerateSource(desc!, { query: "shorts:https://www.youtube.com/@acme/shorts/", limit: 5, env });
    argv = readFileSync(log, "utf8");
    assert.match(argv, /https:\/\/www\.youtube\.com\/@acme\/shorts/);
    assert.doesNotMatch(argv, /shorts\/shorts/);
    // search + limit 0 → ytsearchall
    writeFileSync(log, "");
    await enumerateSource(desc!, { query: "search:moon base", limit: 0, env });
    argv = readFileSync(log, "utf8");
    assert.match(argv, /ytsearchall:moon base/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fetch kinds: transcript / thumb ------------------------------------------

test("fetch --kind transcript: captions + metadata land in the capture payload, VTT is the artifact, no video download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env, log } = shimEnv(dir, "subs");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const rec = await fetchSource(desc!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      lang: "en",
      env,
    });
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.kind, "transcript");
    assert.equal(p.title, "Clip Title");
    assert.equal(p.description, "Full description text");
    assert.equal(p.published, "20260101");
    assert.equal(p.author, "Acme");
    assert.equal(p.duration, 65);
    // VTT compaction: cue timings/headers/karaoke tags stripped, consecutive
    // rolling duplicates collapsed
    assert.equal(p.transcript, "hello world\nsecond line\ninterleaved tags\nx < y stays\n12:30 lunch launch\n2026");
    assert.equal(p.transcript_lang, "en");
    assert.equal(p.transcript_source, "manual"); // info.json lists manual en subs
    // the exact-lang variant wins; the -orig variant is cleaned up
    assert.match(String(rec.media?.ref), /clip\.en\.vtt$/);
    assert.ok(existsSync(join(dir, "clip.en.vtt")));
    assert.ok(!existsSync(join(dir, "clip.en-orig.vtt")), "unchosen sub variant must be removed");
    assert.ok(!existsSync(join(dir, "clip.info.json")), "info.json is extracted then removed");
    // canonical capture keys win over provider-reported ones
    assert.equal(p.source, "youtube");
    assert.equal(p.url, "https://youtu.be/vid1");
    assert.match(String(p.capture_id), /^cap_/);
    // the wire carried the fetch kind + lang; no video format was requested
    const argv = readFileSync(log, "utf8");
    assert.match(argv, /--skip-download/);
    assert.doesNotMatch(argv, /best\[height/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch --kind transcript tolerates a nonzero yt-dlp exit when the track + metadata already landed (429 on a variant)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env } = shimEnv(dir, "subs_429");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const rec = await fetchSource(desc!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      lang: "en",
      env,
    });
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.kind, "transcript");
    assert.equal(p.transcript, "hello world\nsecond line\ninterleaved tags\nx < y stays\n12:30 lunch launch\n2026");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch --kind transcript on an uncaptioned video degrades to a ready metadata-only record (never an error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env } = shimEnv(dir, "subs_none");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const rec = await fetchSource(desc!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      env,
    });
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.kind, "meta");
    assert.equal(p.transcript, null);
    assert.match(String(p.transcript_note), /no captions/);
    assert.equal(p.title, "Clip Title");
    // the artifact is a small title+description text file, so the capture still
    // points at real on-disk evidence
    assert.match(String(rec.media?.ref), /clip\.txt$/);
    assert.match(readFileSync(join(dir, "clip.txt"), "utf8"), /Clip Title[\s\S]*Full description text/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch --kind thumb: thumbnail image only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env, log } = shimEnv(dir, "thumb");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const rec = await fetchSource(desc!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "thumb",
      env,
    });
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.kind, "image");
    assert.match(String(rec.media?.ref), /clip\.jpg$/);
    const argv = readFileSync(log, "utf8");
    assert.match(argv, /--write-thumbnail/);
    assert.match(argv, /--skip-download/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- verb-level flag gating ----------------------------------------------------

function vctx(dir: string, input: string | undefined, opts: VerbContext["opts"]): VerbContext {
  const c = openCase(dir);
  c.ensure();
  return { input, rest: [], opts, case: c, profile: defaultProfile(), home: dir, profileName: "default" } as VerbContext;
}

test("--transcript and --thumb are mutually exclusive on capture and scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-verb-"));
  try {
    const [cap] = await captureVerb.run(vctx(dir, "https://youtu.be/vid1", { transcript: true, thumb: true }));
    assert.equal(cap.state, "error");
    assert.match(cap.error ?? "", /mutually exclusive/);
    const scanRecs = await scanVerb.run(vctx(dir, undefined, { transcript: true, thumb: true }));
    assert.ok(scanRecs.some((r) => r.state === "error" && /mutually exclusive/.test(String(r.error ?? ""))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transcript capture's text is ask-searchable: description + transcript are in the capture field policy", () => {
  const rec = makeRecord({
    verb: "capture",
    format: "json",
    payload: {
      capture_id: "cap_x", path: "/m/x.en.vtt", kind: "transcript", source: "youtube",
      url: "https://youtu.be/v", title: "T", description: "About the moon", transcript: "hello buoyancy world",
    },
    media: { ref: "/m/x.en.vtt" },
    state: "ready",
  });
  const doc = indexableDocument(rec);
  assert.ok(doc, "a ready capture record must be indexable");
  const byPath = new Map(doc!.fields.map((f) => [f.path, f.text]));
  assert.equal(byPath.get("transcript"), "hello buoyancy world");
  assert.equal(byPath.get("description"), "About the moon");
});

test("scan --limit 0 is accepted (uncapped), not an invalid-limit error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-verb-"));
  try {
    const recs = await scanVerb.run(vctx(dir, undefined, { limit: 0 }));
    assert.ok(!recs.some((r) => /invalid --limit/.test(String(r.error ?? ""))), "limit 0 must not be rejected");
    // negative stays rejected
    const bad = await scanVerb.run(vctx(dir, undefined, { limit: -2 }));
    assert.ok(bad.some((r) => /invalid --limit/.test(String(r.error ?? ""))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- source capabilities: uncappedLimit + fetchKinds (manifest-declared) -------

test("capability flags come from the manifest: youtube (uncapped + fetch kinds), dl (uncapped), web (neither)", () => {
  const yt = builtinDescriptor("youtube");
  assert.ok(yt);
  assert.equal(yt!.uncappedLimit, true);
  assert.deepEqual(yt!.fetchKinds, ["transcript", "thumb"]);
  const dl = builtinDescriptor("dl");
  assert.ok(dl);
  assert.equal(dl!.uncappedLimit, true);
  assert.equal(dl!.fetchKinds, undefined);
  const web = builtinDescriptor("web");
  assert.ok(web);
  assert.equal(web!.uncappedLimit, undefined);
  assert.equal(web!.fetchKinds, undefined);
  // an env-override rebind keeps the built-in capabilities (command changes,
  // semantics don't)
  process.env.OVERCAST_SOURCE_YOUTUBE_CMD = "bash /tmp/custom-yt.sh";
  try {
    const rebound = builtinDescriptor("youtube");
    assert.equal(rebound!.uncappedLimit, true);
    assert.deepEqual(rebound!.fetchKinds, ["transcript", "thumb"]);
  } finally {
    delete process.env.OVERCAST_SOURCE_YOUTUBE_CMD;
  }
});

test("enumerate seam: --limit 0 is forwarded only to uncappedLimit sources; others get NO --limit (their default cap)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-seam-"));
  try {
    const log = join(dir, "args.log");
    // a logging fixture source: records its argv, returns zero hits
    const script = join(dir, "fixture.sh");
    writeFileSync(script, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho '[]'\n`, { mode: 0o755 });
    const base = ["bash", script];
    // no uncappedLimit → 0 is swallowed at the seam (provider default applies)
    writeFileSync(log, "");
    await enumerateSource({ type: "web", base }, { query: "q", limit: 0 });
    assert.doesNotMatch(readFileSync(log, "utf8"), /--limit/);
    // uncappedLimit → the 0 travels
    writeFileSync(log, "");
    await enumerateSource({ type: "web", base, uncappedLimit: true }, { query: "q", limit: 0 });
    assert.match(readFileSync(log, "utf8"), /--limit 0/);
    // a positive limit always travels
    writeFileSync(log, "");
    await enumerateSource({ type: "web", base }, { query: "q", limit: 7 });
    assert.match(readFileSync(log, "utf8"), /--limit 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- transcript_source reflects the CHOSEN track ------------------------------

test("fetch --kind transcript labels a surviving -orig track auto, even when info.json lists manual subs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env } = shimEnv(dir, "subs_orig_only");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const rec = await fetchSource(desc!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      lang: "en",
      env,
    });
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.transcript, "orig only track");
    assert.equal(p.transcript_source, "auto"); // the kept file is the auto -orig track
    assert.match(String(rec.media?.ref), /clip\.en-orig\.vtt$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- playlist container hits are not fetchable media --------------------------

test("youtube fetch refuses a playlist container URL at every kind (clean error, no yt-dlp spawn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env, log } = shimEnv(dir, "subs");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    for (const kind of [undefined, "transcript", "thumb"]) {
      const rec = await fetchSource(desc!, {
        url: "https://www.youtube.com/playlist?list=PL111",
        out: join(dir, "cap"),
        kind,
        env,
      });
      assert.equal(rec.state, "error");
      assert.match(String(rec.error), /playlist, not a video/);
    }
    assert.equal(readFileSync(log, "utf8"), "", "the guard must fire before yt-dlp is spawned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan --pull skips playlist container hits with a promote hint instead of fetching them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-pull-"));
  const prev = process.env.OVERCAST_SOURCE_YTFIX_CMD;
  try {
    // a fixture source whose one hit is a playlists-tab CONTAINER entry; its
    // fetch op fails loudly so any capture attempt turns the test red
    const script = join(dir, "ytfix.sh");
    writeFileSync(script, `#!/usr/bin/env bash
op="\${1:-enumerate}"; shift || true
case "$op" in
  enumerate) echo '[{"title":"Trips","url":"https://www.youtube.com/playlist?list=PL111","source":"ytfix","kind":"playlist","playlist_id":"PL111","playlist_ref":"youtube:playlist:PL111","media":{"ref":"https://www.youtube.com/playlist?list=PL111"}}]' ;;
  fetch) echo "container hit must not be fetched" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    process.env.OVERCAST_SOURCE_YTFIX_CMD = `bash ${script}`;
    const c = openCase(dir);
    c.ensure();
    addSource(c, "ytfix:@acme");
    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true }, case: c, profile: defaultProfile(), home: dir } as VerbContext);
    assert.ok(!recs.some((r) => r.verb === "capture"), "a container hit must never reach capture");
    assert.ok(!recs.some((r) => r.state === "error"), `no errors expected: ${recs.find((r) => r.state === "error")?.error}`);
    const skip = recs.find((r) => (r.payload as Record<string, unknown>)?.op === "pull_skip");
    assert.ok(skip, "expected a pull_skip record for the container hit");
    assert.match(String((skip!.payload as Record<string, unknown>).promote), /source add youtube:playlist:PL111/);
  } finally {
    if (prev == null) delete process.env.OVERCAST_SOURCE_YTFIX_CMD; else process.env.OVERCAST_SOURCE_YTFIX_CMD = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fetch-kind gating: only declaring sources serve --transcript/--thumb -----

test("explicit capture --transcript on a source without the fetch kind is an honest error, not a silent download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-verb-"));
  try {
    const [rec] = await captureVerb.run(vctx(dir, "https://example.org/page", { transcript: true }));
    assert.equal(rec.state, "error");
    assert.match(rec.error ?? "", /doesn't support --transcript/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- round-2 hardening: honest failures + artifact lifecycle + budgets --------

test("fetch --kind transcript FAILS when yt-dlp exits nonzero with no caption track (rate-limited != uncaptioned)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env } = shimEnv(dir, "subs_429_none");
    const desc = builtinDescriptor("youtube");
    assert.ok(desc);
    const rec = await fetchSource(desc!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      env,
    });
    assert.equal(rec.state, "error", "metadata-without-any-track on a failed run must NOT read as 'no captions'");
    assert.match(String(rec.error), /no caption track retrieved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed transcript RETRY leaves a prior successful capture's artifact untouched (scratch-dir lifecycle)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    // first capture succeeds → artifact at the stable per-URL out base
    const ok = await fetchSource(builtinDescriptor("youtube")!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      lang: "en",
      env: shimEnv(dir, "subs").env,
    });
    assert.equal(ok.state, "ready", ok.error);
    const artifact = String(ok.media?.ref);
    assert.ok(existsSync(artifact));
    // retry of the SAME url fails hard (no info.json) — the prior artifact must survive
    const retry = await fetchSource(builtinDescriptor("youtube")!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      lang: "en",
      env: shimEnv(dir, "none").env,
    });
    assert.equal(retry.state, "error");
    assert.ok(existsSync(artifact), "failed retry deleted the earlier capture's VTT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncapped (--limit 0) enumerates on declaring sources get the long exec budget; everyone else keeps defaults", () => {
  const base = ["bash", "x.sh"];
  const uncapped = { type: "youtube", base, uncappedLimit: true };
  const plain = { type: "web", base };
  assert.equal(enumerateBudgetMs(uncapped, { limit: 0 }), UNCAPPED_ENUMERATE_TIMEOUT_MS);
  assert.equal(enumerateBudgetMs(uncapped, { limit: 10 }), 2 * 60_000); // capped scans keep the tight default
  assert.equal(enumerateBudgetMs(plain, { limit: 0 }), 2 * 60_000);     // non-declaring sources never widen
  assert.equal(enumerateBudgetMs({ ...uncapped, timeoutMs: 5000 }, { limit: 0 }), 5000); // desc budget wins
  assert.equal(enumerateBudgetMs(uncapped, { limit: 0, timeoutMs: 1234 }), 1234);        // opts budget wins over all
});

test("scan --pull --thumb: the configured auto_sense chain does NOT fire on the substitute artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-thumbpull-"));
  const prev = process.env.OVERCAST_SOURCE_YOUTUBE_CMD;
  try {
    // youtube rebound to a fixture: one VIDEO hit; fetch demands --kind thumb
    // (proving the kind forwards through the pull path) and writes a jpg
    const script = join(dir, "ytthumb.sh");
    writeFileSync(script, `#!/usr/bin/env bash
op="\${1:-enumerate}"; shift || true
case "$op" in
  enumerate) echo '[{"title":"Vid","url":"https://youtu.be/v1","source":"youtube","media":{"ref":"https://youtu.be/v1"}}]' ;;
  fetch)
    out=""; kind=""; prev=""
    for a in "$@"; do
      [ "$prev" = "--out" ] && out="$a"
      [ "$prev" = "--kind" ] && kind="$a"
      prev="$a"
    done
    [ "$kind" = "thumb" ] || { echo "expected --kind thumb, got '$kind'" >&2; exit 1; }
    printf 'JPG' > "$out.jpg"
    printf '{"kind":"image","path":"%s.jpg","source":"youtube","url":"https://youtu.be/v1"}\\n' "$out"
    ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    process.env.OVERCAST_SOURCE_YOUTUBE_CMD = `bash ${script}`;
    const c = openCase(dir);
    c.ensure();
    addSource(c, "youtube:@acme");
    // a case configured to auto-watch pulled media — written for the source's
    // NORMAL video pulls, must not fire on a --thumb substitute jpg
    const setup = emptySetup("thumbpull");
    setup.automation = { auto_sense: ["watch"], auto_index_new: false };
    writeFileSync(c.setupFile, JSON.stringify(setup));
    const recs = await scanVerb.run({ input: undefined, rest: [], opts: { pull: true, thumb: true }, case: c, profile: defaultProfile(), home: dir } as VerbContext);
    const cap = recs.find((r) => r.verb === "capture");
    assert.ok(cap, "expected a thumb capture");
    assert.equal(cap!.state, "ready", cap!.error);
    assert.equal((cap!.payload as Record<string, unknown>).kind, "image");
    assert.ok(!recs.some((r) => r.verb === "watch"), "auto_sense watch must not run on a --thumb jpg");
    assert.ok(!recs.some((r) => r.state === "error"), `no errors expected: ${recs.find((r) => r.state === "error")?.error}`);
  } finally {
    if (prev == null) delete process.env.OVERCAST_SOURCE_YOUTUBE_CMD; else process.env.OVERCAST_SOURCE_YOUTUBE_CMD = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- round-4 hardening: mode-from-target, bounded recency, kept-track labels --

test("a RAW playlists-tab URL gets the same playlists-mode hits as the playlists: ref form", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env } = shimEnv(dir, "flat_playlists");
    const hits = await enumerateSource(builtinDescriptor("youtube")!, {
      query: "https://www.youtube.com/@acme/playlists",
      limit: 3,
      env,
    });
    assert.equal(hits.length, 3);
    const p0 = hits[0].payload as Record<string, unknown>;
    assert.equal(p0.kind, "playlist");
    assert.equal(p0.playlist_ref, "youtube:playlist:PL111");
    // a browser-copied URL with ?query params must not defeat the mode/suffix checks
    const hits2 = await enumerateSource(builtinDescriptor("youtube")!, {
      query: "playlists:https://www.youtube.com/@acme/playlists?view=1&sort=dd",
      limit: 3,
      env: shimEnv(dir, "flat_playlists").env,
    });
    assert.equal((hits2[0].payload as Record<string, unknown>).kind, "playlist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uncapped recency scans of channel tabs are bounded by --break-on-reject; exit 101 is the success path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    // the break applies to a channel-tab target with --since + --limit 0…
    const a = shimEnv(dir, "flat_videos_101");
    const hits = await enumerateSource(builtinDescriptor("youtube")!, { query: "@acme", limit: 0, since: "3d", env: a.env });
    assert.equal(hits.length, 1, "exit 101 (stopped at the date boundary) must not read as a failure");
    assert.equal(hits[0].state, "ready");
    let argv = readFileSync(a.log, "utf8");
    assert.match(argv, /--dateafter/);
    assert.match(argv, /--break-on-reject/);
    // …but never to a PLAYLIST (arbitrary order — an early break would truncate wrongly)
    const b = shimEnv(dir, "flat_videos");
    await enumerateSource(builtinDescriptor("youtube")!, { query: "playlist:PLX", limit: 0, since: "3d", env: b.env });
    argv = readFileSync(b.log, "utf8");
    assert.doesNotMatch(argv, /--break-on-reject/);
    // exit 101 WITHOUT our --break-on-reject (e.g. a global --max-downloads
    // config) is a TRUNCATED listing and must stay an enumerate error
    const c = shimEnv(dir, "flat_videos_101");
    const errHits = await enumerateSource(builtinDescriptor("youtube")!, { query: "@acme", limit: 5, env: c.env });
    assert.equal(errHits.length, 1);
    assert.equal(errHits[0].state, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript_lang reflects the KEPT track's language, not the requested one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env } = shimEnv(dir, "subs_fr_only");
    const rec = await fetchSource(builtinDescriptor("youtube")!, {
      url: "https://youtu.be/vid1",
      out: join(dir, "clip"),
      kind: "transcript",
      lang: "en",
      env,
    });
    assert.equal(rec.state, "ready", rec.error);
    const p = rec.payload as Record<string, unknown>;
    assert.equal(p.transcript, "bonjour tout le monde");
    assert.equal(p.transcript_lang, "fr"); // the ls-fallback kept the fr track
    assert.equal(p.transcript_source, "auto");
    assert.match(String(rec.media?.ref), /clip\.fr\.vtt$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default video fetch passes --no-playlist (a watch?v=…&list=… share link must not pull the whole list)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    const { env, log } = shimEnv(dir, "video");
    const rec = await fetchSource(builtinDescriptor("youtube")!, {
      url: "https://www.youtube.com/watch?v=vid1&list=PL111",
      out: join(dir, "cap1"),
      env,
    });
    assert.equal(rec.state, "ready", rec.error);
    assert.equal((rec.payload as Record<string, unknown>).kind, "video");
    assert.match(readFileSync(log, "utf8"), /--no-playlist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dl: uncapped recency scans of channel/user pages get --break-on-reject (101 = success); playlist URLs never do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-dl-"));
  try {
    const a = shimEnv(dir, "flat_videos_101");
    const hits = await enumerateSource(builtinDescriptor("dl")!, { query: "https://rumble.com/c/acme", limit: 0, since: "3d", env: a.env });
    assert.equal(hits.length, 1, "exit 101 at the date boundary is the success path");
    assert.equal(hits[0].state, "ready");
    let argv = readFileSync(a.log, "utf8");
    assert.match(argv, /--break-on-reject/);
    // playlist-shaped URLs are arbitrary-order — never bounded by the break
    const b = shimEnv(dir, "flat_videos");
    await enumerateSource(builtinDescriptor("dl")!, { query: "https://www.youtube.com/playlist?list=PLX", limit: 0, since: "3d", env: b.env });
    argv = readFileSync(b.log, "utf8");
    assert.doesNotMatch(argv, /--break-on-reject/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a raw channel-ROOT url normalizes to its /videos tab (parity with @handle: mode + recency bound apply)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-yt-"));
  try {
    // bare root (with browser query junk) → /videos tab + the uncapped recency bound
    const a = shimEnv(dir, "flat_videos");
    await enumerateSource(builtinDescriptor("youtube")!, {
      query: "https://www.youtube.com/@acme?si=xyz",
      limit: 0,
      since: "3d",
      env: a.env,
    });
    let argv = readFileSync(a.log, "utf8");
    assert.match(argv, /https:\/\/www\.youtube\.com\/@acme\/videos/);
    assert.match(argv, /--break-on-reject/);
    // a watch url and an existing tab url pass through untouched
    const b = shimEnv(dir, "flat_videos");
    await enumerateSource(builtinDescriptor("youtube")!, { query: "https://www.youtube.com/watch?v=abc", limit: 5, env: b.env });
    argv = readFileSync(b.log, "utf8");
    assert.match(argv, /watch\?v=abc/);
    assert.doesNotMatch(argv, /watch\?v=abc\/videos/);
    const c = shimEnv(dir, "flat_videos");
    await enumerateSource(builtinDescriptor("youtube")!, { query: "https://www.youtube.com/@acme/shorts", limit: 5, env: c.env });
    argv = readFileSync(c.log, "utf8");
    assert.doesNotMatch(argv, /shorts\/videos/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
