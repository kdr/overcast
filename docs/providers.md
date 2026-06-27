# Authoring overcast providers

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
```

- Default model **OWLv2** (`google/owlv2-base-patch16-ensemble`) — small, CPU-friendly. Switch to **Grounding DINO** with `DETECT_MODEL=IDEA-Research/grounding-dino-tiny`. Both run through the `zero-shot-object-detection` pipeline, so `--detect` is the open-vocabulary candidate-label list.
- Emits a `see` record: `payload.detections = [{ label, score, box:{xmin,ymin,xmax,ymax}, at? }]` (the `at` second is present for video frames) plus `payload.counts` per label.
- Env: `DETECT_MODEL`, `DETECT_THRESHOLD` (default 0.1), `DETECT_MAX_FRAMES` (default 8). overcast passes `OVERCAST_FFMPEG` / `OVERCAST_FFPROBE` (the system ffmpeg/ffprobe) so video frame extraction works.
- *Note:* `nvidia/LocateAnything-3B` is a higher-quality open-vocab grounding model but it's a 3B VLM (~7.7 GB, GPU-class); swap it in via a local-transformers provider if you have the hardware.

## Samples (runnable, in this repo)

- [`examples/providers/bash/watch.sh`](../examples/providers/bash/watch.sh) — the canonical tinycloud `watch` exec provider.
- [`examples/providers/python/listen.py`](../examples/providers/python/listen.py) — a local-whisper `listen` provider (exec/http).
- [`examples/providers/ts/see.ts`](../examples/providers/ts/see.ts) — a VLM `see` provider (exec/in-proc).
- [`examples/providers/hf/{see,enhance}.sh`](../examples/providers/hf/) — Hugging Face captioner + model-enhance.
- [`examples/providers/detect/detect.py`](../examples/providers/detect/detect.py) — local open-vocabulary `see` object detector (OWLv2 / Grounding DINO), image + video.
- [`examples/providers/sources/{youtube,tiktok,web}.sh`](../examples/providers/sources/) — yt-dlp + Apify + web-search (Tavily/Brave) source providers.

## Source providers (built-in types)

`scan`/`monitor` enumerate sources; `capture` fetches. Built-in types resolve to shipped scripts:
- **`youtube`** — yt-dlp (no key). Supported refs: `youtube:@handle` for a channel's videos; `youtube:search:<query>` or `youtube:<keyword>` for keyword search; `youtube:playlist:<id>` or `youtube:<full YouTube URL>` for playlists/video URLs.
- **`tiktok`** — Apify (`APIFY_TOKEN`). Supported refs: `tiktok:@user` for profile videos and `tiktok:#tag` for hashtag videos. TikTok keyword search is not a built-in mode.
- **`web`** — Tavily (`TAVILY_API_KEY`, preferred) or Brave (`BRAVE_API_KEY`). Supported ref: `web:<query>` for web search hits.
- Any type via `OVERCAST_SOURCE_<TYPE>_CMD="<base cmd>"` (the fixture/e2e mechanism).

Each responds to `describe` offline:

```bash
./examples/providers/bash/watch.sh describe
python3 examples/providers/python/listen.py describe
node --import tsx examples/providers/ts/see.ts describe
bash examples/providers/sources/tiktok.sh describe
```

## Memory providers

`ask`/`brief` read through bound **memory** providers (fan-out; the always-on
`local` provider indexes `.overcast/records`). For collection-backed retrieval,
`ask --collection <id>` queries a tinycloud **media-descriptions** collection
directly (see below) — the public-verb realization of the A-spec second tier.

## Faces (`face`) and collections (`collection`) — tinycloud ≥ 0.3.4

These two verbs are backed by the tinycloud CLI's newer **face** and **library
collections** surfaces (invariant #9: public verbs only; mapped to the loose
record by the shared `runTinycloud` boundary in
[`src/providers/tinycloud/envelope.ts`](../src/providers/tinycloud/envelope.ts)).
Point `OVERCAST_TINYCLOUD_CMD` at a specific binary/wrapper if `tinycloud` isn't
on `PATH`; `overcast doctor` reports the installed version and warns below 0.3.4.

### `face` — detect / match / search

One verb resolves to one of four tinycloud face ops from the inputs given:

```bash
overcast face ./clip.mp4 --json                          # detect: who is in this video (boxes + timestamps)
overcast face ./clip.mp4 --match ./suspect.jpg --json    # match: find this person in the clip, ranked by similarity
overcast face --match ./suspect.jpg --collection <id> --json   # search a face-analysis collection (case-wide)
overcast face ./clip.mp4 --collection <id> --json        # list a video's stored detections in a collection
```

Emits a `face.analysis` record: `faces[]` is normalized (`at`, `box`,
`similarity`, `thumbnail?`) and the full provider data survives in `detailed`.
The video/reference may be a path, URL, or a case record id. Bind your own
detector with `setup provider face <spec>` like any sense (it receives the media
plus `--match`/`--collection`/… as flags).

### `collection` — index a target's videos, then read by type

A collection is a Cloudglue index of videos, searchable one way per **type**.
overcast keeps a local mirror in `.overcast/collections.json` (the OSINT twin of
the source/target registries) so the case knows what it owns; the create/add/
show/delete ops run on tinycloud.

```bash
# media-descriptions → ask / probe across every indexed video
overcast collection create case-media --type media-descriptions --json
overcast scan --pull --json                          # gather the target's videos into the case
overcast collection add --all --to <id> --json       # register every captured/sensed video
overcast ask "what objections came up?" --collection <id> --json
overcast ask "moments a document is signed" --collection <id> --probe --json

# face-analysis → find a person across the whole index
overcast collection create faces --type face --json
overcast collection add ./clip.mp4 --to <face-id> --json
overcast face --match ./suspect.jpg --collection <face-id> --json

# entities → same-schema extraction across all videos, fetched per video
overcast collection create people --type entities --prompt "people, orgs, locations" --json
overcast collection entities <ent-id> ./clip.mp4 --json

overcast collection list --json                      # the case's collections (mirror)
overcast collection show <id> --json                 # live status: files[].status
overcast collection delete <id> --json
```

`--type` accepts the canonical tinycloud names (`media-descriptions`,
`entities`, `face-analysis`, `rich-transcripts`) and friendly aliases (`media`,
`face`, …). Entities collections require `--prompt` or `--schema`. `add`/`entities`
accept a path, URL, or a case record id (a `capture`/`watch` record → its media).

## Readiness

`overcast doctor` checks pi, the system ffmpeg/ffprobe, Cloudglue creds, the
tinycloud CLI **and its version** (`face`/`collection` need ≥ 0.3.4), the
home/profiles, and the active provider bindings.
