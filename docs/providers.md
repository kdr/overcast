# Authoring overcast providers

> For how providers fit into end-to-end investigations (setup, scan/monitor,
> ask/brief, indexes), see [`flows.md`](flows.md). This doc is the provider
> authoring + binding reference.

overcast binds verbs to backends through **providers**. There is one wire
contract (the **record**) and three transports: `exec` (default), `http`,
`in-proc`. Three provider classes share the same machinery — **sense**
(`watch`/`listen`/`see`/`enhance`), **source** (scrapers), and **memory**
(`write`/`recall`).

## The exec wire contract

An exec provider is a command invoked three ways:

| Invocation | Purpose |
|---|---|
| `<cmd> init` | one-time setup / cred check. Exit `13` = needs credentials. |
| `<cmd> describe` | print capabilities + payload shape (JSON on stdout). |
| `<cmd> run --input <ref> [--opt v] --json` | do the work; print record JSON(L) on stdout, logs on stderr. |

A non-zero exit is a hint; the record's `state`/`error` is authoritative.
overcast maps stdout to the loose record at the exec boundary — your provider
just needs to emit `{ verb, format, payload, media?, meta?, state? }`.

## Binding a provider

```bash
# sense provider (per verb)
overcast setup provider watch  "exec:./examples/providers/bash/watch.sh"
overcast setup provider listen "exec:python3 examples/providers/python/listen.py"
overcast setup provider see    "exec:node --import tsx examples/providers/ts/see.ts"
overcast setup provider see    "http://localhost:8090"          # http transport
overcast provider init see                                      # run the init hook

# source provider (scraper) — bound by source type, enumerated by scan/capture
overcast source add tiktok:@some_user
OVERCAST_SOURCE_TIKTOK_CMD="bash examples/providers/sources/tiktok.sh" \
  overcast scan --source tiktok --pull
```

Bindings live in the active profile (`~/.overcast/profiles/<name>.json`), so they
travel with `--profile`. **Rebinding a verb requires no overcast code changes** —
the default tinycloud `watch`/`listen` and the `see` placeholder are just the
out-of-the-box descriptors.

## Provider setup wizard and non-interactive profiles

Use `provider setup` when you want a catalog-backed, scriptable profile setup
instead of hand-writing provider specs. This is usually **profile/global** work:
run it once per machine/profile, then reuse that profile across cases.

```bash
overcast provider setup show --profile recon --json
overcast provider setup plan --preset cloudglue --profile recon --json
overcast provider setup apply --preset cloudglue --profile recon --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json
overcast provider init listen --profile recon --json
overcast doctor --profile recon --json
```

`plan` never writes the profile. `apply` requires `--yes`; without it, the command
returns a pending confirmation record with the exact planned changes. The older
`setup provider <verb> <spec>` command remains the expert/manual escape hatch.

Catalog presets:

| preset | choices |
|---|---|
| `cloudglue` | `watch:tinycloud`, `listen:tinycloud`, `face:tinycloud`, `enhance:ffmpeg` |
| `hf` | `see:hf`, `enhance:hf` |
| `fal` | `see:fal`, `enhance:fal` |
| `elevenlabs` | `listen:elevenlabs`, `enhance:elevenlabs` |
| `owl-local` | `see:owl-local` |
| `deepface-local` | `face:deepface-local` |

Common environment:

| choice | env |
|---|---|
| `tinycloud` | `CLOUDGLUE_API_KEY` |
| `hf` | `HF_TOKEN` |
| `fal` | `FAL_KEY` |
| `elevenlabs` | `ELEVENLABS_API_KEY` |
| `owl-local` | optional `DETECT_MODEL` |
| `deepface-local` | optional `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY` |

After provider/profile setup, use `case setup` for per-investigation policy:

```bash
overcast case setup edit \
  --provider "listen:elevenlabs,see:owl-local" \
  --provider-indexable "listen,see" \
  --auto-sense "watch,listen" \
  --auto-index-new \
  --findings review \
  --yes --json
```

This records which provider choices the case expects, which outputs can feed
local memory/indexing, and whether `scan --pull` / `monitor` should run senses
automatically for newly discovered media. Explicit `--pipe` on `scan` or
`monitor` still overrides setup automation for that run. Use
`case setup edit --no-auto-index-new --yes --json` to disable automatic indexing
later without removing the selected providers or auto-sense chain.

