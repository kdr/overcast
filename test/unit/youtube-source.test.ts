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
  enumerateSource,
  fetchSource,
} from "../../src/providers/sources/index.ts";
import { captureVerb, scanVerb } from "../../src/verbs/osint.ts";
import { openCase } from "../../src/case.ts";
import { defaultProfile } from "../../src/profile.ts";
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
    ;;
  flat_videos)
    printf '%s\\n' '{"id":"vid1","title":"Video One","url":"https://youtu.be/vid1","uploader":"Acme","view_count":5,"duration":60}'
    ;;
  subs|subs_none|subs_429)
    printf '%s' '{"title":"Clip Title","description":"Full description text","upload_date":"20260101","uploader":"Acme","duration":65,"view_count":9,"subtitles":{"en":[{"ext":"vtt"}]}}' > "$out.info.json"
    if [ "$FAKE_MODE" != "subs_none" ]; then
      printf 'WEBVTT\\nKind: captions\\nLanguage: en\\n\\n00:00:00.000 --> 00:00:01.000\\nhello world\\n\\n00:00:01.000 --> 00:00:02.000\\nhello world\\n\\n00:00:02.000 --> 00:00:03.000\\n<c>second</c> line\\n' > "$out.en.vtt"
      printf 'WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\norig variant\\n' > "$out.en-orig.vtt"
    fi
    ;;
  thumb) printf 'JPG' > "$out.jpg" ;;
  *) : ;;
esac
# subs_429: the primary track + metadata landed, then a later subtitle-variant
# request was rate-limited → yt-dlp exits nonzero despite usable output
[ "$FAKE_MODE" = "subs_429" ] && exit 1
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
    assert.equal(hits.length, 2);
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
    assert.equal(p.transcript, "hello world\nsecond line");
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
    assert.equal(p.transcript, "hello world\nsecond line");
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
