# overcast end-to-end tests

Two suites live here. Both drive the **real CLI surface** (not internal APIs);
the difference is whether they hit real backends.

| suite | command | backends | creds | needs clips |
|---|---|---|---|---|
| **offline** (`test/e2e/`) | `npm run test:e2e` | fixture providers (no network) | none | no |
| **live** (`test/e2e/live/`) | `npm run test:e2e:live` | real providers | from `.env` | yes |

Plus the unit tests (`npm test` → `test/unit/*.test.ts`), which exercise the
record-mapping/registry/provider logic offline with the fixtures in
`test/fixtures/`.

> **Default to the offline suite + unit tests in PRs/CI** — they're deterministic
> and need nothing. Run the **live** suite when you touch providers, the record
> contract, the CLI router, or the bun binary, to prove it end-to-end against real
> data. The live suite always builds and runs the **compiled bun binary** (or
> `node dist/...` via `OVERCAST_USE_NODE=1`), so it doubles as a distribution check.

## Quick start

```bash
npm test                 # unit tests (offline, no creds)
npm run test:e2e         # offline e2e (fixture providers)

cp .env.example .env     # fill in whatever keys/clips you have (all optional)
npm run test:e2e:live    # live real-data e2e (builds the bun binary, sources .env)

# a subset of cases (prefix match on the case filename):
bash test/e2e/live/run.sh 10 11 70   # just watch, listen, headless
```

## The live suite

### What it needs (all optional — anything missing → that case SKIPS, counted as pass)

- **Provider creds** — sourced from `.env` at the repo root. See
  [`.env.example`](../../.env.example) for the full list and where to get each
  (`CLOUDGLUE_API_KEY`, `HF_TOKEN`, `FAL_KEY`, `ELEVENLABS_API_KEY`,
  `TAVILY_API_KEY`/`BRAVE_API_KEY`, `APIFY_TOKEN`). Values are never printed — the
  banner only lists which key *names* are present.
- **Real media** — each a **full path** in `.env`; no file names are baked into
  the repo. Videos: `OC_VIDEO_VISUAL`, `OC_VIDEO_OBJECTS`, `OC_VIDEO_SMALL`,
  `OC_VIDEO_SPEECH`. Plus a standalone `OC_IMAGE` (for `see`) and `OC_AUDIO` (for
  `listen`) — if those are unset, `see`/`listen` fall back to a frame / audio
  extracted from the videos. Cases trim short, cached sub-clips with the system
  ffmpeg before hitting cloud backends, and SKIP any medium that's unset/missing.
- **Local detector (`see --detect`)** — `DETECT_PY` = a python with
  `torch`/`transformers`/`scipy`/`pillow` (OWLv2). If unset, the case probes
  `python3`/`python` and skips when the deps are missing.
- **Visual DBs / DeepFace / CLIP** — `OC_VISUAL_DB_PY` points at the
  uv-managed Python from `scripts/visual-db-uv.sh --all` (image + face + CLIP).
  Optional real-data fixtures: `OC_LOCAL_IMAGE_REF`, `OC_LOCAL_IMAGE_VIDEO_A`,
  `OC_LOCAL_IMAGE_VIDEO_B`, `OC_LOCAL_FACE_IMAGE`, `OC_LOCAL_FACE_VIDEO`,
  plus sampling knobs `OC_LOCAL_IMAGE_FPS`, `OC_LOCAL_FACE_FPS`,
  `OC_LOCAL_IMAGE_MAX_FRAMES`, and `OC_LOCAL_FACE_MAX_FRAMES`. The CLIP
  (`basic-clip`) case is self-sufficient: it derives its fixtures from
  `OC_VIDEO_OBJECTS`/`OC_VIDEO_SMALL` (ffmpeg clips + frames) and captions a
  frame with `see` for the text queries; `OC_CLIP_VIDEO`/`OC_CLIP_IMAGE_REF`/
  `OC_CLIP_TEXT` override, and `OC_CLIP_MODEL`/`OC_CLIP_PRETRAINED`/
  `OC_CLIP_DEVICE` pick the model.