Runtime execution follows the active profile binding. Case setup records
provider choice/policy metadata and can clear built-ins such as
`enhance:ffmpeg`, but it does not pin a stale exec descriptor after the profile
is rebound with `provider setup apply` or `setup provider`.

`scan --pull` and `monitor` use the same per-hit processing model: resolve
`media.ref` or `payload.url`, capture when needed, run an explicit `--pipe` or
setup automation/default watch, then classify the item as completed, pending,
credential-blocked, or failed. Refless hits are explicit processing errors in
both commands. Monitor records hard failures once and marks them seen; pending
or credential-blocked items are left retryable for the next pass.

## Hugging Face providers (turnkey when `HF_TOKEN` is set)

overcast ships Hugging Face Inference API providers so `see` and model-based
`enhance` work out of the box once `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) is set:

- **`see`** — auto-defaults to a HF vision-LLM captioner ([`examples/providers/hf/see.sh`](../examples/providers/hf/see.sh)) when `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) is present (else the placeholder). Override the model with `HF_SEE_MODEL` (default `google/gemma-3-27b-it`). Forwards `--ocr` / `--detect` / `--prompt`.
- **`enhance` (image)** — opt-in HF model ops ([`examples/providers/hf/enhance.py`](../examples/providers/hf/enhance.py), needs `huggingface_hub` + `pillow`). Image **upscale/unblur/restore works** via the **fal-ai** provider, routed through your `HF_TOKEN` (the HF way — billed to your HF account, no fal key needed; uses the free monthly credit then pay-as-you-go). The **default stays the internal ffmpeg toolkit**; bind to opt in:
  ```bash
  overcast setup provider enhance "exec:python3 examples/providers/hf/enhance.py {{input}}"
  overcast enhance ./blurry.jpg          # -> upscaled/unblurred media.enhanced record
  ```
  Default model `prithivMLmods/Qwen-Image-Edit-2511-Unblur-Upscale` (override `HF_ENHANCE_IMAGE_MODEL`; provider `HF_ENHANCE_PROVIDER`, default `fal-ai`). **Caveat:** these are diffusion *editing* models — they synthesize plausible detail (not faithful super-resolution), so flag it for forensic use.
- **`enhance` (audio)** — **not available via HF** (audio-to-audio isn't a HF Inference-Providers task; 0 hosted models). Use ffmpeg (`enhance --ops denoise,normalize`) or bind a Replicate-direct provider (`resemble-ai/resemble-enhance`) / self-host. `enhance.sh` (curl) remains for a dedicated HF Inference Endpoint via `HF_ENHANCE_ENDPOINT`.

## fal.ai providers (`FAL_KEY`)

Direct fal.ai providers (verified working) — bind to opt in:

```bash
overcast setup provider see     "exec:bash examples/providers/fal/see.sh {{input}}"      # florence-2 caption / --ocr
overcast setup provider enhance "exec:bash examples/providers/fal/enhance.sh {{input}}"  # image: esrgan · audio: deepfilternet3
```
- **see** → `fal-ai/florence-2-large` (detailed caption; `--ocr` for text).
- **enhance image** → `fal-ai/esrgan` (faithful Real-ESRGAN super-resolution — better for forensic use than diffusion editors).
- **enhance audio** → `fal-ai/deepfilternet3` (speech denoise + 48 kHz). Models override via `FAL_ENHANCE_IMAGE_MODEL` / `FAL_ENHANCE_AUDIO_MODEL`.

## ElevenLabs providers (`ELEVENLABS_API_KEY`)

```bash
overcast setup provider listen  "exec:bash examples/providers/elevenlabs/listen.sh {{input}}"   # Scribe speech-to-text
overcast setup provider enhance "exec:bash examples/providers/elevenlabs/enhance.sh {{input}}"  # voice isolator (audio)
```
- **listen** → ElevenLabs Speech-to-Text (Scribe) → transcript + word-level `segments[]` with `media.at` anchors + language.
- **enhance** → ElevenLabs Voice Isolator (strips background noise/music → clean speech).

## Object detection (`see` — open-vocabulary, local)

A zero-shot **object detector** that takes a list of target objects (`--detect`)
and an image **or a video** (frames are sampled with the system ffmpeg) and
returns bounding boxes. It runs **locally** via `transformers` — no fixed COCO
vocabulary, no remote API:

```bash
pip install torch transformers pillow scipy     # Grounding DINO also needs `timm`
overcast setup provider see "exec:python3 examples/providers/detect/detect.py"

overcast see ./scene.jpg --detect "car, person, license plate" --json
overcast see ./clip.mp4  --detect "weapon, hard hat" --json      # video → frames sampled, each box carries `at`
overcast crop <see-record-id> --all --class person --json        # materialize detections as cropped evidence
```

- Default model **OWLv2** (`google/owlv2-base-patch16-ensemble`) — small, CPU-friendly. Switch to **Grounding DINO** with `DETECT_MODEL=IDEA-Research/grounding-dino-tiny`. Both run through the `zero-shot-object-detection` pipeline, so `--detect` is the open-vocabulary candidate-label list.
- Emits a `see` record: `payload.detections = [{ label, score, box:{xmin,ymin,xmax,ymax}, at? }]` (the `at` second is present for video frames) plus `payload.counts` per label. Local memory indexes compact counts/categories, not the raw detection array.
- Run `overcast crop <see-record-id> --all [--class person]` to write cropped JPEG evidence under `.overcast/media/crops/`. Each crop record carries source record/media, crop source media, timestamp/frame, class/id, confidence, and bbox provenance and is searchable case evidence.
- Env: `DETECT_MODEL`, `DETECT_THRESHOLD` (default 0.1), `DETECT_MAX_FRAMES` (default 8). overcast passes `OVERCAST_FFMPEG` / `OVERCAST_FFPROBE` (the system ffmpeg/ffprobe) so video frame extraction works.
- *Note:* `nvidia/LocateAnything-3B` is a higher-quality open-vocab grounding model but it's a 3B VLM (~7.7 GB, GPU-class); swap it in via a local-transformers provider if you have the hardware.

## Visual DBs (`image-ransac`, `deepface-local`, `face-cluster`)

Visual DBs are selected by **index type**. The DeepFace face detector can
also be selected as a profile provider with `face:deepface-local`, but the searchable
local face DBs are the index types: `deepface-local` (1:1 match against reference
images) and `face-cluster` (group unknown faces into people; see below). Local
index types can be stood up per case with `index create --local`, and the `case
setup` wizard's `--index` path materializes them too (e.g.
`case setup --index people:face-cluster`). They use shipped Python
providers under `examples/providers/visual-db/` and a uv-managed Python
environment:

