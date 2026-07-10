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
  and overcast currently recommends **0.3.8** (`npm i -g @cloudglue/tinycloud@0.3.8`
  or `tinycloud update`); the image `see`/`extract` verbs (≥ 0.3.7) sit behind the
  opt-in `see` provider; override the invocation with `OVERCAST_TINYCLOUD_CMD`.
- **[qmd](https://github.com/tobi/qmd)** — optional local semantic case search:
  `npm install -g @tobilu/qmd`. The first qmd rebuild downloads/caches
  `embeddinggemma-300M-Q8_0` for embeddings. Plain `ask` does not require qmd.
- **yt-dlp** on `PATH` — for the `youtube` and generic `dl` sources, and for
  fetching post pages on `tiktok` / `x` / `instagram` / `telegram` (direct-CDN
  media still downloads with curl). `dl` handles any yt-dlp-supported host
  (Rumble, BitChute, Odysee, Vimeo, Reddit, …).
- **ExifTool** / **c2patool** — optional, only for the forensic senses:
  `exif` (metadata + GPS) needs `exiftool`; `verify` (C2PA / Content Credentials)
  needs `c2patool`. `brew install exiftool c2patool` · `apt install libimage-exiftool-perl`.
  Both report `needs_credentials` (exit 13) when absent, so the rest of overcast is unaffected.

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
overcast skills install --dest ~/.codex/skills # recommended for Codex/Cursor/other agents
overcast skills install                        # Claude Code default: copies into ~/.claude/skills
overcast skills install --harness claude-code  # explicit Claude Code target
npx skills add kdr/overcast                    # vercel-labs/skills; pulls skills from this repo
```

Shipped skills — `overcast` (the broad driver + `reference/verbs.md` man pages),
`overcast-init` (one-time setup), `overcast-skill-creator` (author your own), and
focused workflows:

| Skill | Trope / job |
|---|---|
| `overcast-recon-brief` | scan/monitor public sources → cited brief |
| `overcast-archive` | save media into global buckets, reuse + match across cases |
| `overcast-dork-recon` | Google-dork a domain for exposed assets → exposure brief |
| `overcast-attack-surface` | map a target's public attack surface (dork + shodan) |
| `overcast-visual-target-search` | find a person/logo/object across clips |
| `overcast-media-bug-triage` | screen recordings/audio → cited bug reports |
| `overcast-copycat-sweep` | hunt re-uploads/reskins of original video |
| `overcast-lineup` | build a face DB, run a probe through it ("the lineup") |
| `overcast-stakeout` | standing monitor + findings review + control-room wall |
| `overcast-scene-locate` | "where was this taken?" — clues → reverse-image search |
| `overcast-enhance-and-resolve` | "zoom in… enhance" — upscale, re-read, honestly |
| `overcast-wiretap` | diarize + audio-scene + spectrogram + voice-isolate/separate |
| `overcast-provenance` | "is this clip real?" — trace to the earliest source |
| `overcast-timeline` | reconstruct one event across multiple clips |
| `overcast-crime-board` | crops + person links + CLIP themes → CSI board + wall |
| `overcast-pinpoint` | pinpoint WHEN something happens — coarse→fine temporal search |
| `overcast-frame-grid` | triage a clip in one VLM call via a labeled frame contact sheet |
| `overcast-event-bisect` | binary-search the exact instant of a one-way state change |
| `overcast-where` | locate WHERE in a frame — detect box + VLM-verify the crop |
| `overcast-presence-window` | find the interval a person/object is on screen |

Each is generated from `src/skill-gen.ts` (one source of truth). The CSI/crime-trope
skills (`lineup`…`crime-board`) are exercised end-to-end against real media in
`test/e2e/live/cases/80`–`90`; the visual-CoT localization skills
(`pinpoint`…`presence-window`) in `test/e2e/live/cases/18_grid`.

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

# 6) objects: bind the OWLv2 detector, find boxes, and crop them
scripts/visual-db-uv.sh --detect     # uv-installs torch + transformers + scipy (sets DETECT_PY)
overcast setup provider see "exec:$DETECT_PY examples/providers/detect/detect.py"
overcast see ./clip.mp4 --detect "person, car, license plate" --json
overcast crop <see-record-id> --all --class person --json

# 6b) when did X happen? tile the clip, ask a VLM which cell, then verify the frame
overcast grid ./clip.mp4 --count 16 --json               # one contact sheet + cell→timestamp map
overcast see <montage-path> --prompt "which numbered cells show X?" --json
overcast see frame://<watch-record>@<seconds> --prompt "is X happening here?" --json  # verify at the frame
overcast grid ./clip.mp4 --view                          # clickable numbered board that seeks the clip

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

# 9b) audio DBs: Shazam-style exact matching (audio-fp) + CLAP audio similarity (basic-clap)
scripts/visual-db-uv.sh --audio           # numpy/scipy fingerprint deps (add --clap for CLAP embeddings)
overcast index create jingles --type audio-fp --local --json
overcast audio add ./original.mp4 --to jingles --json                 # fingerprint (video → audio track)
overcast audio match ./suspect.mp4 --index jingles --json             # which recording + WHERE (offset)
overcast audio match ./suspect.mp4 --index jingles --min-margin 2 --json # reject sped-up re-uploads
overcast audio match ./suspect.mp4 --index jingles --draw --json      # + SVG alignment plot (embeds in briefs)
overcast audio match ./a.mp3 ./b.mp3 --json                           # clip-to-clip, no index
overcast index create sounds --type basic-clap --local --json         # CLAP audio-embedding DB
overcast similar add ./clip.wav --index sounds --json                 # embed + cache (10s audio windows)
overcast similar search "crowd chanting" --index sounds --json        # text → audio moments

# 9c) voice DB: speaker verification (voice-print) — find a reference VOICE, not a recording
scripts/visual-db-uv.sh --voice           # pyannote stack (same as enhance --ops separate; no token needed)
overcast index create voices --type voice-print --local --json
overcast voice add ./interview.mp4 --index voices --json              # enroll (video → audio track)
overcast voice match ./sample.wav --index voices --json               # which members contain this speaker?
overcast voice match ./clip.mp4 ./sample.wav --json                   # WHERE the speaker talks in a clip
overcast voice match ./clip.mp4 ./sample.wav --diarize --json         # overlap-aware tier (HF_TOKEN gated)

# 10) launch the interactive agent (pi TUI) in the current case
overcast
```

A **case is just a directory** with a `.overcast/` store — switch cases with
`cd` or `--case <dir>`. pi's per-directory sessions are the case history.

**Man in the chair** — remote-drive the live TUI session from your phone: run
`/chair on tailnet` (or launch with `overcast --chair`), scan the QR that
appears, and the chair console opens in your phone browser — live assistant
stream, steer / follow-up prompts (typed or spoken: the composer's `mic`
button dictates via the browser's speech recognition), ABORT, and a read-only
case glance. The bridge is a token-authed localhost/tailnet HTTP+SSE server
(no TLS in v1 — pair it with Tailscale or an SSH tunnel; the pairing token
rides in the QR URL's `#fragment` and rotates on `/chair off`). Browsers only
allow the mic on secure origins, so dictation works on `localhost` out of the
box but needs HTTPS in front of a tailnet bind (e.g. `tailscale serve`). See
flow 23 in [`docs/flows.md`](docs/flows.md).

Use the three report surfaces for different jobs:

- `brief` answers "what does the evidence say?" **Short by default**: it leads
  with the verdict, key findings (with visual proof), the **lines of
  investigation** (per-target threads with a stage + activity sparkline), the
  triage queue of suggested leads, and coverage gaps — then a compact record
  trail. `--full` appends the verbatim per-record timeline (the audit dump). It
  reports over the same evidence-only boundary as case memory, so setup/read/meta
  records — and un-accepted **suggested** findings — are excluded.
- `case records` answers "what exactly happened?" It is the append-only audit log
  and includes operational records such as setup, target/source changes, index
  work, asks, briefs, and status checks.
- `case status` answers "where is this case right now?" It's a **mission board**:
  a goal headline + per-target threads on a stage ladder
  (cold → collecting → leads → corroborated → answered/dead-end), a per-source
  coverage funnel, scan/monitor/brief freshness, and a **triage** queue of
  suggested findings — with setup health, store counts, and match visualizations
  below. It is a dashboard, not evidence for later memory or briefs.

Run the **`/debrief`** prompt to drive the analyst loop over these surfaces:
triage the suggested leads (`finding accept`/`dismiss`), write one
`thread:<target-id>` note narrating each line of investigation, close resolved
lines, refresh the `tldr` note, then export the brief.

Direct CLI HTML exports default to the compatible `plain` theme unless
`--theme csi` is set. Agent/TUI tool calls default `.html` exports to `csi` for
these report surfaces, while preserving an explicit `--theme plain`.

For end-to-end recipes — first-run setup, person search, OSINT pulls, continuous
monitoring, qmd memory, detection crops, the control-room wall, and more — see
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
| `see` | caption / OCR / detect on an image, image URL, or video frame (default: the brain LLM when image-capable; falls back to HF, or bind a VLM / the opt-in tinycloud `see`+`extract` provider, ≥ 0.3.7) |
| `face` | detect faces in a video, `--match <img>` to find a person, or search a face-analysis index |
| `image` | match images/video frames against a local OpenCV RANSAC image index |
| `audio` | Shazam-style exact audio matching against a local `audio-fp` index (time-offset alignment), or clip-to-clip `audio match <query> <reference>`; `--min-margin` rejects sped re-uploads, `--draw` renders an SVG alignment plot for briefs |
| `voice` | speaker verification: enroll voices into a local `voice-print` index (`voice add`), rank members containing a reference speaker (`voice match <sample> --index`), or locate WHERE a speaker talks in a clip (`voice match <clip> <sample>`; `--diarize` for the overlap-aware pyannote tier). Rank scores, not liveness — clones can score high |
| `cluster` | local face DB: ingest faces → group into people (assign-or-create), `identify`, `recluster`, `label`, HTML `view` |
| `similar` | cross-modal semantic search over a local CLIP (`basic-clip`) or CLAP (`basic-clap`) index — `search` by text, `match` by image/audio, video/audio moments included |
| `enhance` | denoise / normalize / upscale via bundled ffmpeg, a bound restore model, or the split ops — `--ops separate` (per-speaker tracks, `--summarize` to transcribe each) and `--ops segment --prompt` (text-prompted masks + cutouts), bound local or fal, one evidence record per artifact |

**Inspect** — look at the evidence
| verb | does |
|---|---|
| `view` | open media in a scrubbable local HTML player (timeline markers, spectrogram); on an `enhance` split-op parent, a gallery of the tracks (audio + spectrograms) or cutouts |
| `crop` | materialize face/object detections as cropped image records with provenance |
| `grid` | tile timestamped frames into one contact sheet for single-call VLM triage (cell → timestamp map); `--view` for a clickable, numbered HTML board that seeks the clip |
| `wall` | control-room monitor wall — every case video muted + looping its best evidence moment, case state overlaid |

**OSINT** — search / capture / monitor
| verb | does |
|---|---|
| `scan` | sweep registered sources for the target; if no sources are enabled, scan local case media/indexes; `--pull` to capture + sense external hits |
| `capture` | fetch a URL / scan-hit / local path into the case |
| `monitor` | scan on a loop, diff the seen-set, pipe new items into a sense (`--once` / `--every`) |
| `index` | index media into searchable corpora: remote media/entities/face indexes, plus local `image-ransac`, `deepface-local`, `face-cluster`, `basic-clip`, `audio-fp`, `basic-clap`, and `voice-print` DBs |
| `archive` | global cross-case media buckets under `~/.overcast/archive` — `init` / `add` (sha256-deduped, tags/notes/provenance) / `list` / `show` / `remove` / `setup` (bucket index wizard); reuse from any case via `archive:<bucket>/<item>` refs and `--index archive:<bucket>/<index>` |
| `target` | a **line of investigation**: `add --question`, `list`, `close <id> --as answered\|dead-end --note`, `reopen` — closed lines stop seeding scans |
| `source` / `note` | where to look, and human-authored observations |
| `finding` | manual + **auto-suggested** findings (`create` / `list` / `accept` / `dismiss`). Score triggers (face / image / similar / cluster / audio match) + target text hits auto-emit `suggested` leads via a hook on every verb; `finding list --state triage` queues them, `accept` promotes a lead to evidence, `dismiss` blocks re-suggestion. Leads are quarantined from ask/brief until accepted |
| `prebrief` | stand up a case (name + target + source) in one shot |

**Read** — synthesize the case
| verb | does |
|---|---|
| `ask` | natural-language query over case memory → answer with `record.id` + `media.at` citations; `--deep` uses configured semantic memory such as qmd; `--index <id>` answers over a media-descriptions index (`--probe` for moment search); `--archive <bucket>` asks over a global archive bucket |
| `brief` | analyst report — **short by default** (verdict / key findings / lines of investigation / triage / coverage / compact trail), `--full` for the verbatim timeline; `--export` to md/html |
| `case` | inspect/manage the case: `init` / `setup` / `status` (mission board) / `info` / `records` / `memory` / `clear` (`memory get <id> --field <name> --offset/--limit` pages a large record field in full) |

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
overcast case setup edit --provider "listen:elevenlabs,see:owl-local" --auto-sense "watch,listen" --auto-index-new --findings suggest --yes --json
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

### Global archive

Media that should outlive one case — reference footage, known faces, recurring
locations, signature audio — lives in the **archive**: named, case-shaped
buckets under `~/.overcast/archive/<bucket>` (relocate with `OVERCAST_HOME` /
`--home`). Items are sha256-deduped `capture` records carrying tags, notes, and
origin provenance; there is no registry file — the directory listing IS the
bucket list. A fresh bucket needs zero setup (`ask --archive` searches it via
local-grep); `archive setup <bucket>` is the plan/`--yes` wizard that stands up
indexes (local `deepface-local` / `basic-clip` / `image-ransac` / `audio-fp` /
`basic-clap` / `voice-print` / `face-cluster`, remote Cloudglue `media-descriptions` /
`face-analysis` / `entities`) plus a memory backend (`local-grep` / `qmd`),
backfilling existing bucket media.

```bash
overcast archive init ref-footage --name "Reference footage"
overcast archive add rec_ab12cd34 --to ref-footage --tags drone --note "known drone, case 44"
overcast archive setup ref-footage --index faces:deepface-local,clip:basic-clip,voices:voice-print --auto-index-new --yes

# from INSIDE any case:
overcast face --match suspect.jpg --index archive:ref-footage/faces
overcast similar search "white van at night" --index archive:ref-footage/clip
overcast voice match sample.wav --index archive:ref-footage/voices   # speaker verification
overcast watch archive:ref-footage/clip_9f3a.mp4        # sense in place, no copy
overcast capture archive:ref-footage/clip_9f3a.mp4      # pull a copy + provenance
overcast ask "what do I have on the blue warehouse?" --archive ref-footage
```

Cross-case match evidence persists to the **current** case (stamped
`meta.archive`); the bucket holds the media, mirror, and DB artifacts. Because
a bucket is a case-shaped folder, everything else works via
`--case ~/.overcast/archive/<bucket>` (e.g. `case memory index rebuild` for a
bucket's qmd index).

---

## Providers

overcast binds verbs to backends through **providers** over one wire contract
(the loose **record**). The `exec` transport (a command) is what ships today;
`http` and `in-proc` are reserved in the binding shape but not yet wired. Rebind
a verb with **no code changes**:

```bash
overcast setup provider see     "exec:bash examples/providers/fal/see.sh {{input}}"
overcast setup provider listen  "exec:bash examples/providers/elevenlabs/listen.sh {{input}}"
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
  --findings suggest \
  --yes --json

overcast monitor --once --json          # new media follows the setup automation policy
overcast finding list --state triage --json   # queue auto-suggested leads (open + suggested)
overcast finding accept <finding-id> --json    # promote a lead into ask/brief evidence
overcast finding dismiss <finding-id> --json   # reject a lead (never re-suggested)
```

Findings default to `--findings suggest` (score/text triggers auto-emit
`suggested` leads on every verb; tune the score floors with
`case setup --findings-threshold face=75,similar=85,cluster=70,image_inliers=1`).
`--findings review` is the legacy text-only mode; `--findings off` disables it.
`finding list` alone shows only `open` findings — pass `--state triage` (or
`--state suggested`) to see the auto-suggested leads.

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
`local-models`, `deepface-local`, `basic-clip`, `audio-fp`, `basic-clap`, and
`voice-print`.
Single choices use `--verb <watch|listen|see|face|similar|audio|voice|enhance> --choice <id>`,
such as `listen:elevenlabs`, `see:fal`, `see:hf`, `see:owl-local`,
`face:deepface-local`, `similar:basic-clip`, `audio:audio-fp`, `voice:voice-print`,
or `enhance:ffmpeg`.

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
| **sense** | watch / listen / see / face / image / audio / similar / cluster / enhance / exif / verify | Cloudglue (default), the brain LLM (default `see`), local CLIP (`similar`), local CLAP (audio `similar`), Hugging Face, fal.ai, ElevenLabs, ffmpeg, ExifTool (`exif`), c2patool (`verify`), Nominatim (opt-in `exif --geocode`) |
| **source** | scan / capture / monitor | youtube (yt-dlp), dl (any yt-dlp host), tiktok / x / instagram / telegram / lens / facesearch (Apify), web (Tavily/Brave), dork (Serper.dev — Google dorking), shodan (Shodan host recon), gdelttv (GDELT TV, no key), webcam (Windy Webcams) |
| **memory** | ask / brief | `local-grep` case search (always on); optional lifecycle-managed qmd semantic search; typed tinycloud media indexes via `ask --index` |

Built-in source refs:

- `youtube:@handle` — enumerate a channel's videos.
- `youtube:search:<query>` or `youtube:<keyword>` — YouTube keyword search.
- `youtube:playlist:<id>` or `youtube:<full YouTube URL>` — enumerate a playlist/video URL.
- `tiktok:@user` — enumerate a TikTok profile.
- `tiktok:#tag` — enumerate a TikTok hashtag.
- `x:@handle` — enumerate an X (Twitter) profile's posts.
- `x:<query>` or `x:#tag` — X advanced search (`from:`, `filter:native_video`, `min_faves:`, …).
- `x:video:<query>` / `x:image:<query>` — only X posts with native video / images (media targeting).
- `web:<query>` — web search through Tavily, falling back to Brave when Tavily is unset.
- `lens:<image url or local path>` — Google Lens reverse image search (Apify): exact + visual page matches for an image.
- `dl:<url>` — capture-only generic fetcher: any yt-dlp-supported host (Rumble, BitChute, Odysee, VK, Bilibili, Vimeo, Dailymotion, Reddit, Facebook, …). `scan`/`monitor` enumerate returns nothing; it exists to route ad-hoc `capture <url>`.
- `instagram:@handle` / `instagram:#tag` / `instagram:<post URL>` — Instagram posts & reels (Apify); `--since` honored server-side.
- `telegram:<channel>` / `telegram:<t.me URL>` — public Telegram channel posts (Apify, no login); stable `t.me/<channel>/<id>` per-post URL for clean monitor dedup.
- `gdelttv:"<query>"` — GDELT 2.0 TV API broadcast-news clips (**no key**) → bounded Internet-Archive `.mp4?start=…&end=…` segments; `--since` maps to the GDELT date window.
- `webcam:<lat>,<lng>[,radius]` / `webcam:country:<ISO2>` / `webcam:category:<slug>` / `webcam:<id>` — live public webcams (Windy Webcams API); each hit's `media.ref` is the current still, re-captured every `monitor` pass (`recapture`).
- `facesearch:<image url or local path>` — **opt-in** reverse **face** search (Apify); ToS/privacy-gated, never a default source.
- `dork:<google dork>` — Google dorking via Serper.dev: real Google SERPs that **honor operators** (`site:`, `filetype:`, `inurl:`, `intitle:`, `ext:`, `-term`, `OR`), unlike `web`. The result page is captured as evidence. **Authorized recon only**, never a default source.
- `shodan:<search query>` / `shodan:<ip>` — host/service/banner intelligence via Shodan: search filters (`org:`, `net:`, `ssl:`, `product:`, `port:`, …) or a bare IP → full host lookup. Hits carry ip/port/org/product/cpe/vulns/geo; `media.ref` is the `shodan.io/host/<ip>` report page (`#<port>-<transport>` fragment so each service is distinct). Strong `monitor` fit. **Authorized recon only**, never a default source. **Opt-in (sensitive):** `OVERCAST_SHODAN_SCREENSHOTS=1` also materializes exposed-host screenshots (RDP/VNC/HTTP/camera → `see`/`face`/`crop`) and surfaces RTSP stream endpoints — real unwitting hosts, off by default.

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
- `TINYCLOUD_HTTP_RETRIES`, `TINYCLOUD_MODEL_RETRIES`, `TINYCLOUD_UPLOAD_IDLE_TIMEOUT_MS`, `TINYCLOUD_JOB_WAIT_TIMEOUT_MS` — tinycloud 0.3.7 Cloudglue retry/upload/job-wait knobs (HTTP + model retries default 5) inherited by overcast's default providers
- `OVERCAST_QMD_CMD`, `OVERCAST_QMD_MODEL` — optional qmd case-search command/model (`embeddinggemma-300M-Q8_0` by default; install with `npm install -g @tobilu/qmd`, then rebuild before querying qmd)

**Opt-in sense providers** (bind via `setup provider <verb> <spec>`)
- `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` — fallback `see` captioner (when the brain LLM has no vision) + `enhance`; `HF_SEE_MODEL` (default `google/gemma-3-27b-it`), `HF_ENHANCE_IMAGE_MODEL` / `HF_ENHANCE_AUDIO_MODEL` / `HF_ENHANCE_ENDPOINT`. `see` defaults to the brain LLM when it's image-capable — `OVERCAST_SEE_BRAIN=off` (or `setup provider see builtin:hf`) forces this HF captioner instead. Also gates the **local** `enhance --ops separate` (pyannote diarization): its model is a **gated** HF repo — set `HF_TOKEN` **and** accept the license at <https://huggingface.co/pyannote/speaker-diarization-community-1> ("Agree and access repository") once before first use.
- `FAL_KEY` (or `FAL_API_KEY`) — `see` (florence-2), `enhance` image (esrgan) / audio (deepfilternet3), plus the split ops `enhance --ops separate` (sam-audio) / `--ops segment` (sam-3); `FAL_SEE_MODEL`, `FAL_ENHANCE_IMAGE_MODEL`, `FAL_ENHANCE_AUDIO_MODEL`, `FAL_SEPARATE_MODEL`, `FAL_SEGMENT_MODEL`
- `OC_VISUAL_DB_PY` — the **local-models** `enhance` toolbox: on-device `--ops separate` (pyannote, gated — see `HF_TOKEN`) and `--ops segment` (GroundingDINO + SAM 2.1, ungated); set up with `scripts/visual-db-uv.sh --enhance`
- `OVERCAST_VOICE_MODEL` / `OC_VOICE_DEVICE` — the `voice` speaker-verification DB (default `pyannote/wespeaker-voxceleb-resnet34-LM`, **ungated**, CC-BY-4.0; device `cpu`). The model is pinned per voice-print index at create time. Only `voice match --diarize` needs `HF_TOKEN` + the accepted pyannote license (same gate as `enhance --ops separate`); everything else runs token-free. Set up with `scripts/visual-db-uv.sh --voice`
- `ELEVENLABS_API_KEY` (or `XI_API_KEY`) — `listen` (Scribe STT) + `enhance` audio (voice isolation); `ELEVENLABS_STT_MODEL` (default `scribe_v1`)

**OSINT sources**
- `TAVILY_API_KEY` (preferred) / `BRAVE_API_KEY` — the `web` search source
- `SERPER_API_KEY` — the `dork` source (Google dorking via Serper.dev — real Google SERPs that honor operators). Authorized recon only
- `SHODAN_API_KEY` — the `shodan` source (host/service/banner intelligence). Authorized recon only
- `APIFY_TOKEN` — the `tiktok`, `x`, `instagram`, `telegram`, `lens`, and `facesearch` sources (enumerate; fetch uses yt-dlp / direct CDN). Actor overrides: `OVERCAST_INSTAGRAM_ACTOR`, `OVERCAST_TELEGRAM_ACTOR`, `OVERCAST_LENS_ACTOR`, `OVERCAST_FACE_SEARCH_ACTOR`
- `WINDY_API_KEY` — the `webcam` source (Windy Webcams API; free tier covers scan + still capture + monitor). Base override: `OVERCAST_WEBCAM_API`
- `gdelttv` needs **no key** (GDELT 2.0 TV API is open)
- `youtube` and `dl` need `yt-dlp` on `PATH` (no key)
- `OVERCAST_SOURCE_<TYPE>_CMD` — override/add a source provider command
- `APIFY_RUN_SYNC_TIMEOUT_MS` — Apify run-sync budget for the Apify-backed sources

**Runtime / session** — `OVERCAST_HOME` (profiles, default `~/.overcast`),
`OVERCAST_CASE` / `OVERCAST_PROFILE` (set by the launcher from `--case` / `--profile`),
`OVERCAST_MEDIA_DIR` (set by overcast for exec providers), `OVERCAST_PI_ONLINE`.

**Man in the chair** — `OVERCAST_CHAIR=1` auto-starts the remote bridge on TUI
launch (same as `--chair`); `OVERCAST_CHAIR_BIND` (default `127.0.0.1` — keep it
off public interfaces; `/chair on tailnet` binds your Tailscale address) /
`OVERCAST_CHAIR_PORT` (default `7373`); `OVERCAST_CHAIR_TOKEN` pins the pairing
token (default: a fresh random token every `/chair on`).

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
- **agent skills + Claude Code plugin** — `skills generate` renders `skills/overcast/{SKILL.md, reference/verbs.md}` from the registry; `skills install --dest <dir>` copies them into any agent skills directory, while bare `skills install` targets Claude Code.

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
npm run pack:check  # verify synced versions + fresh dist/bin/overcast.js before npm pack
overcast commands --json   # the authoritative verb registry
overcast doctor            # preflight
```

`npm pack` runs `npm run pack:check` first. Build with `npm run build` before
packing; if the ignored `dist/` tree is missing or stale, the pack fails with a
message showing the version or command-registry drift.
