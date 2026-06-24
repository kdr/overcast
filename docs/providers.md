# Authoring overcast providers

overcast binds verbs to backends through **providers**. There is one wire
contract (the **record**) and three transports: `exec` (default), `http`,
`in-proc`. Three provider classes share the same machinery — **sense**
(`watch`/`listen`/`see`/`enhance`), **source** (scrapers), and **memory**
(`write`/`recall`). This doc is derived from
[`planning/05-providers.md`](../planning/05-providers.md).

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

## Samples (runnable, in this repo)

- [`examples/providers/bash/watch.sh`](../examples/providers/bash/watch.sh) — the canonical tinycloud `watch` exec provider.
- [`examples/providers/python/listen.py`](../examples/providers/python/listen.py) — a local-whisper `listen` provider (exec/http).
- [`examples/providers/ts/see.ts`](../examples/providers/ts/see.ts) — a VLM `see` provider (exec/in-proc).
- [`examples/providers/hf/{see,enhance}.sh`](../examples/providers/hf/) — Hugging Face captioner + model-enhance.
- [`examples/providers/sources/{youtube,tiktok,web}.sh`](../examples/providers/sources/) — yt-dlp + Apify + web-search (Tavily/Brave) source providers.

## Source providers (built-in types)

`scan`/`monitor` enumerate sources; `capture` fetches. Built-in types resolve to shipped scripts:
- **`youtube`** — yt-dlp (no key). `source add youtube:@handle` · `youtube:search:"…"` · `youtube:playlist:<id>`.
- **`tiktok`** — Apify (`APIFY_TOKEN`). `source add tiktok:@user` · `tiktok:#tag`.
- **`web`** — Tavily (`TAVILY_API_KEY`, preferred) or Brave (`BRAVE_API_KEY`). `source add web:"<query>"` → web search hits.
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
`local` provider indexes `.overcast/records`). A `cloudglue` memory provider
(collection-backed, via public tinycloud verbs) is the A-spec second tier.

## Readiness

`overcast doctor` checks pi, the vendored ffmpeg/ffprobe, Cloudglue creds, the
tinycloud CLI, the home/profiles, and the active provider bindings.