```bash
scripts/visual-db-uv.sh          # image matching: opencv-python + numpy
scripts/visual-db-uv.sh --face   # face matching too: deepface + tf-keras
overcast doctor --json              # reports uv + visual-db readiness

overcast provider setup apply --verb face --choice deepface-local --profile local --yes --json
overcast face ./clip.mp4 --profile local --fps 0.5 --max-frames 32 --json
```

If `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY` is unset, overcast first
uses `.dev/visual-db-py/bin/python` when present, then falls back to
`python3`.

Image matching is an OpenCV SIFT/ORB + RANSAC DB for logos, buildings, signs,
and landmarks:

```bash
overcast index create logos --type image-ransac --local --json
overcast index add ./starbucks-logo.jpg --to logos --json
overcast image match ./clip.mp4 --index logos --min-inliers 8 --min-ratio 0.25 --fps 0.7 --draw --json
```

Face matching is a local DeepFace DB keyed by reference images:

```bash
overcast index create localfaces --type deepface-local --local --json
overcast index add ./person.jpg --to localfaces --json
overcast face ./clip.mp4 --match ./person.jpg --index localfaces --fps 0.5 --max-frames 32 --min-similarity 20 --json
overcast face --match ./person.jpg --index localfaces --json
```

Face **clustering** (`face-cluster` index type + the `cluster` verb) is a
persistent local face DB that groups *unknown* faces into people, instead of
matching against known references. It ingests faces out of clips/images, stores
their embeddings + provenance, and maintains cluster assignments under
`.overcast/index/<id>/` (`faces.jsonl`, `clusters.json`, `crops/`). Clustering
needs face **embeddings**, which the tinycloud face path does not expose, so this
rides exclusively on the local DeepFace provider — and it defaults to the
clustering-grade **Facenet512** model + **retinaface** detector (both hard
`deepface` deps, so `scripts/visual-db-uv.sh --face` provides them; override with
`OVERCAST_FACE_MODEL` / `OVERCAST_FACE_DETECTOR`):

