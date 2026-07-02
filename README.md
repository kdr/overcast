<p align="center">
  <img src="assets/branding/logo.png" alt="overcast" width="420" />
</p>

# overcast

**Video OSINT agent: senses + OSINT reach for any agent.**

overcast gives an agent *senses* and *recon and targeting reach*, organized
around an investigation **case**: a working directory with a local `.overcast/`
store where every result is kept. Point it at a corpus, 10 clips or 1,000, and it
turns footage into cited evidence: speech and audio with `listen`, full video
understanding with `watch`, on-screen text and objects with `see`, faces and
cross-corpus person search with `face`, and named entities with `index entities`.
Results persist as evidence-only case memory, so intelligence accumulates across
sessions instead of vanishing between runs, and `ask` answers cite the exact
record and timestamp.

Every subcommand is modular: each verb is a standalone CLI command that emits a
portable JSON record, so you can run the whole pipeline as one agent or drop a
single step into another recon/security workflow. overcast ships as a **pi
package**, a **standalone bun binary**, and **agent skills** that drive the CLI
from any harness. The brain LLM is BYO; the default perception backend is the
[Tinycloud Video Agent CLI](https://www.npmjs.com/package/@cloudglue/tinycloud).
Every verb runs over one provider contract, so you can rebind any sense to
another backend or your own script with no code changes.

---

## Install

### Prerequisites

- **FFmpeg** — `ffmpeg` + `ffprobe` on your `PATH` (the internal media toolkit
  for `enhance`, frame extraction, detection crops, and `view`).
  `brew install ffmpeg` · `apt install ffmpeg` · <https://ffmpeg.org/download.html>
  (or point `OVERCAST_FFMPEG` / `OVERCAST_FFPROBE` at specific binaries).
- **[tinycloud CLI](https://www.npmjs.com/package/@cloudglue/tinycloud)** — the
  default `watch` / `listen` / `face` / `index` backend (Cloudglue); set
  `CLOUDGLUE_API_KEY`. The `face` + `index` verbs need **tinycloud ≥ 0.3.4**
  and overcast currently recommends **0.3.6** (`npm i -g @cloudglue/tinycloud@0.3.6`
  or `tinycloud update`); override the invocation with `OVERCAST_TINYCLOUD_CMD`.
- **[qmd](https://github.com/tobi/qmd)** — optional local semantic case search:
  `npm install -g @tobilu/qmd`. The first qmd rebuild downloads/caches
  `embeddinggemma-300M-Q8_0` for embeddings. Plain `ask` does not require qmd.
- **yt-dlp** on `PATH` — only for the `youtube` / `tiktok` capture sources.

`overcast doctor` verifies core prerequisites and reports qmd when installed or
configured.

```bash
npm i -g @kdrrr/overcast          # the CLI + pi package  →  `overcast`
overcast doctor                 # preflight: pi, ffmpeg/ffprobe, Cloudglue, providers
```

Update to the newest release, or run a verb one-off without installing:

```bash
npm i -g @kdrrr/overcast@latest   # update an existing global install
npx @kdrrr/overcast doctor        # run any verb without a global install
```

Or grab the **standalone binary** (no Node required) for your platform from the
[latest release](https://github.com/kdr/overcast/releases/latest) —
`overcast-<os>-<arch>.tar.gz` (ships its `theme/` + `examples/` sidecars) — or
build it locally:

```bash
tar -xzf overcast-darwin-arm64.tar.gz   # → ./overcast (+ sidecars); put it on PATH
npm run build:bun                       # …or build locally → dist/bin/overcast
```

---

## Use it from your agent

overcast drives any harness three ways — pick whichever fits:

**Agent skills** (Claude Code, Cursor, Codex, …) — install the bundled skills with
the CLI, or pull them straight from this repo with the harness-agnostic
[`skills`](https://github.com/vercel-labs/skills) installer:

```bash
overcast skills install               # menu: pick a harness, writes the SKILL.md files
overcast skills install --global      # → ~/.claude/skills/overcast
npx skills add kdr/overcast           # vercel-labs/skills; pulls skills from this repo
```

**Claude Code plugin** (slash commands + skills as one package):

```text
/plugin marketplace add kdr/overcast
/plugin install overcast@overcast
```

**Interactive/headless overcast agent** — both `overcast` and
`overcast -p "<task>"` load the same system prompt and tool surface. The prompt
steers the agent to start with zero-config `ask`, rebuild qmd before semantic
queries, use `ask --deep` for configured semantic memory, and bind remote indexes
with `index attach` instead of note bookkeeping. Case memory is evidence-only:
case setup/doctor/index/target/source/prebrief/read bookkeeping is excluded from `ask` and `brief`.
Face/object detection records index only compact summaries/counts/moments, not
raw box arrays or thumbnails; `crop` records are searchable evidence artifacts
with source record/media/crop-source/time/class/id/box provenance. Use
`face --thumbnails` when you want face crop records to preserve and crop from
provider frame images when available. When a local video is
added to an index before it has been watched, `index add` creates missing
`watch` evidence for local-grep/qmd memory instead of relying on detections.
Confirmed `case clear --yes` also drops configured materialized memory indexes
such as qmd before clearing local state.

---

## Quickstart

```bash
# 0) optional: prepare a reusable provider profile once per machine/profile
overcast provider setup plan --preset cloudglue --profile default --json
overcast provider setup apply --preset cloudglue --profile default --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json

# 1) analyze a video → a reusable, time-anchored record
overcast watch ./clip.mp4 --json

# 2) run first-run case setup, give it a target + a source, sweep it
overcast case setup --name "dock-incident" --target "white van at pier 9" --source web:"pier 9 dock incident" --yes
overcast case setup status --json
overcast scan --pull --json            # enumerate sources → capture → sense each hit

# 3) ask questions over everything the case has accumulated (with citations)
overcast ask "every white van, with timestamps" --json
overcast brief --export ./brief.html
overcast case status --export ./status.html --theme csi
overcast case records --export ./records.html --theme csi

# 4) add a human observation anchored to evidence
overcast note "rear plate is missing" --ref <watch-record-id> --at 12-18 --tag vehicle --json

# 5) faces: detect, or find a specific person in a clip
overcast face ./clip.mp4 --thumbnails --json          # who is in this video + frame thumbnails for exact crops
overcast face ./clip.mp4 --match ./suspect.jpg --json # find this person (JPEG/PNG query image), ranked by similarity
overcast crop <face-record-id> --all --class face --json # write cropped face images as evidence

# 6) objects: bind a detector, find boxes, and crop them
overcast setup provider see "exec:python3 examples/providers/detect/detect.py"
overcast see ./clip.mp4 --detect "person, car, license plate" --json
overcast crop <see-record-id> --all --class person --json

# 7) index the target's videos, then search across ALL of them
overcast index create faces --type face --json
overcast index attach existing-face-index --type face --json       # or bind an existing remote index
overcast index add --all --to <face-col-id> --json   # register every captured/sensed video
overcast index add ./local.mp4 --to <face-col-id> --json # creates missing watch evidence locally
overcast face --match ./suspect.jpg --index <face-col-id> --json   # find them across the index

# 8) visual DBs: logos/landmarks with RANSAC, faces with a uv Python
scripts/visual-db-uv.sh --face
overcast index create logos --type image-ransac --local --json
overcast index add ./starbucks-logo.jpg --to logos --json
overcast image match ./clip.mp4 --index logos --fps 0.7 --draw --json
overcast index create localfaces --type deepface-local --local --json
overcast index add ./suspect.jpg --to localfaces --json
overcast face ./clip.mp4 --match ./suspect.jpg --index localfaces --fps 0.5 --max-frames 32 --json

# 8b) face-cluster DB: group everyone across clips into people, then browse
overcast index create people --type face-cluster --local --json  # or: case setup --index people:face-cluster
overcast cluster add ./clipA.mp4 --index people --fps 0.5 --max-frames 20 --json  # ingest → assign-or-create
overcast cluster add ./clipB.mp4 --index people --json
overcast cluster identify ./who.jpg --index people --json         # most-similar person (or "new person")
overcast cluster recluster --index people --json                  # re-tidy groups as the DB grows
overcast cluster label p_1 "Jane Doe" --index people --json       # names survive recluster
overcast cluster view --index people --json                       # self-contained HTML contact sheet

# 9) semantic (CLIP) search: find images/video moments by text or by example image
scripts/visual-db-uv.sh --clip
overcast index create scenes --type basic-clip --local --granularity frame --json
overcast similar add ./clip.mp4 --index scenes --json          # embed + cache (videos frame-sampled)
overcast similar search "a red car at night" --index scenes --json   # text → image/video moments
overcast similar match ./reference.jpg --index scenes --json         # image → image/video moments

# 10) launch the interactive agent (pi TUI) in the current case
overcast
```

A **case is just a directory** with a `.overcast/` store — switch cases with
`cd` or `--case <dir>`. pi's per-directory sessions are the case history.

Use the three report surfaces for different jobs:

- `brief` answers "what does the evidence say?" It reports over the same
  evidence-only boundary as case memory, so setup/read/meta records are excluded.
- `case records` answers "what exactly happened?" It is the append-only audit log
  and includes operational records such as setup, target/source changes, index
  work, asks, briefs, and status checks.
- `case status` answers "where is this case right now?" It summarizes setup
  health, targets, sources, indexes, memory/index state, store counts, artifacts,
  and match visualizations when available. It is a dashboard, not evidence for
  later memory or briefs.

Direct CLI HTML exports default to the compatible `plain` theme unless
`--theme csi` is set. Agent/TUI tool calls default `.html` exports to `csi` for
these report surfaces, while preserving an explicit `--theme plain`.

For end-to-end recipes — first-run setup, person search, OSINT pulls, continuous
monitoring, qmd memory, detection crops, and more — see
**[`docs/flows.md`](docs/flows.md)** (common flows & usage patterns).

---

## Verbs

Run `overcast commands --json` for the authoritative registry, or
`overcast <verb> --help` for a man page. (`overcast --help` shows the full
surface + env vars.)

**Senses** — turn media into records
| verb | does |
|---|---|
| `watch` | analyze a video → `content` / `transcript` / `detailed` (default: Cloudglue) |
| `listen` | transcribe audio / a video's audio; `--describe` for the full audio-scene |
| `see` | caption / OCR / detect on an image, image URL, or video frame (default: the brain LLM when image-capable; falls back to HF, or bind a VLM) |
| `face` | detect faces in a video, `--match <img>` to find a person, or search a face-analysis index |
| `image` | match images/video frames against a local OpenCV RANSAC image index |
| `cluster` | local face DB: ingest faces → group into people (assign-or-create), `identify`, `recluster`, `label`, HTML `view` |
| `similar` | cross-modal semantic search over a local CLIP (`basic-clip`) index — `search` by text, `match` by image, video moments included |
| `enhance` | denoise / normalize / upscale via bundled ffmpeg, or a bound model provider |
| `view` | open media in a scrubbable local HTML player (timeline markers, spectrogram) |
| `crop` | materialize face/object detections as cropped image records with provenance |

**OSINT** — search / capture / monitor
| verb | does |
|---|---|
| `scan` | sweep registered sources for the target; if no sources are enabled, scan local case media/indexes; `--pull` to capture + sense external hits |
| `capture` | fetch a URL / scan-hit / local path into the case |
| `monitor` | scan on a loop, diff the seen-set, pipe new items into a sense (`--once` / `--every`) |
| `index` | index media into searchable corpora: remote media/entities/face indexes, plus local `image-ransac`, `deepface-local`, and `basic-clip` DBs |
| `target` / `source` / `note` | manage the standing scope, where to look, and human-authored observations |
| `finding` | create and review findings (`create` / `list` / `accept` / `dismiss`) — manual + setup-automated |
| `prebrief` | stand up a case (name + target + source) in one shot |

**Read** — synthesize the case
| verb | does |
|---|---|
| `ask` | natural-language query over case memory → answer with `record.id` + `media.at` citations; `--deep` uses configured semantic memory such as qmd; `--index <id>` answers over a media-descriptions index (`--probe` for moment search) |
| `brief` | timeline / findings report; `--export` to md/html |
| `case` | inspect/manage the case: `init` / `setup` / `info` / `records` / `memory` (`memory get <id> --field <name> --offset/--limit` pages a large record field in full) |

**Config / SDK / dist** — `setup` (bind providers + brain LLM), `provider`
(init/list/describe), `doctor` (preflight), `skills` (generate/install).

**Base verbs** come from pi: `read` `write` `edit` `bash` `grep` `find` `ls`.

### Case setup

`case setup` is the first-run case wizard and the later setup-management
surface. It saves the mutable current setup to `.overcast/setup.json` and emits
immutable `case` history records with `payload.op = "startup_setup"` or
`"startup_setup_update"`. Those operational setup records are excluded from
case memory/briefs; setup notes are emitted as normal `note` evidence.
Setup always configures one local case-search backend: `local-grep` by default,
or `qmd` when you want configured local semantic memory. Local memory defaults
to `note`, `watch`, `listen`, `see`, and `scan` evidence, including source/search
metadata from web, YouTube, TikTok, and similar scans. Remote collections are
additive and optional: `face-analysis` / `media-descriptions` / `entities` are
tinycloud-backed for scale and portability. When setup applies with local videos
routed to remote collections, overcast starts collection creation/ingestion
immediately; use `--no-index` to save the setup without starting remote ingest.

```bash
overcast case setup plan --target "@pier9" --memory local-grep --source "web:pier 9" --index "media:media" --json
overcast case setup --name "dock-incident" --target "@pier9" --memory local-grep --source "web:pier 9" --yes --json
overcast case setup edit --provider "listen:elevenlabs,see:owl-local" --auto-sense "watch,listen" --auto-index-new --findings review --yes --json
overcast case setup show --json
overcast case setup edit --target "new subject" --source "youtube:@channel" --yes --json
```

When a case is local-media-only, `overcast scan` does not dead-end on missing
sources: it scans local setup/media/index state, and if an image target plus a
face-analysis or local image/face index exist it suggests or runs the relevant
match. Local visual DB scans search candidate case media against stored reference
images, not the target image by itself, and cap candidate fan-out with
`--limit` (default 5). Use `overcast scan --local` to force this local scan even
after adding external sources.

---

## Providers

overcast binds verbs to backends through **providers** over one wire contract
(the loose **record**) and three transports — `exec` (default), `http`,
`in-proc`. Rebind a verb with **no code changes**:

```bash
overcast setup provider see     "exec:bash examples/providers/fal/see.sh {{input}}"
overcast setup provider listen  "exec:bash examples/providers/elevenlabs/listen.sh {{input}}"
overcast setup provider enhance "http://localhost:9000"
overcast setup memory qmd       # optional local semantic case search
overcast case memory index rebuild --memory qmd --json
overcast ask "where did we see the white van?" --deep --json
```

Shipped, runnable samples live in [`examples/providers/`](examples/providers);
authoring guide in [`docs/providers.md`](docs/providers.md).

Provider setup has two levels:

- **Profile/global setup**: run once per machine/profile to choose reusable
  backends. Use `provider setup plan` first, then `provider setup apply --yes`.
- **Case setup**: per investigation, choose which configured provider outputs
  are eligible for local memory/indexing and which senses should run
  automatically on newly captured media.
  Runtime execution follows the active profile binding; case setup records
  provider policy/choice metadata and can clear built-ins such as
  `enhance:ffmpeg`, but it does not pin an old exec command after the profile is
  rebound.

```bash
# reusable profile setup
overcast provider setup show --profile recon --json
overcast provider setup plan --preset fal --profile recon --json
overcast provider setup apply --preset fal --profile recon --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json
overcast provider init listen --profile recon --json
overcast doctor --profile recon --json

# per-case policy that uses the active profile
overcast case setup edit \
  --provider "listen:elevenlabs,see:owl-local" \
  --provider-indexable "listen,see" \
  --auto-sense "watch,listen" \
  --auto-index-new \
  --findings review \
  --yes --json

overcast monitor --once --json          # new media follows the setup automation policy
overcast finding list --json            # review automated target matches
overcast finding dismiss <finding-id> --json
```

Use `overcast case setup edit --no-auto-index-new --yes --json` to turn off
automatic indexing later without clearing the rest of the case automation
policy.

`scan --pull` and `monitor` share per-hit processing semantics: resolve
`media.ref` or `payload.url`, capture when needed, run the explicit `--pipe` or
setup automation/default watch, then classify the item as completed, pending,
credential-blocked, or failed. Hits with no fetchable ref/url emit explicit
errors in both commands. `monitor` marks hard failures seen after surfacing the
error, while pending/credential gaps remain retryable.

Catalog presets: `cloudglue`, `hf`, `fal`, `elevenlabs`, `owl-local`,
`deepface-local`, and `basic-clip`.
Single choices use `--verb <watch|listen|see|face|similar|enhance> --choice <id>`,
such as `listen:elevenlabs`, `see:fal`, `see:hf`, `see:owl-local`,
`face:deepface-local`, `similar:basic-clip`, or `enhance:ffmpeg`.

The local image DB is selected by local index type. Local face detection/matching
can be selected as a profile provider with `face:deepface-local`, while the searchable
local face DB is selected by the `deepface-local` index type. Create the uv-managed
Python once, then create local indexes inside cases. `case setup --index` is for
remote/default index creation today; use `index create --local` for visual DBs.

```bash
scripts/visual-db-uv.sh          # OpenCV/Numpy image matching
scripts/visual-db-uv.sh --face   # plus DeepFace/TensorFlow face matching
overcast doctor --json              # reports uv + visual-db readiness
overcast provider setup apply --verb face --choice deepface-local --profile local --yes --json

overcast index create logos --type image-ransac --local --json
overcast index add ./logo.jpg --to logos --json
overcast image match ./video.mp4 --index logos --fps 0.7 --draw --json

overcast index create localfaces --type deepface-local --local --json
overcast index add ./person.jpg --to localfaces --json
overcast face ./video.mp4 --match ./person.jpg --index localfaces --fps 0.5 --max-frames 32 --json
```

Local-grep/qmd memory indexes ingest the resulting Overcast JSON records and
human summaries, not binary media, embeddings, extracted frames, boxed crops, or
match visualization images. Keep visual matching in the typed local indexes, and
use notes/watch/listen/see summaries when you need text-searchable context.
For video matching, omit both sampling flags for provider defaults, pass `--fps`
for cadence, and add `--max-frames` when you want a hard cap.

| class | verbs | shipped providers |
|---|---|---|
| **sense** | watch / listen / see / face / similar / enhance | Cloudglue (default), the brain LLM (default `see`), local CLIP (`similar`), Hugging Face, fal.ai, ElevenLabs, ffmpeg |
| **source** | scan / capture / monitor | youtube (yt-dlp), tiktok (Apify), web (Tavily/Brave) |
| **memory** | ask / brief | `local-grep` case search (always on); optional lifecycle-managed qmd semantic search; typed tinycloud media indexes via `ask --index` |

Built-in source refs:

- `youtube:@handle` — enumerate a channel's videos.
- `youtube:search:<query>` or `youtube:<keyword>` — YouTube keyword search.
- `youtube:playlist:<id>` or `youtube:<full YouTube URL>` — enumerate a playlist/video URL.
- `tiktok:@user` — enumerate a TikTok profile.
- `tiktok:#tag` — enumerate a TikTok hashtag.
- `web:<query>` — web search through Tavily, falling back to Brave when Tavily is unset.

### Profiles

A **profile** is a named set of bindings — per-verb providers plus the brain LLM —
persisted under `~/.overcast/profiles/` (`OVERCAST_HOME`). Build one by binding
into it, then select it per command (or for the whole session):

```bash
# build / extend a profile named "fal"
overcast setup provider see  "exec:bash examples/providers/fal/see.sh {{input}}" --profile fal
overcast setup provider watch "exec:bash examples/providers/bash/watch.sh {{input}}" --profile fal
overcast setup llm anthropic claude-sonnet-4-6                                   --profile fal

# use it: per command …
overcast see ./img.jpg --json --profile fal
# … or for the session
OVERCAST_PROFILE=fal overcast see ./img.jpg --json

overcast setup show --profile fal     # inspect a profile's bindings
```

The default profile is `default`. Point `--home <dir>` at a different store to
keep profiles per-case or per-project. To build ready-made presets (e.g. `fal`,
`cloudglue`, `recon`) from the shipped example providers:

```bash
bash examples/profiles/install-profiles.sh   # then: overcast <verb> … --profile <name>
```

---

## Environment variables

`overcast --help` prints the full, current list. Highlights:

**Default perception (tinycloud / Cloudglue)**
- `CLOUDGLUE_API_KEY` — key for the default `watch`/`listen` + the turnkey brain (else `~/.tinycloud/config.json`)
- `CLOUDGLUE_BASE_URL` — endpoint (default `https://api.cloudglue.dev`)
- `TINYCLOUD_HTTP_RETRIES`, `TINYCLOUD_UPLOAD_IDLE_TIMEOUT_MS`, `TINYCLOUD_JOB_WAIT_TIMEOUT_MS` — tinycloud 0.3.6 Cloudglue retry/upload/job-wait knobs inherited by overcast's default providers
- `OVERCAST_QMD_CMD`, `OVERCAST_QMD_MODEL` — optional qmd case-search command/model (`embeddinggemma-300M-Q8_0` by default; install with `npm install -g @tobilu/qmd`, then rebuild before querying qmd)

**Opt-in sense providers** (bind via `setup provider <verb> <spec>`)
- `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` — fallback `see` captioner (when the brain LLM has no vision) + `enhance`; `HF_SEE_MODEL` (default `google/gemma-3-27b-it`), `HF_ENHANCE_IMAGE_MODEL` / `HF_ENHANCE_AUDIO_MODEL` / `HF_ENHANCE_ENDPOINT`. `see` defaults to the brain LLM when it's image-capable — `OVERCAST_SEE_BRAIN=off` (or `setup provider see builtin:hf`) forces this HF captioner instead.
- `FAL_KEY` (or `FAL_API_KEY`) — `see` (florence-2), `enhance` image (esrgan) / audio (deepfilternet3); `FAL_SEE_MODEL`, `FAL_ENHANCE_IMAGE_MODEL`, `FAL_ENHANCE_AUDIO_MODEL`
- `ELEVENLABS_API_KEY` (or `XI_API_KEY`) — `listen` (Scribe STT) + `enhance` audio (voice isolation); `ELEVENLABS_STT_MODEL` (default `scribe_v1`)

**OSINT sources**
- `TAVILY_API_KEY` (preferred) / `BRAVE_API_KEY` — the `web` search source
- `APIFY_TOKEN` — the `tiktok` source (enumerate; fetch uses yt-dlp)
- youtube needs `yt-dlp` on `PATH` (no key)
- `OVERCAST_SOURCE_<TYPE>_CMD` — override/add a source provider command

**Runtime / session** — `OVERCAST_HOME` (profiles, default `~/.overcast`),
`OVERCAST_CASE` / `OVERCAST_PROFILE` (set by the launcher from `--case` / `--profile`),
`OVERCAST_MEDIA_DIR` (set by overcast for exec providers), `OVERCAST_PI_ONLINE`.

**Visual DBs** — `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY`
override the Python used by local `image-ransac` and `deepface-local` indexes. If
unset, overcast auto-detects `.dev/visual-db-py/bin/python` created by
`scripts/visual-db-uv.sh`, then falls back to `python3`.

**Brain LLM** — BYO via pi-ai: *any* pi-ai provider key works
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …). Cloudglue is also a
pickable brain in `/model` when its key is set — never forced.

---

## Distribution

Three surfaces from one source of truth (`src/registry/verbs.ts`):

- **pi package** (`@kdrrr/overcast`) — `tsup` bundles `dist/{bin,index,extension}.js`; pi + ffmpeg/ffprobe stay external (pinned / runtime-resolved). A `postinstall` brands the pinned pi host as "overcast" without moving `~/.pi`.
- **standalone binary** — `bun build --compile` → a single executable (+ a sidecar `package.json` for branding).
- **agent skills + Claude Code plugin** — `skills generate` renders `skills/overcast/{SKILL.md, reference/verbs.md}` from the registry; `skills install` copies them into a harness.

---

## Development

```bash
npm run build       # tsup (dev/library build)
npm run typecheck   # tsc --noEmit
npm test            # unit tests (offline; fixtures)
npm run test:e2e    # offline e2e (fixture providers, no creds)
npm run test:e2e:live  # live real-data e2e (builds the bun binary, sources .env)
E2E_VERBOSE=1 npm run test:e2e  # include exact commands + output snippets in report.md
npm run build:bun   # bun build --compile → dist/bin/overcast
overcast commands --json   # the authoritative verb registry
overcast doctor            # preflight
```
