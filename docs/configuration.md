# Configuration

Binding backends to verbs, the profile system, and the full environment-variable
surface. For **authoring** your own provider (manifest schema, `provider
install`), see [providers.md](providers.md); for the verb + source reference, see
[verbs.md](verbs.md); for end-to-end flows, the [Field Manual](field-manual.md).

## Providers

overcast binds verbs to backends through **providers** over one wire contract
(the loose **record**). The `exec` transport (a command) is what ships today;
`http` and `in-proc` are reserved in the binding shape but not yet wired. Rebind
a verb with **no code changes**:

```bash
overcast provider setup apply --verb see --choice fal --yes           # fal.ai Florence-2 caption/OCR (FAL_KEY)
overcast provider setup apply --verb listen --choice elevenlabs --yes # ElevenLabs Scribe STT (ELEVENLABS_API_KEY)
overcast setup memory qmd       # optional local semantic case search
overcast case memory index rebuild --memory qmd --json
overcast ask "where did we see the white van?" --deep --json
```

Shipped provider scripts live in [`providers/`](../providers) (sources / senses /
engines), each dir carrying a **`provider.json` manifest**; the catalog + source
registry are built by scanning those at runtime, and bindings reference the
scripts as location-independent `shipped:<relpath>` refs resolved at run time, so
profiles survive the install moving. **Add your own provider** by authoring a
manifest package and installing it — no code changes, no fork:

```bash
overcast provider create myfeed --kind source   # scaffold a package (provider.json + script)
overcast provider install ./myfeed --yes         # register it (→ installed: refs, catalog, doctor)
overcast provider list --installed               # or remove / --upgrade
```

A source package makes a new `scan`/`monitor` type; a sense package a new
`--choice`. For a throwaway backend, the un-manifested escape hatch (a bare
script bound by raw `exec:` / `OVERCAST_SOURCE_<TYPE>_CMD`) still works — the
teaching demos are in [`examples/providers/`](../examples/providers). Full authoring
guide + manifest schema: [providers.md](providers.md).

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
Single choices use `--verb <watch|listen|see|face|similar|audio|voice|enhance|screenshot|reconstruct> --choice <id>`,
such as `listen:elevenlabs`, `see:fal`, `see:hf`, `see:owl-local`,
`face:deepface-local`, `similar:basic-clip`, `audio:audio-fp`, `voice:voice-print`,
`enhance:ffmpeg`, `screenshot:playwright`, or `reconstruct:fal`.

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
| **sense** | watch / listen / see / face / image / audio / voice / similar / cluster / enhance / reconstruct / exif / verify / screenshot (`chronolocate` is pure local solar math — no provider) | Cloudglue (default), the brain LLM (default `see`), local CLIP (`similar`), local CLAP (audio `similar`), local voice-print / wespeaker (`voice`), Hugging Face, fal.ai (see/enhance/`reconstruct`), ElevenLabs, ffmpeg, ExifTool (`exif`), c2patool (`verify`), headless Chromium / Playwright (`screenshot`), Nominatim (opt-in `exif --geocode`) |
| **source** | scan / capture / monitor | youtube (yt-dlp), dl (any yt-dlp host), tiktok / x / instagram / telegram / lens / yandeximg / facesearch (Apify), web (Tavily/Brave), dork (Serper.dev — Google dorking), shodan (Shodan host recon), gdelttv (GDELT TV, no key), overpass (OpenStreetMap features, no key), firms (NASA FIRMS active fires), dispatch (Socrata police calls-for-service, no key), flights (OpenSky ADS-B), webcam (Windy Webcams), browser (headless Chromium page render), and the opt-in **identity** sources username / person / phone / property / plate (Apify — authorized use only) |
| **memory** | ask / brief | `local-grep` case search (always on); optional lifecycle-managed qmd semantic search; typed tinycloud media indexes via `ask --index` |