```bash
overcast index create people --type face-cluster --local --json
overcast cluster add ./clipA.mp4 --index people --fps 0.5 --max-frames 20 --json  # detect → embed → assign-or-create
overcast cluster add ./clipB.mp4 --index people --json                            # a face joins its person, or starts a new one
overcast cluster list --index people --json                                       # the people in the DB (size, timespan, sources)
overcast cluster identify ./who.jpg --index people --json                         # most-similar person, or "reads as a NEW person"
overcast cluster recluster --index people --min-similarity 55 --json              # batch re-group (average-linkage); labels carry forward
overcast cluster label p_1 "Jane Doe" --index people --json                       # the stable identity across recluster
overcast cluster view --index people --json                                       # self-contained HTML contact sheet (base64 crops)
```

Similarity is on the tinycloud 0–100 percent scale. With Facenet512, same-person
crops score ~65–90 and different people ~≤35, so the default `--min-similarity 55`
separates cleanly; noisy/low-res inputs may want a higher floor. In case memory,
`cluster add`/`identify` records are evidence — indexed as compact summaries only
("ingested 11 faces → 5 new people", "closest person: …") — while DB reads and
maintenance (`list`/`show`/`view`/`label`/`recluster`) stay operational; the
embeddings, crops, and assignments live in the typed local index, not case memory.

Both emit ordinary Overcast records (`image.match` or `face.analysis`) and write
local artifacts under the case `.overcast/` store. Local-grep/qmd memory indexes
should index the records and summaries only; do not ingest raw media, embeddings,
sampled frames, face boxes, or match visualization images as text. Add `note`,
`watch`, `listen`, or `see` records when the visual result needs narrative
context for text search. For videos, `--fps` controls sample cadence and
`--max-frames` caps the sampled frames; if neither is passed, the local providers
sample 8 frames.

## Samples (runnable, in this repo)

- [`examples/providers/bash/watch.sh`](../examples/providers/bash/watch.sh) — the canonical tinycloud `watch` exec provider.
- [`examples/providers/python/listen.py`](../examples/providers/python/listen.py) — a local-whisper `listen` provider (exec/http).
- [`examples/providers/ts/see.ts`](../examples/providers/ts/see.ts) — a VLM `see` provider (exec/in-proc).
- [`examples/providers/hf/{see,enhance}.sh`](../examples/providers/hf/) — Hugging Face captioner + model-enhance.
- [`examples/providers/elevenlabs/{listen,enhance}.sh`](../examples/providers/elevenlabs/) — ElevenLabs Scribe STT + Voice Isolator audio enhance.
- [`examples/providers/fal/{see,enhance}.sh`](../examples/providers/fal/) — fal.ai Florence-2, ESRGAN image enhance, and DeepFilterNet3 audio enhance.
- [`examples/providers/detect/detect.py`](../examples/providers/detect/detect.py) — OWLv2 open-vocabulary `see` object detector (OWLv2 / Grounding DINO), image + video.
- [`examples/providers/visual-db/{image_match,face_match}.py`](../examples/providers/visual-db/) — local image RANSAC and DeepFace matching for visual DB indexes.
- [`examples/providers/sources/{youtube,tiktok,web}.sh`](../examples/providers/sources/) — yt-dlp + Apify + web-search (Tavily/Brave) source providers.

## Source providers (built-in types)

`scan`/`monitor` enumerate sources; `capture` fetches. Built-in types resolve to shipped scripts:
- **`youtube`** — yt-dlp (no key). Supported refs: `youtube:@handle` for a channel's videos; `youtube:search:<query>` or `youtube:<keyword>` for keyword search; `youtube:playlist:<id>` or `youtube:<full YouTube URL>` for playlists/video URLs.
- **`tiktok`** — Apify (`APIFY_TOKEN`). Supported refs: `tiktok:@user` for profile videos and `tiktok:#tag` for hashtag videos. TikTok keyword search is not a built-in mode.
- **`web`** — Tavily (`TAVILY_API_KEY`, preferred) or Brave (`BRAVE_API_KEY`). Supported ref: `web:<query>` for web search hits.
- Any type via `OVERCAST_SOURCE_<TYPE>_CMD="<base cmd>"` (the fixture/e2e mechanism).

For local-media-only cases, `scan` falls back to local case media/indexes instead
of erroring on missing sources. If an image target and face-analysis or local
visual index are present, it suggests/runs the matching search. Local visual DB
searches scan candidate case media against the reference images already stored in
the local indexes; they do not search the target/reference image by itself. Local
visual DB fan-out is capped by `--limit` (default 5). Use `scan --local` to force
this local path even when external sources are registered.

