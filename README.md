<p align="center">
  <img src="assets/branding/logo.png" alt="overcast" width="420" />
</p>

# overcast

**Senses (video / audio / image understanding) + OSINT reach (search / capture / monitor) for any agent.**

overcast gives an agent *eyes and ears* and *reach*, organized around an
investigation **case**. It ships as a **pi package** (extension + skills +
prompts + theme), a **standalone bun binary**, and **agent skills** that drive
the CLI from any harness. The brain LLM is BYO; the default perception backend is
[Cloudglue](https://cloudglue.dev) via the
[Tinycloud Video Agent CLI](https://www.npmjs.com/package/@cloudglue/tinycloud)
([tinycloud.sh](https://www.tinycloud.sh/)).

---

## Install

### Prerequisites

- **FFmpeg** — `ffmpeg` + `ffprobe` on your `PATH` (the internal media toolkit
  for `enhance`, frame extraction, and `view`).
  `brew install ffmpeg` · `apt install ffmpeg` · <https://ffmpeg.org/download.html>
  (or point `OVERCAST_FFMPEG` / `OVERCAST_FFPROBE` at specific binaries).
- **[tinycloud CLI](https://www.npmjs.com/package/@cloudglue/tinycloud)** — the
  default `watch` / `listen` / `face` / `collection` backend (Cloudglue); set
  `CLOUDGLUE_API_KEY`. The `face` + `collection` verbs need **tinycloud ≥ 0.3.4**
  and overcast currently recommends **0.3.6** (`npm i -g @cloudglue/tinycloud@0.3.6`
  or `tinycloud update`); override the invocation with `OVERCAST_TINYCLOUD_CMD`.
- **yt-dlp** on `PATH` — only for the `youtube` / `tiktok` capture sources.

`overcast doctor` verifies all of these.

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

---

## Quickstart

```bash
# 1) analyze a video → a reusable, time-anchored record
overcast watch ./clip.mp4 --json

# 2) stand up a case, give it a target + a source, sweep it
overcast prebrief "dock-incident" --target "white van at pier 9" --source web:"pier 9 dock incident"
overcast scan --pull --json            # enumerate sources → capture → sense each hit

# 3) ask questions over everything the case has accumulated (with citations)
overcast ask "every white van, with timestamps" --json
overcast brief --export ./brief.html

# 4) faces: detect, or find a specific person in a clip
overcast face ./clip.mp4 --json                       # who is in this video
overcast face ./clip.mp4 --match ./suspect.jpg --json # find this person (JPEG/PNG query image), ranked by similarity

# 5) index the target's videos into a collection, then search across ALL of them
overcast collection create faces --type face --json
overcast collection add --all --to <face-col-id> --json   # register every captured/sensed video
overcast face --match ./suspect.jpg --collection <face-col-id> --json   # find them across the index

# 6) launch the interactive agent (pi TUI) in the current case
overcast
```

A **case is just a directory** with a `.overcast/` store — switch cases with
`cd` or `--case <dir>`. pi's per-directory sessions are the case history.

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
| `see` | caption / OCR / detect on an image or video frame (turnkey HF, or bind a VLM) |
| `face` | detect faces in a video, `--match <img>` to find a person, or search a face-analysis collection |
| `enhance` | denoise / normalize / upscale via bundled ffmpeg, or a bound model provider |
| `view` | open media in a scrubbable local HTML player (timeline markers, spectrogram) |

**OSINT** — search / capture / monitor
| verb | does |
|---|---|
| `scan` | sweep registered sources for the target; `--pull` to capture + sense each hit |
| `capture` | fetch a URL / scan-hit / local path into the case |
| `monitor` | scan on a loop, diff the seen-set, pipe new items into a sense (`--once` / `--every`) |
| `collection` | index a target's videos into a tinycloud collection (media-descriptions / entities / face-analysis) → searchable corpus |
| `target` / `source` | manage the standing scope + where to look |
| `prebrief` | stand up a case (name + target + source) in one shot |

**Read** — synthesize the case
| verb | does |
|---|---|
| `ask` | natural-language query over case memory → answer with `record.id` + `media.at` citations; `--collection <id>` answers over a media-descriptions collection (`--probe` for moment search) |
| `brief` | timeline / findings report; `--export` to md/html |
| `case` | inspect/manage the case: `init` / `info` / `records` / `memory` (`memory get <id> --field <name> --offset/--limit` pages a large record field in full) |

**Config / SDK / dist** — `setup` (bind providers + brain LLM), `provider`
(init/list/describe), `doctor` (preflight), `skills` (generate/install).

**Base verbs** come from pi: `read` `write` `edit` `bash` `grep` `find` `ls`.

---

## Providers

overcast binds verbs to backends through **providers** over one wire contract
(the loose **record**) and three transports — `exec` (default), `http`,
`in-proc`. Rebind a verb with **no code changes**:

```bash
overcast setup provider see     "exec:bash examples/providers/fal/see.sh {{input}}"
overcast setup provider listen  "exec:bash examples/providers/elevenlabs/listen.sh {{input}}"
overcast setup provider enhance "http://localhost:9000"
```

Shipped, runnable samples live in [`examples/providers/`](examples/providers);
authoring guide in [`docs/providers.md`](docs/providers.md).

| class | verbs | shipped providers |
|---|---|---|
| **sense** | watch / listen / see / face / enhance | Cloudglue (default), Hugging Face, fal.ai, ElevenLabs, ffmpeg |
| **source** | scan / capture / monitor | youtube (yt-dlp), tiktok (Apify), web (Tavily/Brave) |
| **memory** | ask / brief | local (always on); a tinycloud `collection` (media-descriptions) via `ask --collection` |

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

**Opt-in sense providers** (bind via `setup provider <verb> <spec>`)
- `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` — turnkey `see` + `enhance`; `HF_SEE_MODEL` (default `google/gemma-3-27b-it`), `HF_ENHANCE_IMAGE_MODEL` / `HF_ENHANCE_AUDIO_MODEL` / `HF_ENHANCE_ENDPOINT`
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
npm test            # unit + offline e2e (fixture provider)
npm run test:e2e    # full e2e (real clips + Cloudglue); OVERCAST_E2E_LIVE=1 for live cases
overcast commands --json   # the authoritative verb registry
overcast doctor            # preflight
```
