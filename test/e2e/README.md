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
(Tavily/Apify/yt-dlp) · `21_pipeline`
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
operational-only) · `30_read`
(ask/brief over real records) · `31_visualization` (CSI status/brief/records
exports with real visual targets and matches) · `32_headless_visualization`
(headless agent `--mode json` export trace, default CSI HTML theme) · `33_wall`
(control-room wall over real watch/face evidence: finding-anchored loop window,
FND chip, CSI markers, plus the `--infinite` endless wall from the same case) ·
`40_profiles` · `50_piping` (jq / chaining) · `60_dist`
(binary as artifact) · `70_headless` (agent `--mode json` event stream + `-p`
tool use + watch/persist).

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
`OC_E2E_CLAUDE=1`).

The offline suite also covers setup management (`phase4_setup`): `case setup
plan`, apply with target/note/source, `show`, `edit`, saved `.overcast/setup.json`,
and exclusion of setup history records from memory — plus the control-room wall
(`phase6_wall`): empty-case pending guidance, then a themed wall over seeded
case media and the `--infinite` endless-wall record + page marker.

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