Each responds to `describe` offline:

```bash
./examples/providers/bash/watch.sh describe
python3 examples/providers/python/listen.py describe
node --import tsx examples/providers/ts/see.ts describe
bash examples/providers/sources/tiktok.sh describe
```

## Memory providers

`ask`/`brief` read through bound **memory** providers (fan-out). The always-on
default is `local-grep`, which scans indexable fields from `.overcast/records`
(`note.text`, `watch.content`, `listen.transcript`, scan titles/snippets, etc.).
Only primary evidence records are eligible for memory and briefs: read/meta and
operational bookkeeping records (`ask`, `brief`, `case`, `setup`, `doctor`,
`index`, `target`, `source`, `prebrief`, legacy `collection`, etc.) are excluded even if they contain matching
text. Remote indexes stay explicit through the case index mirror and
`ask --index`. Face and object detection records are searchable only through
compact summary fields (summaries, counts, categories, moments), not raw boxes,
thumbnail blobs, or full detection arrays. `crop` records are fully searchable
evidence because they are curated local media artifacts with source
record/media/time/class/id/box provenance. For local videos, `index add <video>
--to <id>` creates a missing `watch` record before registering the video remotely
so local-grep has useful descriptive content immediately and qmd can ingest it
on the next rebuild.
`local` remains an alias for scripts. Inspect it with:

```bash
overcast case memory list --json
overcast case memory index status --json
overcast ask "where did we see the white van?" --json
```

For optional local semantic search, bind qmd:

```bash
npm install -g @tobilu/qmd
overcast setup memory qmd
overcast case memory index rebuild --memory qmd --json
overcast ask "where did we see the white van?" --deep --json
overcast ask "where did we see the white van?" --memory qmd --json
```

The qmd backend materializes markdown docs under `.overcast/index/case-search/qmd`,
tracks the embedding model/config and a content fingerprint in
`case memory index status`, and defaults to `embeddinggemma-300M-Q8_0`. Override
with `OVERCAST_QMD_CMD`, `OVERCAST_QMD_MODEL`, or profile fields (`command`,
`model`, `clearTemplate`, `indexTemplate`, `embedTemplate`, `queryTemplate`).
Rebuilds remove the named qmd collection before re-adding the freshly
materialized docs, so rerunning after new notes/watch records is safe. qmd
queries do not auto-rebuild a missing/stale index; use
`case memory index rebuild --memory qmd` first.
Confirmed `case clear --yes` also best-effort removes configured qmd
collections before deleting `.overcast/index`, so external qmd cache state does
not survive a case reset.
`case memory index start` creates a background rebuild job and `retry` reruns a
failed/stale rebuild. Plain `ask` remains local-grep; `ask --deep` selects
configured semantic providers such as qmd, and `--memory qmd` forces that
provider explicitly. `overcast doctor` reports qmd as an optional check when it
is installed or configured.

For typed remote retrieval, `ask --index <id>` queries a tinycloud-backed
**media-descriptions** index directly (see below) — the public-verb realization
of the portable/remote tier.

## Case setup state

`case setup` is the first-run case wizard and setup-management namespace. It
saves the mutable current setup model in `.overcast/setup.json`: case name,
targets, setup notes, sources, indexes/default signals, selected local media,
and per-video routing. Every apply/edit also emits an immutable `case` record
with `payload.op = "startup_setup"` or `"startup_setup_update"`, before/after
summaries, and the planned/applied operations. Those records are operational
history and remain excluded from memory/brief evidence; notes added through
setup are separate `note` records and stay searchable. Setup treats local case
search and remote collections separately: exactly one local backend is always
configured (`local-grep` by default for local keyword/citation search, or `qmd`
for configured local semantic memory). Local memory defaults to `note`, `watch`,
`listen`, `see`, and `scan` evidence, including source/search metadata from web,
YouTube, TikTok, and similar scans. `face-analysis`, `media-descriptions`, and
`entities` are optional tinycloud-backed remote collections for larger/portable
video search. When setup applies with local videos routed to remote collections,
overcast creates or attaches those collections and starts `index add` ingestion
immediately; pass `--no-index` when you only want to save the setup state.

```bash
overcast case setup plan --target "@pier9" --memory local-grep --source "web:pier 9" --json
overcast case setup --name "dock-incident" --target "@pier9" --memory local-grep --source "web:pier 9" --yes --json
overcast case setup status --json
overcast case setup edit --source "youtube:@channel" --yes --json
```