- **bun** — to compile the binary (`npm run build:bun`). Set `OVERCAST_USE_NODE=1`
  to run `node dist/bin/overcast.js` instead.

### Cases (`test/e2e/live/cases/*.sh`, run in order)

`00_cli` (version/commands/help + all env-var docs + doctor) · `10_watch` ·
`11_listen` (Cloudglue + ElevenLabs) · `12_see` (HF + fal + Cloudglue tinycloud
see/extract ≥ 0.3.7 + local OWLv2) ·
`13_enhance_view` · `14_face` (real tinycloud face detect + `--match`) ·
`15_crop` (materialize real detections as JPEGs) · `20_sources`
(Tavily web / Serper `dork` / `shodan` / Apify tiktok·x·lens·yandeximg·instagram·
telegram·identity / yt-dlp youtube, plus the keyless map/OSINT feeds
gdelttv·dispatch·overpass·wayback·flights and the FIRMS_MAP_KEY-gated firms —
each source's mapped-record contract asserted: top-level `payload.gps` for
dispatch/overpass/firms/flights, snapshot URLs newest-first for wayback,
per-row/element deep-link `media.ref` throughout) · `21_pipeline`
(source→capture→sense) · `26_x_copycat` (x keyword text search + user-scoped
video capture from the CDN + headless agent x sweep + headless
overcast-copycat-sweep skill invocation with brief HTML export) ·
`27_copycat_local` (copycat detection CORE, no source/API: fingerprint a local
original, CONFIRM a synthesized reskin through the geometry gate, REJECT an
unrelated clip, showcase a brief with the embedded match overlay) ·
`22_monitor` (`--once` diff + bounded `--every`) ·
`23_index` · `24_case_search` · `16_visual_db` (local image-ransac,
`face:deepface-local`, and deepface-local with real media) · `17_clip_db`
(local basic-clip CLIP DB with real media: fixtures derived from real videos,
caption-driven queries, all four cross-modal modes — text×video, image×video,
image×image, text×image — a headless-agent `similar search` leg, and a
self-contained HTML evidence page `clip_db_evidence.html`) · `17_face_cluster`
(local face-cluster DB with real media: wizard-provisioned index, `cluster add`
ingest → assign-or-create, `recluster`, held-out `identify`, gallery `view`) ·
`25_case_setup` (real-media setup save/edit; setup history stays
operational-only) · `35_archive` (global archive with real media: bucket
init/add/sha-dedup, `ask --archive` + `capture archive:…` from a SECOND case
sharing the home, the archive setup wizard standing up a bucket image-ransac
index + backfill, a cross-case `image match --index archive:<bucket>/<index>`
RANSAC hit, a bucket voice-print enroll + cross-case `voice match --index
archive:…` (gated on `OC_VOICE_E2E`), `watch archive:…` in place via Cloudglue, and two headless-agent
legs where the agent drives the archive TOOL — list + a tag-stamped add —
verified via the CLI afterwards; media legs reuse `OC_VIDEO_SMALL`/`OC_IMAGE`
or the `OC_ARCHIVE_VIDEO`/`OC_ARCHIVE_IMAGE` overrides) · `30_read`
(ask/brief over real records) · `31_visualization` (CSI status/brief/records
exports with real visual targets and matches) · `32_headless_visualization`
(headless agent `--mode json` export trace, default CSI HTML theme) · `33_wall`
(control-room wall over real watch/face evidence: finding-anchored loop window,
FND chip, CSI markers, plus the `--infinite` endless wall from the same case) ·
`34_graph` (case knowledge graph over real watch/listen evidence: nodes/edges/
finding→source provenance, harvested tipster entity, `--focus` narrowing with a
real island feed, self-contained HTML, and the `--extract` live-brain pass with
extraction stats + caveat + cache round-trip) ·
`34_forensics` (real `exif` metadata/GPS/serial/lens + `verify` C2PA via system
exiftool/c2patool, then GPS made actionable — `map` online OSM-tile + `--offline`
scatter, opt-in live Nominatim `exif --geocode` place lookup, and `devices`
camera-fingerprint correlation; a geotagged `OC_EXIF_IMAGE` unlocks the GPS legs,
`OC_EXIF_IMAGE_2` a same-camera serial cluster) ·
`38_screenshot` (real browser screen capture via the shipped Playwright engine:
`screenshot <url>` + `--full-page` + a local `.html` export to PNG, the SSRF
loopback-refusal guard, and the `browser:` source `scan --pull` page render;
gated on the playwright optional dep + Chromium, `OC_SCREENSHOT_URL` overrides
the target) ·
`40_profiles` · `50_piping` (jq / chaining) · `60_dist`
(binary as artifact) · `70_headless` (agent `--mode json` event stream + `-p`
tool use + watch/persist).