For every built-in source ref (`youtube:@handle`, `dispatch:sf`, `shodan:<ip>`,
the identity sources, …) see [verbs.md](verbs.md#built-in-source-refs).

## Profiles

A **profile** is a named set of bindings — per-verb providers plus the brain LLM —
persisted under `~/.overcast/profiles/` (`OVERCAST_HOME`). Build one by binding
into it, then select it per command (or for the whole session):

```bash
# build / extend a profile named "fal"
overcast provider setup apply --verb see --choice fal --yes --profile fal        # catalog choice → shipped: ref
overcast setup provider watch "exec:bash examples/providers/bash/watch.sh {{input}}" --profile fal  # raw bind (your own script)
overcast setup llm anthropic claude-sonnet-4-6 --profile fal

# use it: per command …
overcast see ./img.jpg --json --profile fal
# … or for the session
OVERCAST_PROFILE=fal overcast see ./img.jpg --json

overcast setup show --profile fal     # inspect a profile's bindings
```

The default profile is `default`. Point `--home <dir>` at a different store to
keep profiles per-case or per-project. To build ready-made presets (e.g. `fal`,
`cloudglue`, `recon`) from the bundled providers:

```bash
bash examples/profiles/install-profiles.sh   # then: overcast <verb> … --profile <name>
```

## Environment variables

`overcast --help` prints the full, current list; [`.env.example`](../.env.example)
is the annotated template. Highlights:

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
- `FIRMS_MAP_KEY` — the `firms` active-fire source (free NASA FIRMS map key)
- `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` — optional OAuth2 for the `flights` ADS-B source (anonymous access works; creds raise rate limits)
- `APIFY_TOKEN` — the `tiktok`, `x`, `instagram`, `telegram`, `lens`, `yandeximg`, `facesearch` sources AND the opt-in identity sources `username`/`person`/`phone`/`property`/`plate` (enumerate; fetch uses yt-dlp / direct CDN). Actor overrides: `OVERCAST_X_ACTOR`, `OVERCAST_INSTAGRAM_ACTOR`, `OVERCAST_TELEGRAM_ACTOR`, `OVERCAST_LENS_ACTOR`, `OVERCAST_YANDEX_ACTOR` (+ `OVERCAST_YANDEX_IMAGE_KEY`), `OVERCAST_FACE_SEARCH_ACTOR`, `OVERCAST_MAIGRET_ACTOR`, `OVERCAST_PERSON_ACTOR`, `OVERCAST_PHONE_ACTOR`, `OVERCAST_PROPERTY_ACTOR`
- `OVERCAST_PLATE_ACTOR` — **required** for the `plate` source (no default — US plate data is DPPA-restricted; bind an Apify actor, or use `OVERCAST_SOURCE_PLATE_CMD` for a direct plate API). Vehicle spec only, not the owner
- `WINDY_API_KEY` — the `webcam` source (Windy Webcams API; free tier covers scan + still capture + monitor). Base override: `OVERCAST_WEBCAM_API`
- `gdelttv`, `overpass`, `dispatch`, and `browser` need **no key** (`dispatch` optionally takes a `SOCRATA_APP_TOKEN` to raise rate limits)
- `youtube` and `dl` need `yt-dlp` on `PATH` (no key) — install a build with curl_cffi impersonation (`pipx install "yt-dlp[default,curl-cffi]"` or a [standalone release binary](https://github.com/yt-dlp/yt-dlp#installation); brew/apt builds lack it, so TLS-fingerprinting hosts like domain-restricted Vimeo embeds fail — `overcast doctor` flags this)
- `OVERCAST_YTDLP_CMD` — override the `yt-dlp` binary/wrapper every yt-dlp-backed source uses (e.g. a pipx or standalone install shadowed on `PATH` by an older brew one)
- `OVERCAST_YTDLP_ARGS` — extra flags injected into **every** yt-dlp call (e.g. `--referer https://embedding-site/ --impersonate chrome` for domain-restricted embeds); script-set flags win on conflict
- `OVERCAST_SOURCE_<TYPE>_CMD` — one-off override for a source provider command (to *add* a persistent source type, author a `provider.json` package + `provider install`)

**Runtime / session** — `OVERCAST_HOME` (profiles, default `~/.overcast`),
`OVERCAST_CASE` / `OVERCAST_PROFILE` (set by the launcher from `--case` / `--profile`),
`OVERCAST_MEDIA_DIR` (set by overcast for exec providers), `OVERCAST_PI_ONLINE`.

**Man in the chair** — `OVERCAST_CHAIR=1` auto-starts the remote bridge on TUI
launch (same as `--chair`); `OVERCAST_CHAIR_BIND` (default `127.0.0.1` — keep it
off public interfaces; `/chair on tailnet` binds your Tailscale address) /
`OVERCAST_CHAIR_PORT` (default `7373`); `OVERCAST_CHAIR_TOKEN` pins the pairing
token (default: a fresh random token every `/chair on`); `OVERCAST_CHAIR_URL`
sets the public HTTPS origin the QR points at (same as `/chair on --url`, for
voice over a reverse proxy); `OVERCAST_TAILSCALE_CMD` overrides the `tailscale`
invocation used by `--serve` / auto-detect (custom path or offline tests).

**Situation** — `OVERCAST_SITUATION=1` auto-starts the live monitoring page on TUI
launch (same as `--situation`); `OVERCAST_SITUATION_BIND` (default `127.0.0.1` —
keep it off public interfaces) / `OVERCAST_SITUATION_PORT` (default `7374`);
`OVERCAST_SITUATION_TOKEN` pins the pairing token (default: a fresh random token per
serve); `OVERCAST_SITUATION_URL` sets the explicit public origin its QR points at;
`OVERCAST_SITUATION_MAX_PASSES` caps `situation --every` monitor passes
(testing/scheduling). Remote (scraped) thumbnails/video embed in the page only when
`OVERCAST_REPORT_REMOTE_MEDIA=1` (off = no IP beacon to the investigated host).

**Visual DBs** — `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY`
override the Python used by local `image-ransac` and `deepface-local` indexes. If
unset, overcast auto-detects `.dev/visual-db-py/bin/python` created by
`scripts/visual-db-uv.sh`, then falls back to `python3`.

**Brain LLM** — BYO via pi-ai: *any* pi-ai provider key works
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …). Cloudglue is also a
pickable brain in `/model` when its key is set — never forced.