## Faces (`face`) and indexes (`index`) — tinycloud ≥ 0.3.4

These two verbs are backed by the tinycloud CLI's newer **face** and underlying
library collection surfaces (invariant #9: public verbs only; mapped to the loose
record by the shared `runTinycloud` boundary in
[`src/providers/tinycloud/envelope.ts`](../src/providers/tinycloud/envelope.ts)).
Point `OVERCAST_TINYCLOUD_CMD` at a specific binary/wrapper if `tinycloud` isn't
on `PATH`; `overcast doctor` reports the installed version, warns below 0.3.4,
and recommends the latest tested tinycloud, currently 0.3.6.

### `face` — detect / match / search

One verb resolves to one of four tinycloud face ops from the inputs given:

```bash
overcast face ./clip.mp4 --thumbnails --json             # detect: who is in this video (boxes + provider frame thumbnails)
overcast face ./clip.mp4 --match ./suspect.jpg --json    # match: find this person in the clip (JPEG/PNG query image), ranked by similarity
overcast face --match ./suspect.jpg --index <id> --json   # search a face-analysis index (case-wide)
overcast face ./clip.mp4 --index <id> --json        # list a video's stored detections in an index
overcast crop <face-record-id> --all --class face --json  # crop detections into local evidence images
```

Emits a `face.analysis` record: `faces[]` is normalized (`at`, `box`,
`similarity`, `thumbnail?`) and the full provider data survives in `detailed`.
The video/reference may be a path, URL, or a case record id. The `--match`
query image must be JPEG/PNG; tinycloud 0.3.6 rejects webp/heic/gif/bmp/tiff/avif
at preflight. Bind your own
detector with `setup provider face <spec>` like any sense (it receives the media
plus `--match`/`--index`/… as flags).

`face` records index their compact headline/moments for case memory, but not the
raw `faces[]` boxes or thumbnails. Use `crop` when you need durable, searchable
cropped face images; pass `--thumbnails` to preserve provider frame images for
crop extraction when available. `crop` is separate from `enhance`: `enhance`
transforms a whole media item, while `crop` extracts cited regions from
detection evidence.

### `index` — index a target's videos, then read by type

An index is a Cloudglue-backed corpus of videos, searchable one way per **type**.
overcast keeps a local mirror in `.overcast/indexes.json` (the OSINT twin of
the source/target registries) so the case knows what it owns; the create/attach/
add/show/delete ops run on tinycloud. Use `attach` for an existing remote index;
use `add` only when registering media into an index.

```bash
# media-descriptions → ask / probe across every indexed video
overcast index create case-media --type media-descriptions --json
overcast index attach existing-media-index --json       # mirror an existing remote index into this case
overcast scan --pull --json                          # gather the target's videos into the case
overcast index add --all --to <id> --json       # register every captured/sensed video
overcast index add ./local.mp4 --to <id> --json # also creates missing watch evidence locally
overcast ask "what objections came up?" --index <id> --json
overcast ask "moments a document is signed" --index <id> --probe --json

# face-analysis → find a person across the whole index
overcast index create faces --type face --json
overcast index attach existing-face-index --type face --json
overcast index add ./clip.mp4 --to <face-id> --json
overcast face --match ./suspect.jpg --index <face-id> --json

# entities → same-schema extraction across all videos, fetched per video
overcast index create people --type entities --prompt "people, orgs, locations" --json
overcast index entities <ent-id> ./clip.mp4 --json

overcast index list --json                      # the case's indexes (mirror)
overcast index list --remote --json             # account-level tinycloud indexes
overcast index attach <remote-id-or-name> --json # bind an existing remote index to the case
overcast index show <id> --json                 # live status: files[].status
overcast index delete <id> --json
```

`--type` accepts the canonical tinycloud names (`media-descriptions`,
`entities`, `face-analysis`, `rich-transcripts`) and friendly aliases (`media`,
`face`, …). Entities indexes require `--prompt` or `--schema`. `add`/`entities`
accept a path, URL, or a case record id (a `capture`/`watch` record → its media).

## Readiness

`overcast doctor` checks pi, the system ffmpeg/ffprobe, Cloudglue creds, the
tinycloud CLI **and its version** (`face`/`index` need ≥ 0.3.4), the
home/profiles, and the active provider bindings. Version 0.3.6 is the current
recommended tinycloud build.