The **findings / local-DB / split-op cases** fill in the middle of the range:
`18_findings` (real `face --match` clears the threshold → an auto-`suggested`
finding quarantined from evidence, then the triage queue, `accept` →
corroborated/citable, a `thread:` narrative note on the mission-board line card, a
dead-end line, and the short brief + `--full`; Cloudglue-gated) · `18_grid` (the
`grid` contact-sheet trick — pure-ffmpeg tiling + the hardened variations
(collision/blank-pad/`--at`/past-duration/audio reject), then a Cloudglue-gated
frame-grid CoT loop: see the montage → cell→timestamp → `see frame://` verify) ·
`18_separate` (`enhance --ops separate` → per-speaker tracks via fal sam-audio
(FAL_KEY) and/or local pyannote, the one-record-per-track fan-out + `--summarize`)
· `19_segment` (`enhance --ops segment` → text-prompted mask + cutout evidence via
fal sam-3 and/or local GroundingDINO+SAM2, the per-instance fan-out + `crop`
interop on the parent) · `28_audio_match_local` (the Shazam-style `audio-fp`
fingerprint CORE, no creds — synth FM-chirp original into an index, then a
transcoded+noised+clipped copy confirms at the right offset + an unrelated chirp is
rejected, indexed AND clip-to-clip; ffmpeg + numpy/scipy) · `29_clap_db` (the
local `basic-clap` CLAP DB — audio→audio + text→audio, HARD-GATED on `OC_CLAP_E2E=1`
for the ~776MB weights) · `30_audio_match_realmedia` (fingerprinting a REAL video
(OC_VIDEO_SPEECH) — self-location, transcode robustness, `--min-margin` speed-drift
rejection, and a different-video negative) · `36_voice_match` (the local
`voice-print` speaker-verification DB — enroll two speakers → same-speaker search →
pairwise locate in a B-then-A concat; `say`/`OC_VOICE_*` fixtures, HARD-GATED on
`OC_VOICE_E2E=1`, `--diarize` leg needs HF_TOKEN) · `37_voice_match_realmedia`
(cross-segment speaker identity on a real single-speaker video — matches other
non-overlapping segments, triggers across the clip, rejects a different speaker) ·
`38_reconstruct` (real fal `reconstruct` — reposition + sweep + depth, the
`outputs[]` fan-out + non-negotiable caveat + viewer routing; the `--ops model` 3D
mesh lift gated on `OC_RECONSTRUCT_3D_E2E=1`).

