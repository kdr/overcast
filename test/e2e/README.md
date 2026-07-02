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
- **Visual DBs / DeepFace** — `OC_VISUAL_DB_PY` points at the
  uv-managed Python from `scripts/visual-db-uv.sh --face`. Optional real-data
  fixtures: `OC_LOCAL_IMAGE_REF`, `OC_LOCAL_IMAGE_VIDEO_A`,
  `OC_LOCAL_IMAGE_VIDEO_B`, `OC_LOCAL_FACE_IMAGE`, `OC_LOCAL_FACE_VIDEO`,
  plus sampling knobs `OC_LOCAL_IMAGE_FPS`, `OC_LOCAL_FACE_FPS`,
  `OC_LOCAL_IMAGE_MAX_FRAMES`, and `OC_LOCAL_FACE_MAX_FRAMES`.
- **bun** — to compile the binary (`npm run build:bun`). Set `OVERCAST_USE_NODE=1`
  to run `node dist/bin/overcast.js` instead.

### Cases (`test/e2e/live/cases/*.sh`, run in order)

`00_cli` (version/commands/help + all env-var docs + doctor) · `10_watch` ·
`11_listen` (Cloudglue + ElevenLabs) · `12_see` (HF + fal + Cloudglue tinycloud
see/extract ≥ 0.3.7 + local OWLv2) ·
`13_enhance_view` · `20_sources` (Tavily/Apify/yt-dlp) · `21_pipeline`
(source→capture→sense) · `22_monitor` (`--once` diff + bounded `--every`) ·
`23_index` · `24_case_search` · `16_visual_db` (local image-ransac,
`face:deepface-local`, and deepface-local with real media) · `30_read`
(ask/brief over real records) · `31_visualization` (CSI status/brief/records
exports with real visual targets and matches) · `32_headless_visualization`
(headless agent `--mode json` export trace, default CSI HTML theme) ·
`40_profiles` · `50_piping` (jq / chaining) · `60_dist` (binary as artifact) ·
`70_headless` (agent `--mode json` event stream + `-p` tool use +
watch/persist).

The offline suite also covers setup management (`phase4_setup`): `case setup
plan`, apply with target/note/source, `show`, `edit`, saved `.overcast/setup.json`,
and exclusion of setup history records from memory.

### Output

Each run writes to `./.dev/smoke/live-<UTC>/` (gitignored): `report.md` (summary
table + a **Detailed checks** section per assertion with the *condition under
test*, the *exact command*, and an *output snippet*), plus raw JSON. The run exits
non-zero if any case fails.

### Runner knobs

`OVERCAST_USE_NODE=1` (node instead of bun) · `SKIP_BUILD=1` (reuse `dist/`) ·
`OC_TIMEOUT=<secs>` (per-command timeout, default 300).

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
