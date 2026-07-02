---
name: overcast
description: >-
  Give any agent senses (video/audio/image understanding) and OSINT reach
  (search/capture/monitor) organized around an investigation case. Use when the
  user wants to analyze a video/audio/image, scan or monitor sources for a
  target, or ask/brief over accumulated findings. Drives the `overcast` CLI
  (built on pi + the tinycloud/Cloudglue perception backend); see
  reference/verbs.md for the full verb surface.
---

# overcast

overcast turns a vanilla agent into a video-understanding OSINT investigator.
A **case** is just the current directory (its `.overcast/` store holds the
records). Every verb emits a loose, indexable **record**; cite findings by
`record.id` + `media.at`.

## Verbs

- `watch` — Analyze a video into a reusable, time-anchored record (content/transcript/detailed).
- `listen` — Transcribe and analyze audio (or a video's audio track) into an audio.analysis record.
- `see` — Understand an image or a single video frame (caption, OCR, detections).
- `face` — Detect, match, or search faces in video (and across face-analysis indexes).
- `image` — Match images or video frames against a local RANSAC image index.
- `cluster` — Build and browse a local face-cluster DB: group faces into people, identify, label, and view.
- `similar` — Find images/video moments by visual or text similarity in a local CLIP (basic-clip) index.
- `enhance` — Produce better media (denoise/normalize/upscale/...) via ffmpeg or a bound model provider.
- `view` — Open media in a lightweight local viewer (scrubbable player) or hand off to the OS.
- `crop` — Materialize face/object detections as cropped image records with provenance.
- `wall` — Open a control-room monitor wall: case videos looping at their evidence moments.
- `scan` — Sweep sources, or local case media/indexes when no sources exist; emit scan.hit records (--pull to capture+sense).
- `capture` — Fetch a resource (URL / scan.hit / local path) into the case as a capture record.
- `monitor` — scan on a loop; diff against the seen-set; pipe new items into a sense. --once or --every <interval>.
- `index` — Manage tinycloud indexes that index a target's videos (create/attach/add/list/show/delete/remove/entities).
- `target` — Define/refine the standing scope (add|list|rm|show). Persisted to .overcast/target.json.
- `source` — Register where to look (add <type>:<ref> | list | enable|disable <id> | rm <id>).
- `note` — Add a human observation/finding to the case, optionally anchored to evidence.
- `finding` — Create and review findings (create|list|accept|dismiss).
- `prebrief` — Stand up a case: name + target + source in one shot (non-interactive via flags).
- `ask` — Natural-language query over the case memory; answers with record.id + media.at citations.
- `brief` — Synthesize the case records into a report (timeline + findings); --export to md/html.
- `case` — Inspect/manage the current case: init | setup | status | info | records | memory | clear.
- `setup` — Bind the brain LLM + per-verb providers and manage profiles (setup provider|llm|show).
- `provider` — Run provider setup/init hooks, or list/describe bound providers (provider setup|init|list|describe).
- `doctor` — Preflight: check pi version, ffmpeg/ffprobe, Cloudglue creds, tinycloud, provider bindings.
- `skills` — Generate shipped overcast skills + reference from the registry, or install into a harness.

## How to drive it

Run any verb from bash and parse the JSON record:

```bash
overcast watch ./clip.mp4 --json          # video.analysis record
overcast scan --pull --json               # enumerate sources, capture + sense
overcast finding list --json              # review automated target matches
overcast note "rear plate is missing" --ref <record-id> --at 12-18 --json
overcast face ./clip.mp4 --thumbnails --json  # detect faces (boxes + provider frame thumbnails)
overcast face ./clip.mp4 --match ./suspect.jpg --json   # find this person in the video (JPEG/PNG query image)
overcast crop <face-or-see-record-id> --all --class face --json  # materialize detection crops as evidence
overcast ask "every white van, with timestamps" --json
overcast case memory index status --json  # inspect default local-grep case search
overcast brief --export ./brief.html      # evidence-only narrative report
overcast case status --export ./status.html --theme csi   # current case dashboard
overcast case records --export ./records.html --theme csi # full audit log
```

Built-in source refs for `source add <type>:<ref>`:

- `youtube:@handle` — enumerate a channel's videos.
- `youtube:search:<query>` or `youtube:<keyword>` — YouTube keyword search.
- `youtube:playlist:<id>` or `youtube:<full YouTube URL>` — enumerate a playlist/video URL.
- `tiktok:@user` — enumerate a TikTok profile.
- `tiktok:#tag` — enumerate a TikTok hashtag.
- `web:<query>` — web search through Tavily, falling back to Brave when Tavily is unset.

`overcast commands --json` dumps the authoritative verb registry. Full man
pages are in [reference/verbs.md](reference/verbs.md) (progressive disclosure —
read it when you need a verb's exact flags).

### Brief vs status vs records

Use `brief` for the evidence narrative: it reports over the same evidence-only
boundary as case memory, so setup/read/meta records are excluded.

Use `case status` for the current dashboard: setup health, targets, sources,
indexes, memory/index state, record/store counts, artifacts, and match
visualizations when available. Treat it as situational context, not evidence for
later memory or briefs.

Use `case records` for the audit trail: it includes the append-only operational
history, including setup, target/source changes, index work, asks, briefs, and
status checks.

Direct CLI HTML exports default to `plain` for compatibility. In the
interactive/headless agent tool surface, `.html` exports default to the
`csi` visualization theme when the verb supports themes, unless the tool call
explicitly passes `theme: "plain"`.

### Case search (default ask)

`overcast ask "question"` is the zero-config way to search the whole case:
notes, sensed media records, scan/capture artifacts, and other primary evidence
records. Operational/read records (`setup`, `doctor`, `index`, `target`,
`source`, `prebrief`, `ask`, `case`, etc.) are excluded from case memory and briefs so setup probes,
remote-index bookkeeping, and prior answers are not cited as evidence.
It uses the always-on `local-grep` backend over verb-specific indexable fields
(`note.text`, `watch.content`, `listen.transcript`, scan titles/snippets, …)
and returns cited `record.id` + `media.at` evidence. Use:

```bash
overcast case memory list --json
overcast case memory index status --json
overcast ask "where did we see the white van?" --json
```

For optional local semantic case search, bind qmd (default embedding model:
`embeddinggemma-300M-Q8_0`):

```bash
npm install -g @tobilu/qmd
overcast setup memory qmd
overcast case memory index rebuild --memory qmd --json
overcast ask "where did we see the white van?" --deep --json
overcast ask "where did we see the white van?" --memory qmd --json
```

qmd is lifecycle-managed: rebuild/start/retry refresh the materialized index,
plain `ask` stays on local-grep, and `ask --deep` selects configured
semantic providers such as qmd. The first qmd rebuild downloads/caches
`embeddinggemma-300M-Q8_0`; rebuilds replace the named qmd collection before
re-adding docs, so rerunning after new notes/watch records is safe.
`face` records contribute compact summary/moment fields to memory, not raw
box/thumbnail blobs. `see` detection records likewise index counts/categories
instead of the full detection array. Use `crop <record-id> --all` to turn
face/object detections into local cropped image evidence records; crop records
are fully memory-eligible and preserve source record, source media, crop source
media, timestamp, class/id, confidence, and box provenance. Use
`face --thumbnails` before `crop` when you want provider frame images
preserved for crop extraction.
`overcast doctor` reports qmd when installed or configured.

### Faces & indexes (register a target's videos, then ask / find a person)

An **index** is a tinycloud-backed searchable corpus of videos, searched one way
per TYPE — build one from the videos you gather for a target, then query it:

```bash
# 1) index the target's videos (media-descriptions = ask/probe; face = find a person)
overcast index create case-media --type media-descriptions --json
overcast index attach existing-remote-index --json        # bind a remote tinycloud index to this case
overcast scan --pull --json                       # pull the target's videos into the case
overcast index add --all --to <index-id> --json   # register every captured/sensed video
overcast index add ./local.mp4 --to <index-id> --json # also creates missing watch evidence for local memory

# 2a) media-descriptions → ask / probe across ALL indexed videos
overcast ask "what objections came up?" --index <index-id> --json
overcast ask "moments a contract is signed" --index <index-id> --probe --json

# 2b) face-analysis → find a specific person across the index
overcast index create faces --type face --json
overcast index attach existing-face-index --type face --json
overcast index add --all --to <face-index-id> --json
overcast face --match ./suspect.jpg --index <face-index-id> --json
overcast face ./clip.mp4 --thumbnails --json
overcast crop <face-record-id> --all --class face --out ./.overcast/media/crops --json

# 2c) entities → same-schema extraction per video
overcast index create people --type entities --prompt "people, orgs, locations" --json
overcast index entities <entity-index-id> ./clip.mp4 --json
```

`face` needs tinycloud ≥ 0.3.4 (`overcast doctor` flags an older install);
overcast currently recommends tinycloud 0.3.7 for the latest face validation,
CLI reliability, and image `see`/`extract` behavior. Face detection counts are boxes per sampled frame, not
unique people; use `--match <photo>` for a specific person and `crop` when
you need durable cropped image evidence. If a local video lacks descriptive
content evidence, add it to the index with `overcast index add ./clip.mp4 --to
<id>`; overcast will create the missing `watch` record for local case memory.

### Reading large records

A verb's JSON record can carry a large field (a `watch` `content` timeline, a
long `listen` transcript). Don't reconstruct it by `head`/`tail`-ing the raw
`.overcast/records/*.jsonl` — that truncates and silently drops the middle.
Page it deterministically instead:

```bash
overcast case memory get <record-id>                              # manifest: field names + sizes (chars)
overcast case memory get <record-id> --field content --offset 0 --limit 16000 --json
# repeat with the returned next_offset until has_more is false; offsets are in chars
```

## Setup

`overcast doctor` checks readiness (pi, system ffmpeg, Cloudglue creds, the
tinycloud CLI). `overcast setup provider <verb> <spec>` rebinds a verb to your
own provider with no code changes.

For reusable provider setup, prefer the catalog-backed profile workflow:

```bash
overcast provider setup show --profile default --json
overcast provider setup plan --preset cloudglue --profile default --json
overcast provider setup apply --preset cloudglue --profile default --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json
overcast provider setup apply --verb face --choice deepface-local --profile local --yes --json
overcast provider init listen --profile recon --json
overcast doctor --profile recon --json
```

Catalog presets include `cloudglue`, `hf`, `fal`, `elevenlabs`,
`owl-local`, and `deepface-local`. `face:deepface-local` selects local DeepFace for
plain `face <video>` detection and `face <video> --match <image>` matching;
`deepface-local` remains the case-owned local face DB/index type for searchable
reference sets.

Provider setup is profile/global state and can span many cases. Case setup is
per-investigation state: target, sources/media, memory/indexes, and automation
policy.

```bash
overcast case setup edit \
  --provider "listen:elevenlabs,see:owl-local" \
  --provider-indexable "listen,see" \
  --auto-sense "watch,listen" \
  --auto-index-new \
  --findings review \
  --yes --json
```

Use `overcast case setup edit --no-auto-index-new --yes --json` to disable
automatic indexing later without removing the selected providers or auto-sense
chain.