**Skill workflow cases (`80`–`89`)** — one per shipped CSI/crime-trope skill,
each driving the skill's documented `overcast … --json` command chain against real
media and asserting on the emitted records + saving the skill's artifact (brief /
gallery / wall HTML) into the run dir:
`80_skill_lineup` (face-cluster DB → gallery → held-out `identify` → cited finding)
· `81_skill_stakeout` (standing scope + real feed + CSI monitor wall + Apify
`monitor --once` source tier) · `82_skill_scene_locate` (`see --ocr/--prompt`
clues → lens reverse-image + web corroboration) · `83_skill_enhance_resolve`
(ffmpeg enhance → re-read the enhanced frame with `see --ocr` → provenance finding,
+ optional fal restoration leg) · `84_skill_wiretap` (`listen --diarize/--describe`
+ `view --spectrogram` + `enhance voice-isolate` → re-listen → cross-clip `ask`) ·
`85_skill_provenance` (fingerprint a mark → lens/web sweep with no recency floor →
CONFIRM a synthesized suspect through the geometry gate, REJECT an unrelated clip)
· `86_skill_timeline` (multi-clip `watch`/`listen` → span-note anchors → ordering
`ask` → chronological brief) · `87_skill_crime_board` (`face --thumbnails` → `crop`
cards → `cluster` person links → `similar` CLIP theme links → CSI brief + wall).
Then the **agentic** cases: `88_skill_agent` (a real headless pi agent —
`overcast --mode json` — LOADS a vended skill from its `SKILL.md` and executes a
bounded slice against real media; asserts on the persisted records + the JSONL
tool-call trace) and `89_skill_claude` (loads a skill into the real `claude` CLI
headless and lets Claude drive the overcast binary; **opt-in** behind
`OC_E2E_CLAUDE=1`). `90_skill_variations` runs the same real input through
different modes/flags and asserts the outputs actually DIFFER — `listen` plain vs
`--describe` (adds an audio-scene field, or an audio-only fallback warning) vs
`--diarize` (speaker labels); `see --ocr` vs `--prompt`; `brief --theme plain` vs
`csi` — saving every raw output for inspection. `91_skill_scanner` drives the
`overcast-scanner` chain against the REAL keyless SF Socrata CAD feed (source add
`dispatch:sf` → line of investigation → live scan → `monitor --once` dedup pass →
csi `map` export with the call coordinates → finding stamped onto the line;
skips cleanly if the rolling window is empty). `92_skill_connect_dots` drives
`overcast-connect-the-dots` with no creds at all (notes sharing an email/handle →
finding on the line → `graph --theme csi` board asserting entity harvest + thread
edges in the HTML → 2-hop `--focus` view on the shared email).

The **offline suite** (`test/e2e/cases/phase*.sh`, run by `npm run test:e2e`)
exercises the same CLI surface with fixture providers; the notes below
**highlight the notable cases rather than list every one** — the full set lives
in `test/e2e/cases/`. It runs the core senses over a generated clip
(`phase2_senses`), the speculative `reconstruct` `outputs[]` fan-out + evidence
quarantine via a fixture provider (`phase2_reconstruct`), the OSINT round-trip
over a committed fixture source — `prebrief` → target/source → `scan --pull` →
`monitor --once` diff (`phase3_osint`), the example providers' `describe` +
profile-resolution contract (`phase8_providers`), and headless browser capture +
the SSRF loopback guard via the fixture engine (`phase9_screenshot`).

It also covers setup management (`phase4_setup`): `case setup
plan`, apply with target/note/source, `show`, `edit`, saved `.overcast/setup.json`,
and exclusion of setup history records from memory — plus the control-room wall
(`phase6_wall`): empty-case pending guidance, then a themed wall over seeded
case media and the `--infinite` endless-wall record + page marker — plus the
case knowledge graph (`phase6_graph`): empty-case pending guidance, then
nodes/edges over seeded note/target/finding evidence (regex-harvested email
entity, finding→source edge), `--focus` narrowing (an island note must drop
out), focus-miss pending guidance, and a self-contained HTML viewer with no
external assets — plus the live monitoring page (`phase6_situation`):
`situation status` on an empty case → not-running, then a BACKGROUNDED
token-authed `serve` on an ephemeral port (discovered via `runtime.json`), the
`/api/state` auth boundary (401 without the token, 200 + JSON snapshot with it) +
the static console shell, a cross-process `situation set` the running server
consumes (`control.json` swept on its ~2s tick), and a graceful `situation stop`
that exits the serving process + sweeps `runtime.json` — plus the
global archive (`phase9_archive`): bucket init/add/dedup/show under an isolated
`OVERCAST_HOME`, `capture archive:…` pulls, `ask --archive`, the setup wizard
plan/apply with a local index + backfill, and the doctor bucket check; and
`phase9_archiveagent` (self-skips without a Cloudglue key, like `phase1_agent`):
the headless agent drives the archive TOOL — listing buckets and archiving a
file with a tag — verified deterministically via `archive show` afterwards.

### Output

Each run writes to `./.dev/smoke/live-<UTC>/` (gitignored): `report.md` (summary
table + a **Detailed checks** section per assertion with the *condition under
test*, the *exact command*, and an *output snippet*), plus raw JSON. The run exits
non-zero if any case fails.

### Runner knobs

`OVERCAST_USE_NODE=1` (node instead of bun) · `SKIP_BUILD=1` (reuse `dist/`) ·
`OC_TIMEOUT=<secs>` (per-command timeout, default 300) · `OC_E2E_CLAUDE=1` (opt in
to `89_skill_claude`, which drives the real `claude` CLI headless — spends Claude
credit + uses the machine's Claude auth + runs Bash headless).

## Man in the chair (`/chair`) — manual smoke

The remote-drive bridge (`/chair`, see [flow 20](../../docs/flows.md)) isn't in
the CLI e2e suites: it's an **interactive TUI feature + a network/browser
client**, so there's no headless CLI case for it. Its automated coverage is the
unit tests — `test/unit/chair-{bridge,extension,glance,qr,net}.test.ts` (auth,
SSE replay/dedupe, prompt routing, reload/token lifecycle, case glance, the
vendored QR encoder). The browser console's DOM logic is checked with throwaway
`document`/`EventSource`/`fetch` shims during development, not in the committed
suite (no in-repo DOM harness).

To exercise it end-to-end by hand:

**Local, no phone** — launch the TUI with the bridge on a known token/port, then
drive it with `curl` from a second terminal (needs a real terminal — don't pipe
stdin):

```bash
OVERCAST_CHAIR_TOKEN=testtoken123 OVERCAST_CHAIR_PORT=7373 npm run dev -- --chair
# second terminal:
T='Authorization: Bearer testtoken123'; B=http://127.0.0.1:7373
curl -s -H "$T" $B/api/state | jq                       # snapshot (case/model/busy/transcript)
curl -s -o/dev/null -w '%{http_code}\n' $B/api/state    # 401 without the token
curl -s -X POST -H "$T" -H 'Content-Type: application/json' \
  -d '{"text":"say PINEAPPLE"}' $B/api/prompt            # inject → lands as a [chair] msg in the TUI
curl -N "$B/events?token=testtoken123"                  # live SSE stream (Ctrl-C to stop)
```

Or open the console in a browser at `http://127.0.0.1:7373/#t=testtoken123`
(the token rides in the `#fragment`) and use send / steer-follow-up / ABORT /
case-drawer. Verify the token never leaks: `grep -r testtoken123 ~/.pi
.overcast` should find nothing (it lives only in the QR fragment + browser).

**Phone / tailnet** — the real path: `/chair on tailnet` in the TUI, scan the QR
from a phone on the same Tailscale tailnet. No tailnet → bare `/chair on`
(localhost) + `ssh -L 7373:127.0.0.1:7373 …` from a phone SSH client. Console
dev loop: `npm run dev:web` (Vite, proxies `/api`+`/events` to a running chair).

**Binary** — `npm run build:bun` then `dist/bin/overcast --chair` should serve
the real Vite console (not the inline fallback) from its sidecar
`assets/chair-console/`.

## Adding a live case

1. Create `test/e2e/live/cases/NN_name.sh`; first lines:
   ```bash
   LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
   C=myverb
   ```
2. **Gate** on what you need so it stays green without creds/clips:
   `require_cred "$C" SOME_KEY "skipping"` and `have_media "$VIDEO_VISUAL"`.
3. Use the helpers from `lib.sh`: `cond "<what's under test>"`, then
   `out="$(oc "$CASE" <verb> … --json)"` (captures cmd+output for the report),
   then `assert_eq`/`assert_nonempty`/`ok`/`fail`. Run the CLI inside a per-case
   dir via `oc`/`ocrun` (each gets its own `--home`, so cases don't leak profiles).
4. Keep cloud calls cheap: `clip_av <secs> <src> <dst>` / `frame_jpg <src> <sec> <dst>`.
5. Run shellcheck — CI gates on it: `shellcheck -S warning test/e2e/live/cases/NN_name.sh`.
