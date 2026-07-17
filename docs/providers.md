# Authoring overcast providers

> For how providers fit into end-to-end investigations (setup, scan/monitor,
> ask/brief, indexes), see [`flows.md`](flows.md). This doc is the provider
> authoring + binding reference.

overcast binds verbs to backends through **providers**. There is one wire
contract (the **record**) and one wired transport: `exec` (the default). The
binding shape also declares `http` and `in-proc`, but those are **not yet
wired** — `runBoundProvider` errors on them — so always bind an exec provider.
Three provider classes share the same machinery — **sense**
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
just needs to emit `{ verb, format, payload, media?, meta?, state? }`. To start a
provider of your own, scaffold a package with `overcast provider create`
(see [Authoring a new provider](#authoring-a-new-provider)); the runnable
teaching demos under [`examples/providers/`](../examples/providers) (bash /
python / TypeScript, one per class) show the same contract for the bind-by-hand
escape hatch.

## Binding a provider

For anything overcast **ships**, bind through the catalog wizard — it persists a
location-independent descriptor (a `shipped:` ref, next section) instead of a
filesystem path:

```bash
overcast provider setup show --json                              # catalog: choices + presets (+ resolved paths)
overcast provider setup plan --verb enhance --choice ela --json  # inspect the descriptor before writing
overcast provider setup apply --verb enhance --choice ela --yes  # write it to the profile
overcast provider setup apply --preset fal --yes                 # or a whole preset
overcast provider init enhance                                   # run the init hook
```

For a provider **you wrote**, the reusable path is a manifest package
(`provider create` → `provider install`, see [Authoring a new
provider](#authoring-a-new-provider)). For a quick throwaway, bind a raw `exec:`
spec — the escape hatch for un-manifested user code (the demos exercise this):

```bash
# sense provider (per verb)
overcast setup provider watch "exec:bash ./examples/providers/bash/watch.sh"
# (an `http://…` spec parses into the binding shape, but the http transport is
#  not wired yet — it errors at run time; wrap your endpoint in an exec script)
overcast provider init watch                                    # run the init hook

# source provider (scraper) — bound by source type, enumerated by scan/capture
overcast source add tiktok:@some_user
OVERCAST_SOURCE_TIKTOK_CMD="bash my-tiktok.sh" \
  overcast scan --source tiktok --pull
```

Bindings live in the active profile (`~/.overcast/profiles/<name>.json`), so they
travel with `--profile`. **Rebinding a verb requires no overcast code changes** —
the default tinycloud `watch`/`listen` and the default `see` backend are just the
out-of-the-box descriptors.

## Shipped providers and `shipped:` refs

The shipped, supported provider scripts live in the top-level
[`providers/`](../providers) tree, grouped by role:

- `providers/sources/` — the scan/capture/monitor scrapers (exec argv contract);
- `providers/senses/` — the bindable sense/enhance/forensics providers
  (hf / fal / elevenlabs / tinycloud / detect / geocode / exif / verify /
  local / enhance ela+panorama);
- `providers/engines/` — internal engines called only through TS shims
  (visual-db, audio-db, the screenshot renderer) — never user-bound.

Catalog descriptors reference these as **`shipped:<relpath>`** tokens (relpath
from the package root, e.g. `shipped:providers/senses/enhance/ela.py`,
`shipped:scripts/visual-db-uv.sh`). The profile persists the *ref*; it resolves
to this install's absolute path at spawn time — so a binding survives the
install moving (an nvm switch, a binary relocation, a folder rename).
`provider setup show`/`plan` include the resolved absolute path per choice
(`resolved`) for transparency. Profiles and case-setup policies written by older
builds (absolute `examples/providers/…` or `providers/…` paths) are **healed on
load**: recognized paths rewrite to `shipped:` refs in memory and persist on the
next profile write; `overcast doctor` (the `provider-paths` check) flags any
`shipped:` ref or stale shipped path that doesn't resolve in this build — re-run
`overcast provider setup apply --verb <verb> --choice <id> --yes` to fix.
`examples/providers/` holds only authoring demos: teaching code for the wire
contract, bound by raw `exec:` path.

Each shipped provider directory carries a **`provider.json` manifest** declaring
its entries (sense choices and/or source types), env vars, and preset
contributions. The catalog + source registry are built by scanning these at
runtime, so adding a provider is a matter of dropping in a directory — see
installable packages below.

## Installable provider packages (`provider install`)

A provider **package** is a directory (or a `.tgz`/`.tar.gz` tarball) shaped like
a shipped provider dir: a `provider.json` manifest plus its exec scripts. Install
one from a local path — there is no registry fetch (a package runs unsandboxed on
untrusted media, so the source must be something you already have on disk):

```bash
overcast provider create myfeed --kind source     # scaffold ./myfeed (provider.json + myfeed.sh)
overcast provider install ./myfeed                 # dry-run: prints what it would register
overcast provider install ./myfeed --yes           # installs into <home>/providers/myfeed/
overcast provider list --installed                 # name, version, entries, provenance, tamper flag
overcast provider install ./myfeed --upgrade --yes # replace an installed package of the same name
overcast provider remove myfeed --yes              # uninstall
```

Installed packages resolve through **`installed:<pkg>/<relpath>`** refs (the
sibling of `shipped:`), against `<home>/providers/<pkg>/`. Once installed, a
source type is usable everywhere a shipped one is (`source add <type>:<ref>`,
`scan`, `monitor`, `doctor --sources`); a sense choice appears in `provider setup
apply --verb <verb> --choice <id>`. Install **rejects collisions** with a shipped
(or already-installed) choice id / source type / preset name, and the package
names `sources`/`senses`/`engines` are reserved. Install stamps
`.overcast-install.json` (origin + a sha256 tree hash); `provider list
--installed` and `doctor` flag a package whose files changed since install
(`tampered`). A manifest's `presets` and `hosts` extend the preset map and the
`capture <url>` host router respectively.

## Authoring a new provider

Two ways to add a backend — pick by how you'll use it:

1. **A package** (recommended for anything reusable or shareable) — a
   `provider.json` manifest + exec scripts, scaffolded by `provider create`,
   installed by `provider install`. This is how the shipped providers themselves
   are structured; it gets you catalog listing (`provider setup apply --choice
   <id>`), `source add <type>`, `doctor --sources`, presets, and portable
   `installed:` refs.
2. **A one-off bind** (the escape hatch) — a bare script with no manifest, bound
   by `setup provider <verb> "exec:<cmd>"` (sense) or `OVERCAST_SOURCE_<TYPE>_CMD`
   (source). Good for a throwaway backend or learning the wire contract; the
   runnable teaching demos live in [`examples/providers/`](../examples/providers).

Both speak the same [exec wire contract](#the-exec-wire-contract) — the only
difference is whether a manifest registers the provider or you bind it by hand.

### Walkthrough — a sense provider (per verb: see / enhance / listen / …)

```bash
overcast provider create myvlm --kind sense        # → ./myvlm/{provider.json, myvlm.sh}
# 1. edit myvlm/myvlm.sh — implement describe / init / run --input, emit ONE record
bash ./myvlm/myvlm.sh describe                      # sanity-check the contract offline
# 2. edit myvlm/provider.json — set verb (default "see"), label/summary, env, indexableDefault
overcast provider install ./myvlm --yes            # register it (validates + collision-checks)
overcast provider setup apply --verb see --choice myvlm --yes   # bind `see` to it
overcast see photo.jpg                              # run the verb through your provider
```

The scaffolded `run` op emits a record via `jq`; replace the `TODO` with your
model call. `run` **must** map its output to the loose record
(`{verb, format, payload, media?, state?}`) — overcast persists it verbatim.

### Walkthrough — a source provider (a new `scan`/`monitor` type)

```bash
overcast provider create myfeed --kind source      # → ./myfeed/{provider.json, myfeed.sh}
# edit myfeed/myfeed.sh:
#   enumerate --query <q> [--limit N] [--since S] → a JSON ARRAY of scan.hit objects
#   fetch --url <u> --out <path>                   → download to <path>, emit a capture record
overcast provider install ./myfeed --yes
overcast source add myfeed:some-query              # register a standing ref for the case
overcast scan --source myfeed --pull               # enumerate + capture
```

Ref grammars (e.g. `myfeed:@handle` vs `myfeed:#tag`) are parsed **inside your
script** — overcast passes whatever follows the first colon as `--query`, so the
TS layer needs no per-type knowledge. Document them in the manifest's `refForms`.

### The `provider.json` manifest

One manifest per package directory. Top level:

| Field | Purpose |
|---|---|
| `manifest_version` | schema version — `1`. |
| `name` | package id (lowercase `[a-z0-9._-]`); the install dir name + `installed:<name>/…` namespace. `sources`/`senses`/`engines` are reserved. |
| `version` | informational semver string. |
| `entries[]` | one or more sense/source entries (below). |
| `presets?` | named `{verb,choice}` bundles this package contributes (must reference its own entries). |

A **sense** entry:

```jsonc
{ "kind": "sense", "id": "myvlm", "verb": "see",
  "label": "My VLM", "summary": "…",
  "env": ["MY_API_KEY"],            // surfaced as missing_env in setup/plan
  "indexableDefault": true,          // does its output feed ask/brief evidence
  "descriptor": {                    // exec templates; refs resolved at spawn
    "type": "exec",
    "run":      "bash installed:myvlm/myvlm.sh --input {{input}}",
    "init":     "bash installed:myvlm/myvlm.sh init",
    "describe": "bash installed:myvlm/myvlm.sh describe" } }
```

A **source** entry:

```jsonc
{ "kind": "source", "type": "myfeed", "aliases": ["mf"],
  "label": "My Feed", "summary": "…",
  "base": ["bash", "installed:myfeed/myfeed.sh"],   // op (enumerate|fetch|init) appended
  "needs": "MY_API_KEY", "env": ["MY_API_KEY"],
  "timeoutMs": 360000,                               // per-op budget for slow backends
  "doctor": { "check": "env_all", "env": ["MY_API_KEY"],
              "okNote": "MY_API_KEY present", "missingNote": "MY_API_KEY missing" },
  "hosts": ["myfeed.example"],                        // ad-hoc `capture <url>` routing
  "refForms": [{ "form": "myfeed:@handle" }, { "form": "myfeed:#tag" }] }
```

The `doctor.check` variants: `env_all` / `env_any` (present-checks over `env`),
`keyless` (always ok, show `okNote`), `probe_init` (run `<base> init` — exit 0 =
ready / 13 = needs creds), `reuse_playwright` (share the Playwright check). Omit
`doctor` for a source with no credential check.

Two optional **capability flags** widen what the seam forwards to a source:

- `"uncappedLimit": true` — the source honors `--limit 0` as "enumerate
  everything" (yt-dlp local enumeration: youtube, dl). Sources WITHOUT it never
  see a 0 — a `--limit 0` scan omits the flag entirely so the provider's own
  default cap applies (an Apify actor handed 0 could read it as unlimited
  billing; a SODA/SERP API as zero rows).
- `"fetchKinds": ["transcript", "thumb"]` — alternate fetch modes the provider
  serves instead of the default media download; `fetch` then receives
  `--kind <k>` (and `--lang <code>` for transcripts). `--transcript`/`--thumb`
  on capture/scan/monitor only route to sources declaring the kind — everyone
  else keeps their normal pull path.

**Ref tokens** in a manifest's command strings / `base`:
`shipped:<relpath>` (the shipped `providers/` tree), `installed:<pkg>/<relpath>`
(an installed package — what `provider create` writes), `{{input}}` (the media
ref, rendered at spawn), and `{{env:VAR|default}}` (an env value resolved when the
choice is materialized — e.g. a venv python: `{{env:DETECT_PY|python3}}`).

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
| `fal` | `see:fal`, `enhance:fal`, `reconstruct:fal` |
| `elevenlabs` | `listen:elevenlabs`, `enhance:elevenlabs` |
| `owl-local` | `see:owl-local` |
| `local-models` | `enhance:local-models` (on-device separate + segment) |
| `deepface-local` | `face:deepface-local` |
| `basic-clip` | `similar:basic-clip` |
| `audio-fp` | `audio:audio-fp` |
| `basic-clap` | `similar:basic-clap` |
| `voice-print` | `voice:voice-print` |
| `playwright` | `screenshot:playwright` (headless-Chromium page render) |

Common environment:

| choice | env |
|---|---|
| `tinycloud` | `CLOUDGLUE_API_KEY` |
| `hf` | `HF_TOKEN` |
| `fal` | `FAL_KEY` |
| `elevenlabs` | `ELEVENLABS_API_KEY` |
| `owl-local` | optional `DETECT_MODEL` |
| `deepface-local` | optional `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY` |
| `basic-clip` | optional `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY`, `OC_CLIP_MODEL` |
| `local-models` | optional `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY`; `HF_TOKEN` for the gated pyannote `--ops separate` |
| `audio-fp` | optional `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY` |
| `basic-clap` | optional `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY`, `OC_CLAP_MODEL` |
| `voice-print` | optional `OC_VISUAL_DB_PY` / `OVERCAST_VISUAL_DB_PY`, `OVERCAST_VOICE_MODEL`; `HF_TOKEN` for `--diarize` only |

After provider/profile setup, use `case setup` for per-investigation policy:

```bash
overcast case setup edit \
  --provider "listen:elevenlabs,see:owl-local" \
  --provider-indexable "listen,see" \
  --auto-sense "watch,listen" \
  --auto-index-new \
  --findings suggest \
  --yes --json
```

This records which provider choices the case expects, which outputs can feed
local memory/indexing, and whether `scan --pull` / `monitor` should run senses
automatically for newly discovered media. `--findings suggest` (the default)
auto-suggests findings from score/text matches on every evidence verb; `review`
is the legacy text-only mode and `off` disables it. Explicit `--pipe` on `scan`
or `monitor` still overrides setup automation for that run. Use
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

## `see` — the brain LLM by default

`see` defaults to the **brain LLM** whenever it accepts image input: overcast
sends the image plus a "describe this image in detail" instruction directly to
whatever brain the profile/env already resolves (BYO — the turnkey Cloudglue brain
out of the box, or any image-capable `setup llm <provider> <model>`), and maps the
reply to the `see` record (`payload.caption`; `--ocr` also fills `payload.ocr`).
No extra key is needed beyond the brain you already use.

Precedence when you run `see`:

1. an explicit provider binding (`setup provider see <exec spec>` — http/in-proc specs parse but aren't wired yet) — e.g. the OWLv2 detector;
2. the **brain LLM** when it's image-capable (the default);
3. the Hugging Face captioner when `HF_TOKEN` is set;
4. a `needs_credentials` placeholder with guidance.

Switch the built-in backend without editing the profile by hand:

```bash
overcast setup provider see builtin:hf      # force the classic Hugging Face captioner
overcast setup provider see builtin:brain   # force the brain LLM (errors if it has no vision)
OVERCAST_SEE_BRAIN=off overcast see shot.jpg # one-off: skip the brain default (→ HF / placeholder)
```

`--detect` still needs a detection provider (the brain path produces a description,
not bounding boxes) — bind one, e.g. `provider setup apply --preset owl-local --yes`
(boxes), or the opt-in Cloudglue tinycloud provider below (boxless presence facts).

`see` also takes an **http(s) image URL** directly: the image is downloaded into
the case media dir first (evidence, like `capture` — the record's `media.ref` is
the local artifact, `meta.source_url` the origin), so every backend reads a local
file. A URL that resolves to video/audio is redirected to `watch`/`listen`, and a
non-image response (login wall, expired signed URL returning HTML) errors clearly.

## Cloudglue tinycloud `see` provider (opt-in, tinycloud ≥ 0.3.7)

tinycloud 0.3.7 adds an image `see` verb (the file-level counterpart of `watch`:
title + description + on-screen text) and **image sources for `extract`**
(feature flags `see.v1` / `extract.images.v1`). The shipped wrapper
([`providers/senses/tinycloud/see.sh`](../providers/senses/tinycloud/see.sh))
maps them onto overcast's `see` — bind to opt in; the defaults above are unchanged:

```bash
overcast provider setup apply --verb see --choice tinycloud --profile default --yes
# (the catalog descriptor keeps a `bash …` wrapper deliberately: a run template
#  that starts with `tinycloud` is treated as the built-in default binding and
#  skipped for `see`.)

overcast see ./scene.jpg --ocr --json                          # tinycloud see → caption + on-screen text
overcast see ./scene.jpg --prompt "what safety gear?" --json   # tinycloud extract → payload.extract facts
overcast see ./scene.jpg --detect "person, hard hat" --json    # extract checklist → boxless detections
```

- **Default / `--ocr`** → `tinycloud see` (**JPEG/PNG/WebP only**; results cache by
  source, so re-runs are free). `payload.caption` = title + description; `--ocr`
  fills `payload.ocr` from the image's on-screen text.
- **`--prompt`** → `tinycloud extract "<prompt>" <image>`: structured facts land
  under `payload.extract`.
- **`--detect "a,b"`** → an extract checklist per label → `payload.detections =
  [{label, present, count, evidence}]` plus `payload.counts` — **no bounding
  boxes**, so `crop` does not apply; bind the local OWLv2 detector (below) when
  you need boxes.
- `init` checks Cloudglue creds (`CLOUDGLUE_API_KEY` or `~/.tinycloud/config.json`)
  and requires the `see.v1` feature — run `tinycloud update` on older installs.
  Override the CLI invocation with `OVERCAST_TINYCLOUD_CMD`.

## Hugging Face providers (`see` fallback + model-based `enhance`)

overcast ships Hugging Face Inference API providers so the `see` captioner and
model-based `enhance` work once `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) is set:

- **`see`** — the fallback captioner ([`providers/senses/hf/see.sh`](../providers/senses/hf/see.sh)), used when the brain LLM has no vision (or when forced via `setup provider see builtin:hf` / `OVERCAST_SEE_BRAIN=off`). Override the model with `HF_SEE_MODEL` (default `google/gemma-3-27b-it`). Forwards `--ocr` / `--prompt` (`--detect` is ignored — this captioner can't produce boxes; bind the OWLv2/fal detector for that).
- **`enhance` (image)** — two opt-in HF paths (the **default stays the internal ffmpeg toolkit**):
  - **Shipped, catalog-backed** ([`providers/senses/hf/enhance.sh`](../providers/senses/hf/enhance.sh)) — a curl HF Inference-Endpoint enhance; bind with the wizard, no raw path:
    ```bash
    overcast provider setup apply --verb enhance --choice hf --yes   # persists a shipped: ref
    ```
    Point it at your endpoint with `HF_ENHANCE_ENDPOINT`.
  - **Python demo** ([`examples/providers/python/enhance.py`](../examples/providers/python/enhance.py), needs `huggingface_hub` + `pillow`) — image **upscale/unblur/restore** via the **fal-ai** provider routed through your `HF_TOKEN` (the HF way — billed to your HF account, no fal key needed; free monthly credit then pay-as-you-go). This is an authoring demo (the sanctioned raw-`exec:` escape hatch), a *different* backend from the shipped script above:
    ```bash
    overcast setup provider enhance "exec:python3 examples/providers/python/enhance.py {{input}}"
    overcast enhance ./blurry.jpg          # -> upscaled/unblurred media.enhanced record
    ```
    Default model `prithivMLmods/Qwen-Image-Edit-2511-Unblur-Upscale` (override `HF_ENHANCE_IMAGE_MODEL`; provider `HF_ENHANCE_PROVIDER`, default `fal-ai`). **Caveat:** these are diffusion *editing* models — they synthesize plausible detail (not faithful super-resolution), so flag it for forensic use.
- **`enhance` (audio)** — **not available via HF** (audio-to-audio isn't a HF Inference-Providers task; 0 hosted models). Use ffmpeg (`enhance --ops denoise,normalize`) or bind a Replicate-direct provider (`resemble-ai/resemble-enhance`) / self-host. `enhance.sh` (curl) remains for a dedicated HF Inference Endpoint via `HF_ENHANCE_ENDPOINT`.

## fal.ai providers (`FAL_KEY`)

Direct fal.ai providers (verified working) — bind to opt in:

```bash
overcast provider setup apply --preset fal --yes   # see (florence-2) + enhance (esrgan/deepfilternet3) + reconstruct
# or individually: overcast provider setup apply --verb see|enhance|reconstruct --choice fal --yes
```
- **see** → `fal-ai/florence-2-large` (detailed caption; `--ocr` for text).
- **enhance** is a **toolbox** dispatched by `--ops`: image → `fal-ai/esrgan`, audio → `fal-ai/deepfilternet3`; `--ops separate` → `fal-ai/sam-audio/separate`, `--ops segment` → `fal-ai/sam-3/image`. Models override via `FAL_ENHANCE_IMAGE_MODEL` / `FAL_ENHANCE_AUDIO_MODEL` / `FAL_SEPARATE_MODEL` / `FAL_SEGMENT_MODEL`. See **Enhance split ops** below.
- **reconstruct** is a **toolbox** dispatched by `--ops`: camera reposition / `sweep` → `fal-ai/qwen-image-edit-2511-multiple-angles`, `model` → `fal-ai/trellis` (image→3D GLB, via the fal **queue API**), `depth` → `fal-ai/image-preprocessors/depth-anything/v2`. Models override via `FAL_RECONSTRUCT_VIEW_MODEL` / `FAL_RECONSTRUCT_MESH_MODEL` (e.g. `fal-ai/hunyuan3d-v3/image-to-3d`) / `FAL_RECONSTRUCT_DEPTH_MODEL`; queue knobs `FAL_QUEUE_POLL_S` / `FAL_QUEUE_TIMEOUT_S`. See **Speculative reconstruction** below.

## Forensic senses — `exif` (metadata + GPS, no key)

`exif` runs the system **ExifTool** over an image or video and emits a
`media.metadata` record: a searchable `summary` plus signed-decimal `gps`
(`{lat,lng[,altitude]}`), capture time, camera `make`/`model`, editing
`software`, camera `serial`/`lens` (a device-linking fingerprint),
MIME/dimensions/duration, and a total tag count. Highest-leverage
"where/when/what device" evidence, before any AI.

```bash
brew install exiftool   # or: apt install libimage-exiftool-perl
overcast exif ./photo.jpg          # -> media.metadata record (GPS, device, capture time)
overcast exif <capture-id|record>  # a captured clip's metadata (video GPS tracks too)
overcast exif ./photo.jpg --geocode  # + reverse-geocode GPS to a place (needs a bound geocode provider)
```

Default backend: the shipped [`providers/senses/exif/exif.sh`](../providers/senses/exif/exif.sh)
(system `exiftool`; `exit 13` → `needs_credentials` when absent). Bind your own
with `setup provider exif <spec>`. Only the compact
`summary`/`gps`/`place`/device (`make`/`model`/`software`/`serial`/`lens`) fields
are indexed into case memory — the full raw tag dump stays in the record for
exact reads. `overcast doctor` reports whether `exiftool` is on PATH; set
`OVERCAST_EXIFTOOL_CMD` to point the shipped script (and doctor) at a custom
path/wrapper.

### Geolocation — reverse geocode + evidence map

`exif` extracts raw coordinates; two surfaces turn them into "where":

- **`exif --geocode`** resolves `payload.gps` to a place name via an **opt-in**,
  ToS-gated `geocode` provider (never bound by default — reverse geocoding
  egresses the subject's coordinates to a third party, so it needs both the flag
  AND a bound provider). The shipped
  [`providers/senses/geocode/geocode.sh`](../providers/senses/geocode/geocode.sh)
  uses OSM **Nominatim** (no API key; sets a User-Agent and honors ~1 req/s —
  point `OVERCAST_GEOCODE_URL` at your own Nominatim/Photon for volume, override
  the agent with `OVERCAST_GEOCODE_UA`). Bind it with:

  ```bash
  overcast provider setup apply --verb geocode --choice nominatim --yes
  overcast exif ./photo.jpg --geocode   # -> payload.place = "…, San Francisco, California, …"
  ```

- **`overcast map`** plots every case record carrying `payload.gps` on one
  self-contained HTML map (markers link back to each source, with the geocoded
  place + thumbnail). Online mode fetches OSM raster tiles in the viewer's browser
  at view time (the map JS is inlined — no CDN dependency); `--offline` degrades
  to a coordinate scatter with per-point `openstreetmap.org` links and zero
  network egress. Live tiles reveal the viewer's IP + the investigated location to
  OpenStreetMap — prefer `--offline` when that matters.

  ```bash
  overcast map --no-open           # write .overcast/media/map.html (online OSM tiles)
  overcast map --offline           # no network: scatter + openstreetmap.org deep links
  ```

### Device-linking — `overcast devices`

`overcast devices` is a case-wide rollup that groups `exif` records by camera
fingerprint (make + model + `serial` + `lens`) and reports media shot on the same
device. A serial is a durable per-device id (a strong link); serial-less media
fall back to a weaker make+model+lens hint. Pure read over case memory (no index).
With `--findings` it emits `suggested` findings for serial-linked clusters
(deduped by fingerprint). Both `map` and `devices` are operational (rendering /
rollup) verbs — their output records stay out of `ask`/`brief` evidence.

`verify` checks a media file's embedded **C2PA / Content Credentials** manifest
via **c2patool** and emits a `media.provenance` record: `has_manifest`, the claim
generator, the signer/certificate issuer, `validation_state`, and assertion/
ingredient counts. Media with no credentials is a clean `ready` record
(`has_manifest: false`), not an error. This is distinct from source-post
provenance (which records where a record *came from*) — it checks the media's own
signed credentials.

```bash
brew install c2patool   # or: cargo install c2patool
overcast verify ./photo.jpg        # -> media.provenance record (signer, validation state)
```

Default backend: the shipped [`providers/senses/verify/verify.sh`](../providers/senses/verify/verify.sh)
(system `c2patool`; `exit 13` when absent). Bind your own with
`setup provider verify <spec>`. `overcast doctor` reports whether `c2patool` is on
PATH; set `OVERCAST_C2PATOOL_CMD` to point the shipped script (and doctor) at a
custom path/wrapper.

**Forensic triage.** `exif` and `verify` feed the finding queue like the other
senses: an editing-software tag from a known image editor (Photoshop, GIMP,
Lightroom, …) suggests a "possibly edited" lead (medium), and a C2PA manifest
whose `validation_state` is not valid/trusted suggests a "provenance validation
failed" lead (high). GPS-present is deliberately *not* a lead (every phone photo
has it — it feeds the map instead). Toggle these off per case with
`case setup --findings-forensics off`.

## ElevenLabs providers (`ELEVENLABS_API_KEY`)

```bash
overcast provider setup apply --preset elevenlabs --yes   # listen (Scribe STT) + enhance (voice isolator)
```
- **listen** → ElevenLabs Speech-to-Text (Scribe) → transcript + word-level `segments[]` with `media.at` anchors + language.
- **enhance** → ElevenLabs Voice Isolator (strips background noise/music → clean speech).

## Enhance split ops — `separate` (voices) + `segment` (objects)

Two `enhance` ops **split** media into many artifacts instead of returning one
improved file: `--ops separate` isolates each speaker in an audio/video as its own
track, and `--ops segment --prompt "<thing>"` cuts requested objects out of an
image as mask + cutout evidence. Both need a **bound provider** (they are not
ffmpeg ops); pick **local-models** (on-device) or **fal** (hosted) — one binding
exposes both ops:

> **One-time gate for local voice separation:** pyannote
> `speaker-diarization-community-1` is a **gated** Hugging Face model. Before the
> first `--ops separate` run you must (1) set `HF_TOKEN`, and (2) **accept the
> license** — open <https://huggingface.co/pyannote/speaker-diarization-community-1>
> while logged in and click **"Agree and access repository"**. Until then the
> provider returns a clean `needs_credentials` record (not a crash). Local
> `--ops segment` (GroundingDINO + SAM 2.1) is ungated and needs no token.

```bash
# on-device: pyannote diarization + GroundingDINO/SAM 2.1 (Apache-2.0, CPU-ok)
scripts/visual-db-uv.sh --enhance          # installs both stacks into the uv venv
overcast provider setup apply --preset local-models --yes
#   ...or hosted on fal (FAL_KEY): sam-audio + sam-3
overcast provider setup plan --preset fal && overcast provider setup apply --preset fal --yes

overcast enhance interview.mp4 --ops separate --summarize          # per-speaker tracks, each transcribed
overcast enhance photo.jpg     --ops segment  --prompt "the red car"   # mask + RGBA cutout per instance
overcast view <split-op-parent-id>                                 # gallery: audition tracks (audio + spectrograms) or view cutouts
overcast crop <segment-parent-id> --all                            # materialize the same boxes as crops
```

- **Multi-output contract.** A split provider still emits ONE record (the exec wire
  contract), carrying its artifacts in `payload.outputs[] = [{ kind, ref, ... }]`
  (`kind` = `track` | `cutout` | `mask`). The `enhance` verb **fans this out** into
  `[parent, ...children]`: the parent is the audit summary (and, for `segment`,
  mirrors `payload.detections[]` so `crop` works), each child is a first-class
  `enhance` record whose `media.ref` is the artifact and payload carries a compact
  `summary` + provenance (`source_record`, `op`, `kind`, `speaker`/`label`, `box`,
  `segments`). Single-output providers (esrgan, voice-isolator, hf) have no
  `outputs[]` and pass through unchanged. Only the compact summary/label/transcript
  fields are indexed into case memory — mask PNGs, WAV tracks, and raw boxes stay in
  the record.
- **separate** — *local* uses pyannote `speaker-diarization-community-1` (a **GATED**
  model: set `HF_TOKEN` and accept the license) → timeline-preserving per-speaker
  tracks (other speakers muted; `segments[].at` stay valid; overlap regions flagged).
  `--speakers N` hints the speaker count. *fal* uses text-prompted `sam-audio`
  (`--prompt "the man speaking"` → target + residual tracks; loop on the residual for
  N-way). `--summarize` transcribes each track through the bound `listen` provider and
  folds the transcript + a short summary onto the track record (off by default — it's
  N× the listen cost).
- **segment** — *local* runs GroundingDINO-tiny (`--prompt` → boxes) + SAM 2.1-tiny
  (boxes → masks); *fal* runs `sam-3` (up to `SEGMENT_MAX_INSTANCES` masks). Each
  instance writes a binary mask PNG + an RGBA cutout (only those pixels); `--masks-only`
  emits masks instead of cutouts. Image-only — segment a `frame://rec@sec` still of a
  video, not the video. Boxes are crop-compatible (`{xmin,ymin,xmax,ymax}`, with
  `box_normalized` when the model returns normalized coordinates).

## Speculative reconstruction — `reconstruct` (camera reposition / 3D / depth)

`reconstruct` synthesizes what a captured scene *would plausibly* look like from
a camera the investigator never had. It is deliberately quarantined: every
record carries `payload.caveat` (stamped by the verb even when a provider
forgets) and the verb is excluded from ask/brief evidence and findings triggers
— synthesized pixels steer hypotheses, they never prove anything.

```bash
overcast provider setup plan --preset fal && overcast provider setup apply --preset fal --yes   # FAL_KEY

overcast reconstruct scene.jpg --rotate 45 --elevate 30          # reposition the camera on a still
overcast reconstruct clip.mp4 --at 12.5 --rotate 90 --view       # pin a video frame, then rotate around it
overcast reconstruct scene.jpg --ops sweep --count 8             # 8 stops around 360° → contact sheet + turntable mp4
overcast reconstruct scene.jpg --ops model                       # image → textured 3D GLB (fal queue API; minutes)
overcast reconstruct scene.jpg --ops depth                       # estimated depth map
overcast view <parent-id>                                        # gallery / embedded 3D orbit viewer / drag-parallax hologram
```

- **Ops.** `view` (default when `--rotate`/`--elevate`/`--zoom` is given) emits one
  synthesized view; `sweep` emits one child per stop plus a labeled contact sheet
  (`kind:"sheet"`, the grid trick over synthesized stops) and a turntable video
  (`kind:"turntable"`, assembled locally by the internal ffmpeg); `model` emits a
  `kind:"mesh"` GLB; `depth` a `kind:"depth"` map.
- **Multi-output contract.** Same as enhance split ops: ONE provider record with
  `payload.outputs[] = [{kind, ref, ...}]`, fanned out into `[parent, ...children]`
  with `source_record` provenance — plus the caveat stamped on every record.
- **Viewers.** `view <parent-id>` renders the op's viewer: a scriptless CSI gallery
  for view/sweep, an embedded WebGL **3D orbit viewer** for `model` (hand-rolled GLB
  renderer, no CDN, mesh embedded base64; Draco/KTX2-compressed GLBs degrade to an
  explicit message), and a WebGL **parallax hologram** for `depth`. `--view` opens it
  immediately.
- **Queue API.** `--ops model` runs minutes, so the provider submits to
  `queue.fal.run` and polls the returned `status_url` (`FAL_QUEUE_POLL_S`, default
  5s; `FAL_QUEUE_TIMEOUT_S`, default 600s) — the first shipped provider to use fal's
  queue transport; copy it for any other long-running fal model.
- **Cost note.** The Qwen multi-angle LoRA bills ~$0.035/megapixel per synthesized
  view — an 8-stop sweep of a ~1 MP frame is ~$0.28.

## Enhance analysis ops — `ela` (forensics) + `panorama` (stitch)

Two more provider-only `enhance` ops derive analysis artifacts from ONE input and
fan out the same way (parent + children, gallery-able via `overcast view <parent>`).
Both are shipped local Python providers with their own catalog choices — no
fal/local-models preset or API key needed:

```bash
# image forensics: ELA + noise residual + luminance-gradient overlays (pillow + numpy)
overcast provider setup apply --verb enhance --choice ela --yes
overcast enhance suspect.jpg --ops ela          # -> parent + 3 overlay children
#   ...or stitch a panning video into one wide still (opencv-python + numpy)
overcast provider setup apply --verb enhance --choice panorama --yes
overcast enhance pan_shot.mp4 --ops panorama    # -> parent + 1 stitched-still child
overcast view <parent-id>                       # gallery of the overlays / the wide still
```

- **ela** (`providers/senses/enhance/ela.py`, pillow + numpy) — from an image it
  writes three heuristic maps: **ELA** (re-save at JPEG q90, amplify the per-pixel
  abs difference so recompressed/pasted regions light up), **noise residual** (input
  minus a blurred copy, normalized), and a **luminance gradient** (Sobel edge
  magnitude). These are *leads, not proof* — compression, resizing, and texture also
  trigger them (`payload.caveat` says so). Image-only; run it on a `frame://` still of
  a video.
- **panorama** (`providers/senses/enhance/panorama.py`, opencv-python + numpy) —
  samples ~18 frames uniformly across a video (dropping black + near-duplicate
  frames) and runs `cv2.Stitcher` in PANORAMA mode into one wide still, exposing a
  skyline/landmark strip for geolocation that no single frame shows. A failed stitch
  (too little overlap / too much motion) returns a clean error record, not a crash.
  The stitched still is a first-class `media.enhanced` child → `see`/`crop`/reverse-search it.

## Object detection (`see` — open-vocabulary, local)

A zero-shot **object detector** that takes a list of target objects (`--detect`)
and an image **or a video** (frames are sampled with the system ffmpeg) and
returns bounding boxes. It runs **locally** via `transformers` — no fixed COCO
vocabulary, no remote API:

```bash
scripts/visual-db-uv.sh --detect                 # uv-installs torch + transformers + scipy + pillow (Grounding DINO also needs `timm`); prints DETECT_PY
export DETECT_PY=…; overcast provider setup apply --preset owl-local --yes   # persists $DETECT_PY (the venv python) + a shipped: ref for detect.py

overcast see ./scene.jpg --detect "car, person, license plate" --json
overcast see ./clip.mp4  --detect "weapon, hard hat" --json      # video → frames sampled, each box carries `at`
overcast crop <see-record-id> --all --class person --json        # materialize detections as cropped evidence
```

- Default model **OWLv2** (`google/owlv2-base-patch16-ensemble`) — small, CPU-friendly. Switch to **Grounding DINO** with `DETECT_MODEL=IDEA-Research/grounding-dino-tiny`. Both run through the `zero-shot-object-detection` pipeline, so `--detect` is the open-vocabulary candidate-label list.
- Emits a `see` record: `payload.detections = [{ label, score, box:{xmin,ymin,xmax,ymax}, at? }]` (the `at` second is present for video frames) plus `payload.counts` per label. Local memory indexes compact counts/categories, not the raw detection array.
- Run `overcast crop <see-record-id> --all [--class person]` to write cropped JPEG evidence under `.overcast/media/crops/`. Each crop record carries source record/media, crop source media, timestamp/frame, class/id, confidence, and bbox provenance and is searchable case evidence.
- Env: `DETECT_MODEL`, `DETECT_THRESHOLD` (default 0.1), `DETECT_MAX_FRAMES` (default 8). overcast passes `OVERCAST_FFMPEG` / `OVERCAST_FFPROBE` (the system ffmpeg/ffprobe) so video frame extraction works.
- *Note:* `nvidia/LocateAnything-3B` is a higher-quality open-vocab grounding model but it's a 3B VLM (~7.7 GB, GPU-class); swap it in via a local-transformers provider if you have the hardware.

## Visual DBs (`image-ransac`, `deepface-local`, `face-cluster`, `basic-clip`)

Visual DBs are selected by **index type**. The DeepFace face detector can
also be selected as a profile provider with `face:deepface-local`, but the
searchable local face DBs are the index types: `deepface-local` (1:1 match
against reference images) and `face-cluster` (group unknown faces into people;
see below). Create them per case with `index create --local`, or add them in the
setup wizard via `case setup --index "<name>:<type>"` (e.g.
`case setup --index people:face-cluster`; for `basic-clip`, an optional
`@k=v;k=v` config suffix — pairs separated by `;` — pins sampling/pooling; see
below). They use shipped Python providers under
`providers/engines/visual-db/` and a uv-managed Python environment:

```bash
scripts/visual-db-uv.sh          # image matching: opencv-python + numpy
scripts/visual-db-uv.sh --face   # face matching too: deepface + tf-keras
scripts/visual-db-uv.sh --clip   # CLIP semantic search: open_clip + torch + pillow
scripts/visual-db-uv.sh --detect # OWLv2 object detector for see --detect: torch + transformers + scipy
scripts/visual-db-uv.sh --audio  # audio fingerprinting: scipy (see Audio DBs below)
scripts/visual-db-uv.sh --clap   # CLAP audio embeddings: transformers + torch
scripts/visual-db-uv.sh --all    # everything (face + CLIP + detector + audio-fp + CLAP; one shared torch)
overcast doctor --json              # reports uv + visual-db + audio-db readiness

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
separates cleanly; noisy/low-res inputs may want a higher floor. Each index
records the model + detector it was built with and every op that computes with
embeddings (`add`/`identify`/`recluster`) refuses a mismatched
`OVERCAST_FACE_MODEL`/`OVERCAST_FACE_DETECTOR` — embeddings from different
configs don't compare; switch the env back or rebuild the index. In case memory,
`cluster add`/`identify` records are evidence — indexed as compact summaries only
("ingested 11 faces → 5 new people", "closest person: …") — while DB reads and
maintenance (`list`/`show`/`view`/`label`/`recluster`) stay operational; the
embeddings, crops, and assignments live in the typed local index, not case memory.

`basic-clip` is a local OpenAI CLIP (open_clip) DB for **cross-modal semantic
similarity** — find images/video moments that resemble a photo (image→image) or a
phrase (text→image). Members are embedded and cached on `add` (`.npy` under the
index dir); queries only embed the query, do a cosine top-K (scores are
cosine×100, 0–100), and **never write the cache**. Videos are frame-sampled and
pooled (`max` default, or `mean`), or stored per-frame (`--granularity frame`) so
queries return moments with `at`. Sampling is `uniform` windows or, with
`--sampling shots`, tinycloud `watch` shot boundaries (reused from existing watch
evidence when present). The pooling/granularity/sampling config is a property of
the **index**, set at `index create` and persisted to its `config.json` — member
embedding always follows it (`similar add` rejects per-add overrides), while
sampling flags on `similar match` shape only the query video's embedding. Query
with the `similar` verb (`add` / `match` / `search`):

```bash
overcast index create scenes --type basic-clip --local --granularity frame --sampling shots --json
overcast similar add ./clip.mp4 --index scenes --json          # embed + cache (video → frames)
overcast similar add ./photo.jpg --index scenes --json
overcast similar search "a red car at night" --index scenes --limit 10 --json   # text → image
overcast similar match ./query.jpg --index scenes --json                        # image → image
```

The record (`similar.match`) emits ranked `payload.matches[]` (`ref`, `similarity`,
`granularity`, and `at` for frame-level). CLIP model/weights are overridable via
`OC_CLIP_MODEL` (default `ViT-B-32`) and `OC_CLIP_PRETRAINED` (default `openai`);
`OC_CLIP_DEVICE` defaults to `cpu`.

## Audio DBs (`audio-fp`, `basic-clap`)

The audio counterparts of `image-ransac` and `basic-clip`, under
`providers/engines/audio-db/` and the same uv-managed Python (install with
`scripts/visual-db-uv.sh --audio` and/or `--clap`; the `audio-db` doctor check
reports both halves). Both decode a file's first audio stream via the system
ffmpeg (so a **video** member's audio track is used automatically) and follow the
loose-record + `indexes.json` wire contract of the visual-DB scripts.

`audio-fp` is a local **Shazam-style** exact-recording matcher (Wang 2003
constellation hashing: STFT → spectral peak picking → anchor/target-zone pair
hashing → offset-histogram voting; pure numpy/scipy, reimplemented from the paper
and MIT references). `audio add` fingerprints + caches a recording (`fp/<sha1>.npz`
under the index dir, keyed on `config_hash` + `mtime`, mirroring `basic-clip`'s
cache discipline — reads never write). `audio match` fingerprints the query and
votes it against each member (or, in `audio match <query> <reference>`, a single
clip with no index). A match reports the aligned-vote count, the `offset_seconds`
where the query lines up inside the recording, the `match_ratio`, and a `margin`
over the next-best alignment; `--min-votes` (default 6) is the confidence floor and
`--min-ratio` an optional aligned/total ratio floor. Robust to transcode, noise,
and clipping; **not** to pitch/speed change (classic Wang).

`--min-margin` is the exact-copy vs evasive-reupload discriminator. A true exact
match aligns nearly all of its hashes into one offset bin, so its `margin` (best
bin ÷ next-best bin) is enormous — real self-location and transcoded-reupload
matches score **250–1600×**. A *slightly sped-up* copy (a common content-ID evasion)
drifts out of alignment into a small scattered cluster: it can still clear the raw
`--min-votes` floor but its margin collapses to **~1.2–1.7×** (ratio to a few percent,
span to a fraction of the query). `--min-margin 2` (default 1 = off) rejects those
partial alignments while passing every true match. (A `--speed-sweep` that instead
re-fingerprints the query at ±2/±4 % to *match* sped copies is still planned;
`--min-margin` is the complementary knob that *rejects* them.)

A member whose audio is silent or purely tonal produces **0 constellation hashes**
and can never match; `audio add` still succeeds but the record carries a
`payload.warning` so a silent screen-recording isn't mistaken for a searchable member.

`--draw` renders a dependency-free **SVG alignment visualization** per match (the
Shazam analog of `image --draw`'s `cv2.drawMatches`): a scatter of every matching
`(query-time, member-time)` hash pair — a true match is a tight bright band, a
speed-drift/false match is a short scattered cluster — plus the offset-vote
histogram (one sharp spike for a real match). The `.svg` lands in the case media
store under `audio-matches/`, its path in `matches[].match_draw_path`, and the
`brief`/`case status` HTML embeds it exactly like the image-match overlays.

```bash
overcast index create jingles --type audio-fp --local --json
overcast audio add ./original.mp4 --to jingles --json        # fingerprint (video → audio track)
overcast audio match ./suspect.mp4 --index jingles --json    # offset-aligned exact match
overcast audio match ./suspect.mp4 --index jingles --min-margin 2 --json  # reject sped-up re-uploads
overcast audio match ./suspect.mp4 --index jingles --draw --json          # + SVG alignment plot
overcast audio match ./a.mp3 ./b.mp3 --json                  # clip-to-clip, no index
```

`basic-clap` is a local **LAION CLAP** (transformers `ClapModel`) DB for **audio
semantic similarity** — audio→audio (`match`) and text→audio (`search`), the audio
analog of `basic-clip`. It reuses the `similar` verb grammar and the
`basic-clip` cache layout (`emb/<sha1>.npy` + sidecar, 512-d L2-normed vectors,
cosine×100). Audio is chunked into `--window`-second slices (default 10s), pooled
to a track vector, or stored per-window as moments with `--granularity frame`.

```bash
overcast index create sounds --type basic-clap --local --json
overcast similar add ./scene.wav --index sounds --json        # embed + cache (10s windows)
overcast similar match ./query.wav --index sounds --json      # audio → audio (strong: 20–90)
overcast similar search "crowd chanting" --index sounds --json # text → audio
overcast similar search "a person speaking" --index sounds --min-similarity -100 --json  # see full ranking
```

Audio→audio scores are strong and well-separated (same-source clips rank 80–90,
unrelated 20–30). **Text→audio is weaker and low-magnitude** — CLAP text queries
often score near or *below* zero even for the right clip, and short generic phrases
can be unreliable. Because `--min-similarity` defaults to `0`, a text search can
come back empty even when a best candidate exists; the floor now accepts negatives
(`-100…100`, cosine×100's true range), so pass e.g. `--min-similarity -100` to
retrieve the full ranking. For finding a specific sound, audio→audio `match` is far
more reliable than text `search`.

The default model is `laion/larger_clap_general` (Apache-2.0, ~776 MB), overridable
via `OC_CLAP_MODEL`; `OC_CLAP_DEVICE` defaults to `cpu`. **The first CLAP call
downloads the weights** to the Hugging Face cache — pre-warm it (e.g.
`python -c "from transformers import ClapModel; ClapModel.from_pretrained('laion/larger_clap_general')"`),
then set `HF_HUB_OFFLINE=1` for fully offline runs; `overcast doctor` only probes
imports and never triggers a download. **Shared-venv note:** `--clip` (open-clip-torch)
and `--clap` (transformers) both ride torch. Installing both at once with
`scripts/visual-db-uv.sh --all` lets uv resolve a single shared torch; upgrading one
package independently later can bump torch under the other, so prefer `--all` when
you want the full visual+audio stack.

## Voice match DB (`voice-print`)

Speaker verification — the voice twin of `face --match`: given a **reference voice
sample**, find/rank that speaker inside a clip or across enrolled members. Lives in
`providers/engines/audio-db/voice_match.py` on the same uv venv as the other
audio DBs (`scripts/visual-db-uv.sh --voice` — the pyannote stack `enhance --ops
separate` already uses; no extra deps). Distinct from its neighbors: `audio`
(audio-fp) matches the *recording*, `similar` (basic-clap) matches the *content*,
`voice` matches the *speaker*.

```bash
overcast index create voices --type voice-print --local --json
overcast voice add ./interview.mp4 --index voices --json        # enroll (video → audio track)
overcast voice match ./sample.wav --index voices --json         # which members contain this speaker?
overcast voice match ./clip.mp4 ./sample.wav --json             # where does the speaker talk in this clip?
overcast voice match ./clip.mp4 ./sample.wav --diarize --json   # overlap-aware diarize-then-match (HF_TOKEN)
```

The default embedding model is **`pyannote/wespeaker-voxceleb-resnet34-LM`** —
**ungated** on Hugging Face (no token), ~26 MB (downloaded on first use), 256-d
speaker embeddings, weights **CC-BY-4.0** (credit WeSpeaker/pyannote when
redistributing results). Clips are decoded to 16 kHz mono via the system ffmpeg,
gated by a lightweight RMS speech detector (windows with under ~1 s of speech are
skipped and counted in `payload.skipped_windows`), and embedded in 3 s windows
(hop 0.75 s for pairwise scans; members cache non-overlapping windows under
`emb/<sha1>.npy`, the shared basic-clip layout).

**How the windowed scan works.** A speaker-embedding model returns ONE fixed
vector per input regardless of length, so a long clip is never embedded in one go —
`voice match <clip> <sample>` sweeps it with a **sliding window** (default **3 s
wide, 0.75 s hop** → 75 % overlap), embeds each window, and scores it (cosine)
against the pooled reference. That per-moment score curve is what anchors a match to
a timestamp and lets one sample light up at multiple segments; a whole-clip
embedding would instead blur every speaker and moment into a single vector. Windows
with under ~1 s of voiced audio are dropped by the RMS gate **before** embedding
(silence/music costs nothing) and counted in `payload.skipped_windows`. Tune the
scan with `--window` (widen the window; the hop stays 0.75 s) and `--start`/`--end`
(bound the span). Cost scales linearly with the number of voiced windows — each is
one forward pass on `OC_VOICE_DEVICE` (CPU by default; passes run sequentially, not
batched), so a several-minute clip is a few hundred embeddings (seconds to a couple
of minutes on CPU). Two caps bound it: a query scan stops at **2400 windows**
(~30 min at the 0.75 s hop) and enrollment at **1200 non-overlapping windows**
(~60 min), truncating with a warning past that. Enrollment (`voice add`) embeds
**non-overlapping** 3 s windows (hop == window) and caches them, so it's ~4× cheaper
per second than the overlapping query scan. `--diarize` (below) is the exception —
it does not sliding-window at all: it runs the diarization pipeline once and
compares the reference against a handful of per-speaker centroids.

**Scores are rank scores, not probabilities.** Raw cosine is mapped through fixed
anchors — cosine 0.25 → **50** (≈ the accept floor), 0.60 → **90** (strong
same-speaker) — and both `similarity` (0–100) and the raw `cosine` are emitted.
There is no universal speaker-verification threshold; `--min-similarity` defaults
to 50, and suggested findings fire at **80** (`voice`) / high-confidence at **90**
(`voice_high`, tunable via `case setup --findings-threshold voice=…`). `margin` is
a cheap calibration gate (the AS-norm stand-in): best-vs-runner-up speaker in
diarized mode, best-vs-median window otherwise — gate it with `--min-margin`.

**`--diarize` (pairwise only)** upgrades to diarize-then-match: the
`pyannote/speaker-diarization-community-1` pipeline (env `OVERCAST_DIARIZE_MODEL`)
segments speakers with overlap masking, and the reference is compared against the
pipeline's per-speaker **centroids** (same wespeaker embedding space). This tier
is gated exactly like `enhance --ops separate`: it needs `HF_TOKEN` + the
[accepted pyannote license](https://huggingface.co/pyannote/speaker-diarization-community-1);
with no token the match **falls back to windowed mode** (record stays `ready`,
`payload.mode: "windowed"`, with a warning), and a token without the accepted
license returns `needs_credentials`. Diarized speakers with under ~3 s of net
speech are excluded and listed in `payload.skipped_speakers`.

**Caveats (also stamped on every record as `payload.caveat`):** speaker similarity
is **not liveness** — a cloned/synthetic voice can score high (pair with `verify`
/ provenance checks before treating a match as identification); cross-language or
heavily degraded/compressed speech scores lower for the same speaker; references
with under ~3 s of speech get a reliability warning.

The model is **pinned per index** at create time (from `OVERCAST_VOICE_MODEL`,
else the wespeaker default) and the provider refuses to score cached embeddings
with a different model — alternate models (e.g. SpeechBrain ECAPA via
`uv pip install --python "$OC_VISUAL_DB_PY" speechbrain`, or ReDimNet via
torch.hub) need a fresh voice-print index, and `--diarize` requires the default
wespeaker model (the centroids must share its space). `OC_VOICE_DEVICE` defaults
to `cpu` (MPS is experimental for pyannote).

**No hosted default:** Hugging Face serverless inference does not serve
speaker-embedding models (audio tasks are ASR/audio-classification only). If you
need a hosted backend, deploy a dedicated HF Inference Endpoint with a custom
handler and wrap it as an exec provider following the
[`providers/senses/hf/enhance.sh`](../providers/senses/hf/enhance.sh) pattern.

These emit ordinary Overcast records (`image.match`, `face.analysis`, `audio.match`,
`voice.match`, or `similar.match`) and write
local artifacts under the case `.overcast/` store. Local-grep/qmd memory indexes
should index the records and summaries only; do not ingest raw media, embeddings,
sampled frames, face boxes, or match visualization images as text. Add `note`,
`watch`, `listen`, or `see` records when the visual result needs narrative
context for text search. For videos, `--fps` controls sample cadence and
`--max-frames` caps the sampled frames; if neither is passed, the local providers
sample 8 frames.

## Samples (runnable, in this repo)

The authoring **demos** — minimal providers that teach the exec wire contract,
one per language. They're the manifest-*less* on-ramp (bind by hand); for a
package you can install/share, `provider create` scaffolds the manifest version
(see [Authoring a new provider](#authoring-a-new-provider)).

- [`examples/providers/bash/watch.sh`](../examples/providers/bash/watch.sh) — the canonical tinycloud `watch` exec provider.
- [`examples/providers/python/listen.py`](../examples/providers/python/listen.py) — a local-whisper `listen` provider (exec).
- [`examples/providers/ts/see.ts`](../examples/providers/ts/see.ts) — a VLM `see` provider (exec).
- [`examples/providers/python/enhance.py`](../examples/providers/python/enhance.py) — an HF-token-routed image-enhance provider (the Python variant of the shipped hf enhance).
- [`examples/providers/sources/mcp-bridge.ts`](../examples/providers/sources/mcp-bridge.ts) — the MCP-server-as-source prototype (below).

The **shipped, supported** provider code lives under [`providers/`](../providers)
(`sources/` scrapers, `senses/` bindable providers, `engines/` internal engines)
— see "Shipped providers and `shipped:` refs" above. It exercises the same
public exec contract, so it doubles as reference reading, but bind it through
the catalog wizard rather than by path.

## Screenshot engine (`screenshot` verb + `browser` source)

Browser screen capture renders what a page **looks like** — the rendered pixels,
not the raw HTML a plain `capture`/`web` fetch stores. One shipped engine
([`providers/engines/screenshot/`](../providers/engines/screenshot/)) backs two
surfaces:

- **`screenshot <url>` verb** — one-shot render → a `web.screenshot` PNG evidence
  record. Flags: `--full-page` (whole scrollable page, not just the viewport),
  `--viewport WxH` (default `1280x800`), `--wait <ms>` (extra settle after load,
  capped at 15s). Also accepts a **local `.html` file** — render a `wall`/`map`/
  `brief --export` HTML into image evidence. Chain the PNG into `see` (describe/
  OCR), `exif`, `note --ref`, or `archive add`.
- **`browser:<url>` source** — the standing scan/monitor surface (see below). Each
  fetch re-renders the current page state, so `monitor --source browser --every N`
  is a page-watch (monitor captures + senses new items by itself; there is no
  `--pull` flag on monitor).

The engine is a small Node driver (`render.mjs`) that runs under **system `node`**
(never the bun binary) and uses the **`playwright` optional dependency**
(`npm install --include=optional` + `npx playwright install chromium`). Missing
deps yield a `needs_credentials` record (exit 13), not a hard failure;
`overcast doctor` probes the renderer (the `playwright` / `source:browser` checks).
Bind a custom renderer with `setup provider screenshot "<exec spec>"`, or override
the source engine with `OVERCAST_SOURCE_BROWSER_CMD`; point `node` elsewhere with
`OVERCAST_NODE`.

**Security.** A headless browser fetching arbitrary URLs bypasses the fetch-side
SSRF guard, so `render.mjs` re-implements it: private/loopback/link-local/CGNAT/
metadata (`169.254.169.254`) targets are **refused by default**, before navigation
and per request — HTTP(S) redirects/meta-refresh/subresources are intercepted
(`context.route`) **and** `ws`/`wss` WebSocket connections are gated
(`context.routeWebSocket`), so a rendered page can't reach an internal host over
either. Every hostname is re-resolved per request (no verdict is cached) and fails
closed per attempt, mirroring `assertFetchHostAllowed` — so a DNS rebind on a later
hop is caught, and a transient resolver glitch blocks only that one request rather
than wedging a public host for the whole render. Opt out only with an affirmative
`OVERCAST_ALLOW_PRIVATE_FETCH` (same knob as `fetchMediaToCase`). A local `.html`
input renders via `file://`, and its `file:` subresources are confined to the
file's **own directory subtree** (symlinks resolved) — an untrusted export can't
pull `file:///etc/passwd` or another case's media into the render. Rendered pages
are untrusted content (invariant #10, prompt-injection surface) — a capture may
also be a bot-challenge or login wall, and that rendered state is still the
evidence. The engine also self-limits its runtime and force-closes Chromium on a
timeout or catchable signal, so a hung render / parent timeout doesn't orphan a
headless browser. Element (`--selector`) and video capture are not yet supported
(reserved).

## Source providers (built-in types)

`scan`/`monitor` enumerate sources; `capture` fetches. The harness normalizes
`--since` before it reaches a provider: a relative `N[smhdw]` duration or a bare
`YYYY-MM-DD` date passes through verbatim, and any other CLI-accepted form (e.g.
a full ISO datetime) is rewritten to a ceiled relative duration (`Nm`/`Nh`/`Nd`,
widening-only) — so a provider script only ever has to parse the shared shell
grammar. Built-in types resolve to shipped scripts:
- **`youtube`** — yt-dlp (no key). Supported refs: `youtube:@handle` for a channel's videos (`youtube:shorts:@handle` / `youtube:streams:@handle` for those tabs); `youtube:playlists:@handle` for the channel's playlists TAB (one hit per playlist, each carrying kind `playlist` + a ready-to-`source add` `playlist_ref`); `youtube:search:<query>` or `youtube:<keyword>` for keyword search; `youtube:playlist:<id>` or `youtube:<full YouTube URL>` for playlists/video URLs. `--limit 0` = uncapped (whole channel/playlist/tab). Fetch kinds: `capture <url> --transcript` (or `scan … --pull --transcript`) pulls captions + full metadata — the VTT is the artifact, plain transcript text + title/description ride in the capture payload (manual subs preferred over auto, `--lang` picks the language, capped at 200KB with `transcript_truncated`; an uncaptioned video degrades to a metadata-only `.txt` record with `transcript_note`, never an error) — and `--thumb` pulls the thumbnail image (jpg via ffmpeg convert); both skip the video download entirely.
- **`tiktok`** — Apify (`APIFY_TOKEN`). Supported refs: `tiktok:@user` for profile videos and `tiktok:#tag` for hashtag videos. TikTok keyword search is not a built-in mode.
- **`x`** (alias `twitter`) — Apify (`APIFY_TOKEN`). Default actor: kaitoeasyapi's pay-per-result tweet scraper, which works on any Apify plan against platform credit; override with `OVERCAST_X_ACTOR` (e.g. `apidojo~tweet-scraper` — same schema and faster, but **rental**: an unrented/free account gets only placeholder items, which map to zero hits). Supported refs: `x:@handle` for a profile's posts (translated to a `from:` search); `x:<query>` / `x:#tag` for X advanced search (`from:`, `filter:native_video`, `min_faves:`, `-filter:retweets`, …); `x:video:<query>` / `x:image:<query>` to return only posts carrying native video / images (applied as `filter:` operators so they hold across actors); `x:<full X URL>` for a post/profile/search/list URL. Hits point `media.ref` at the direct CDN asset (highest-bitrate mp4, else first photo) so `capture` downloads without X auth, and carry `author`/`views`/`thumb` triage metadata. Actors bill per result with a small per-query minimum — prefer fewer, broader queries.
- **`web`** — Tavily (`TAVILY_API_KEY`, preferred) or Brave (`BRAVE_API_KEY`). Supported ref: `web:<query>` for web search hits.
- **`lens`** — Google Lens reverse image search via Apify (`APIFY_TOKEN`; actor override `OVERCAST_LENS_ACTOR`, default `borderline~google-lens`). Supported ref: `lens:<image url>` or `lens:<local image path>` (relative paths resolve against the cwd, then the case media dir, then the case root; local files are uploaded to the account's `overcast-lens` key-value store so the actor can fetch them). Hits carry the matched page (`payload.url`), `match: "exact" | "visual"`, the matching site, and for exact matches the match thumbnail materialized into the case media dir (`media.ref`); `--limit` applies per match type; `--since` is ignored (Lens has no recency filter).
- **`yandeximg`** — Yandex reverse image search via Apify (`APIFY_TOKEN`; actor override `OVERCAST_YANDEX_ACTOR`). The reverse-image counterpart of `lens` (Google) — Yandex is the strongest engine for faces/places, so it fills the gap where only `lens` existed. Supported ref: `yandeximg:<image url>` or `yandeximg:<local image path>` (relative paths resolve against the cwd, then the case media dir, then the case root; local files upload to the account's `overcast-yandeximg` key-value store so the actor can fetch them). Hits carry the matched page (`payload.url`), `match` ("exact"|"visual"), and a thumbnail/page `media.ref` (a base64 thumbnail is materialized into the case media dir; a plain image URL passes straight through for `capture`). `--limit` caps hits (default 8); `--since` is ignored (no recency filter). **Ships a working default** — actor `johnvc~yandex-reverse-image-search` with its `image_url` input key — so it runs on just `APIFY_TOKEN` with no extra config; both are plain overrides for a different actor (`OVERCAST_YANDEX_ACTOR`, `OVERCAST_YANDEX_IMAGE_KEY`). Output field extraction stays defensive (tries several common field names) since each actor's schema may differ.
- **`dl`** — generic yt-dlp source (no key). `fetch` downloads any of yt-dlp's ~1800 supported hosts; `enumerate` flat-lists a **channel / playlist / user** URL (path matching `/c/`, `/channel/`, `/user/`, `/@handle`, `/playlist`, or `?list=`) into `scan.hit` records via `yt-dlp --flat-playlist` (`--limit`→`--playlist-end`, `--since`→`--dateafter`), while a **single-video / unclassifiable** URL returns `[]` (capture-only — a no-op scan, never a failure) and a yt-dlp failure surfaces as an enumerate **error**, not a fake-clean `[]`. `overcast capture <url>` auto-routes video hosts without a dedicated source (Rumble/BitChute/Odysee/VK/Bilibili/Vimeo/Dailymotion/Reddit/Twitch/Kick/Facebook/…) to `dl` instead of the `web` page fetcher, and a scan.hit stamped `source:dl` captures back through it. Bind `dl:<channel url>` to stake out a channel with `scan`/`monitor`, or `dl:<video url>` for capture-only.
- **`gdelttv`** — GDELT 2.0 TV API: broadcast-news video search over the Internet Archive TV News Archive (**no key**). Supported ref/query: `gdelttv:<phrase>`, optionally with GDELT operators (`station:CNN`, `market:"National"`); a query naming neither a station nor a market gets `market:"National"` appended (the API requires one). Hits carry the station/show/air-date title, the archive.org page (`payload.url`), snippet, thumbnail, and a **bounded clip** `media.ref` (`…/<show>.mp4?start=S&end=E`, ~30s) that `capture` downloads directly (full-show download is copyright-restricted; the clip service and thumbnails are public). `--since` maps to `STARTDATETIME`/`ENDDATETIME`, but the clipgallery corpus lags real time by weeks — a very recent window can return zero clips. Strong `monitor` fit (each clip has a stable page URL for dedup).
- **`overpass`** — OpenStreetMap features via the **Overpass API** (**no key**) — turn "every hospital / surveillance camera / fuel station / named place in this area" into geolocated case records. Supported refs: `overpass:key=value@around:<radius_m>,<lat>,<lng>` (a point + radius), `overpass:key=value@<south,west,north,east>` (a bbox), or **raw OverpassQL** (any query containing `[out:` or `;`, passed through verbatim). The friendly forms expand to QL over `node`/`way`/`relation` with `out center`, so ways/relations get a centroid. Each element becomes a hit carrying top-level `payload.gps` (node lat/lon, or the way/relation centroid) so scan records plot on `overcast map`; `payload.tags` holds the full OSM tag set, `payload.url`/`media.ref` is the `openstreetmap.org/<type>/<id>` element page (so `capture` stores it). `--limit` caps the QL `out center N`; `--since` adds an OSM `newer:"<ISO>"` recency filter (friendly forms only — raw QL owns its filters). Zero matches → clean `[]`. Strong "map anything" multiplier and a solid `monitor` fit for watching an area for new features.
- **`firms`** — NASA **FIRMS** active-fire / thermal-anomaly hotspots (**free** `FIRMS_MAP_KEY` from <https://firms.modaps.eosdis.nasa.gov/api/>) — satellite-detected fires as geolocated records. Supported ref: `firms:<west,south,east,north>` (a bbox → area CSV endpoint) with an optional `@<SENSOR>` suffix to override the default source (`VIIRS_SNPP_NRT`; e.g. `firms:2.0,48.5,2.6,49.0@MODIS_NRT`). FIRMS is **area-only** — there is no country endpoint in their API, so query a country by its bounding box. The response CSV is parsed **by header name** (so it survives VIIRS `bright_ti4` vs MODIS `brightness` column differences); each detection row becomes a hit carrying top-level `payload.gps`, an ISO `payload.published` from `acq_date`+`acq_time` (UTC), plus `frp`/`confidence`/`brightness`/`daynight`/`sensor`, so scan records plot on `overcast map`; `payload.url`/`media.ref` is a FIRMS fire-map deep link centered on the point. `--since Nd` maps to the FIRMS dayrange (1–10, default 1); `--limit` caps rows client-side. A header-only CSV (no fires) → clean `[]`; a non-CSV body (e.g. an `Invalid MAP_KEY` text response, which FIRMS returns HTTP-200) is a hard error, not a fake-clean scan. Strong `monitor` fit for a standing wildfire/thermal watch over an area.
- **`dispatch`** — police CAD / **calls-for-service** feeds on the **Socrata SODA API** (**no key**; an optional `SOCRATA_APP_TOKEN` is sent as `X-App-Token` to raise rate limits) — real-time dispatched 911 calls as geolocated case records. Supported refs: `dispatch:sf` (San Francisco real-time law-enforcement dispatched calls, `data.sfgov.org/gnap-fj3t` — ~10-min lag, **rolling ~48h window**), `dispatch:seattle` (Seattle real-time 911 fire/EMS dispatch, `data.seattle.gov/kzjm-xkqj`), and the generic escape hatch `dispatch:<domain>/<dataset>[@<datefield>]` for any Socrata calls-for-service dataset (e.g. `dispatch:data.sfgov.org/gnap-fj3t`); the `@<datefield>` suffix pins the date column, else the generic form orders/filters on the SODA system field `:updated_at`. The gps / title / row-id / snippet columns are **auto-detected per row** — gps from numeric `latitude`/`longitude` columns (string or number), any GeoJSON point value (`{type:"Point",coordinates:[lng,lat]}`), or a nested Socrata location object; title from the common call-type columns (`call_type_final_desc`, `type`, `description`, …); row id from the common unique-id columns (`id`, `cad_number`, `incident_number`, …), falling back to the Socrata `:id` system row id — always requested via `$select=*,:id,:updated_at`, so every row has a stable id (and generic-form rows a real timestamp). Hits carry top-level `payload.gps` so scan records plot on `overcast map` (a sensitive call with no location is still a hit, just without `gps`), `payload.published`/`created` from the date column, and a snippet of address/priority/agency/disposition. `payload.url`/`media.ref` is a **stable per-row SODA deep link** (`https://<domain>/resource/<dataset>.json?<idfield>=<value>`, or `…?$where=:id='row-…'` when only the system id exists) — the monitor dedup key, and what `capture` stores; never a URL fragment, which `fetch` would drop. `--limit` maps to `$limit` (default 50, cap 1000); `--since` maps to `$where=<datefield> > '<cutoff>'`. Socrata datetimes are **floating** (zone-less, the feed's local clock): the presets pin the feed's IANA zone, so their `--since` cutoff is formatted in feed-local time (an exact window) and their emitted `published`/`created` carry an explicit `±HH:MM` offset (downstream `map`/`situation` read zone-less as UTC, which would shift US call times by hours; worst case a row on the far side of a DST flip is 1h off). The generic form has no known zone — its `:updated_at` default is real UTC, but a pinned local `@<datefield>` keeps the floating skew, so prefer windows comfortably larger than the feed's UTC offset (e.g. `--since 1d`, not `1h`). Always `$order=<datefield> DESC` (newest first). The real-time feeds are **rolling windows** (SF keeps ~48h), which makes `monitor --source dispatch --every 15m` the natural standing surface.
- **`flights`** — live ADS-B aircraft positions via the **OpenSky Network** REST API (`api/states/all`). **Keyless-capable**: anonymous access works (heavily rate-limited, coarser resolution), and optional OAuth2 client credentials (`OPENSKY_CLIENT_ID` + `OPENSKY_CLIENT_SECRET`, exchanged at the OpenSky Keycloak token endpoint) raise the limits. Supported refs: `flights:<west,south,east,north>` (a bounding box → `lamin/lomin/lamax/lomax`), `flights:<icao24>` (a 24-bit hex id → `?icao24=`), and `flights:<callsign>` (anything else → fetch all states, filter client-side by callsign — an all-states pull is large and the first thing anonymous access rate-limits, so a bbox is strongly preferred). Each state vector with a known position becomes a hit carrying top-level `payload.gps` (so scan records plot on `overcast map`, and `monitor --every` builds a track), an ISO `payload.published` from the OpenSky `time_position` (UTC), a snippet of altitude/velocity/heading/on-ground, the raw `icao24`/`callsign`/`velocity`/`baro_altitude`/`geo_altitude`/`on_ground`/`true_track`, and the aircraft-profile page as `media.ref`. `--since` is ignored (this is a live snapshot); `--limit` caps hits client-side. Anonymous requests are commonly answered with HTTP 429 under load — that surfaces as an enumerate error (not a fake-clean `[]`). Public flight data, but kept **opt-in** (never a default binding). Strong `monitor` fit for tracking an aircraft/area over time.
- *AIS / vessel (ship) tracking is a planned follow-up:* the free AIS feeds (e.g. aisstream.io) are **websocket-only**, which does not fit the one-shot `enumerate → exit` exec model, so it needs a persistent-connection provider shape rather than a bash enumerate script.
- **`instagram`** — Instagram profiles/hashtags via Apify (`APIFY_TOKEN`; actor override `OVERCAST_INSTAGRAM_ACTOR`, default `apify~instagram-scraper`). Public data only, no login. Supported refs: `instagram:@handle` (profile posts/reels), `instagram:#tag` (hashtag posts), `instagram:<url>`. Hits carry the post page (`payload.url`), caption, owner, and a direct-CDN `media.ref` (video asset for videos, else the image) so `capture` downloads without login — CDN URLs are short-lived, so `scan --pull` is ideal.
- **`telegram`** — public Telegram channels via Apify (`APIFY_TOKEN`; actor override `OVERCAST_TELEGRAM_ACTOR`, default `webfinity~telegram-channel-content-media-scraper-v2`). No login/phone. Supported refs: `telegram:<channel>`, `telegram:@channel`, `telegram:<t.me url>`. Each post's `payload.url` is a stable `t.me/<channel>/<id>` (great for `monitor` dedup); `media.ref` is the post's first media asset (text-only posts fall back to the post URL). `--since` maps to the actor's `daysRange` (capped at 30 days).
- **`webcam`** — live public webcams via the Windy Webcams API (`WINDY_API_KEY`; ~70k geolocated cams; base override `OVERCAST_WEBCAM_API`). Supported refs: `webcam:<lat>,<lng>[,<radiusKm>]`, `webcam:country:<ISO2>`, `webcam:category:<slug>`, `webcam:<webcamId>`. Hits carry the cam title, location (`lat`/`lng`/`city`/`country`), the detail/player page (`payload.url`/`player`), and the cam's **current still** as `media.ref` (the free tier serves stills/timelapse, not a raw stream; tokened image URLs expire, so `scan --pull`/`monitor` are ideal). For a live clip, capture the player page with the `dl` source / yt-dlp. Strong `monitor` fit for watching a location on a schedule.
- **`facesearch`** — **opt-in, sensitive** reverse FACE search via Apify (`APIFY_TOKEN`; actor override `OVERCAST_FACE_SEARCH_ACTOR`, default `nkactors~face-search`). Finds where a person's face appears online (complements `lens`, which matches whole images). Ref/query is a face image (`facesearch:<image url|local path>`; local files upload to the shared `overcast-lens` KV store). **Never a default binding** — face search raises real privacy / ToS / legal considerations; use only with authorization. Set `OVERCAST_FACE_SEARCH_DEMO=1` for the actor's cheap debug mode when wiring-testing.
- **`dork`** — Google dorking via **Serper.dev** (`SERPER_API_KEY`). Real Google SERPs that **honor operators** (`site:`, `filetype:`, `inurl:`, `intitle:`, `ext:`, `-term`, `OR`) — unlike `web` (Tavily/Brave), which silently ignore them, so `dork` is the source for exposure/attack-surface discovery. Supported ref: `dork:<google dork string>` (passed verbatim to Google). Hits carry the result page (`payload.url`/`media.ref`), title, and snippet; `--since` buckets into Google's `tbs` recency window (day/week/month/year); `capture`/`--pull` downloads the result page like `web`. **Authorized recon only** — never a default binding; use only against targets you are permitted to investigate.
- **`shodan`** — host/service/banner intelligence via the **Shodan REST API** (`SHODAN_API_KEY`). Supported refs: `shodan:<search query>` (filters like `org:"Acme" port:22`, `ssl:example.com`, `product:nginx country:DE` — 1 query credit per 100 results) and `shodan:<ip>` (a bare IPv4/IPv6 → full host lookup, one hit per exposed service). Each hit carries `ip`/`port`/`transport`/`org`/`isp`/`asn`/`product`/`hostnames`/`cpe`/`os`/`vulns` (CVE list) and geolocation (`lat`/`lng`/`country`/`city`) in the loose payload; `payload.url`/`media.ref` is the `shodan.io/host/<ip>` report page (with a `#<port>-<transport>` fragment so every service is a distinct record and `monitor` catches newly exposed ports), so `capture`/`--pull` stores a real evidence page. `--since` is ignored (Shodan search has no recency filter). Strong `monitor` fit for standing exposure watch. **Authorized recon only** — never a default binding.
  - **Opt-in screenshots / RTSP (sensitive).** Set `OVERCAST_SHODAN_SCREENSHOTS=1` (an explicit acknowledgement) to also decode the **screenshots** Shodan captures from exposed RDP/VNC/X11/HTTP/camera services into the case media dir — so `media.ref` becomes a real image `see`/`face`/`crop` can analyze — and surface RTSP (port 554) stream endpoints in `payload.stream`. These are the screens/camera views of **real, unwitting hosts**; enabling it carries privacy/ToS/legal weight and is authorized-use-only. Off by default (hits stay metadata + host page). Use `has_screenshot:true` / `screenshot.label:webcam` in the query to target hosts that have them.
- **`browser`** — rendered-page capture via the shared headless-Chromium engine (`node` + the `playwright` optional dep; **no key**). Supported ref: `browser:<url>` (a page to screenshot; scheme-less refs assume `https://`). `enumerate` emits one ephemeral hit for the page; `fetch` renders the **current page state** to a PNG (`recapture: true`, so `monitor` re-renders every pass — a page-watch, webcam-style). The rendered PNG then flows into the case's image `auto_sense` chain (`see`/`exif`) on `scan --pull` (monitor does this on every pass by default), exactly like a webcam still. Private/loopback targets are refused by default (`OVERCAST_ALLOW_PRIVATE_FETCH=1` to allow). This is the same engine the `screenshot` verb uses; the verb is the one-shot surface, the source is the standing scan/monitor surface. See the screenshot engine below.

### Identity / records OSINT sources (opt-in, Apify-backed)

These five turn an identifier — a username, name, phone, address, or plate — back into a public footprint. All are **Apify-backed** (`APIFY_TOKEN`), **opt-in, never a default binding**, and touch **live PII on real people**: use only with authorization. Each record carries a `payload.caveat` and hits emit `verb:scan` / `meta.provider = source:<type>` like any other source (they feed `ask`/`brief` as evidence; `capture`/`--pull` banks the source/profile page).

- **`username`** — social/forum **account discovery** via Apify Maigret (actor override `OVERCAST_MAIGRET_ACTOR`, default `ntriqpro~maigret-actor`; breadth via `OVERCAST_MAIGRET_TOPSITES`, default 500, 0 = all 3000+ sites). Ref: `username:<handle>` (a leading `@` is stripped). One hit per **claimed** account — `payload` carries `site`, `author` (name if the site exposes it), `bio`/snippet, `image`, `account_status`; `media.ref` is the profile page. `--limit` caps found accounts; `--since` ignored. The username twin of `facesearch` (a face) and `lens` (an image).
- **`person`** — **people-search / skip-trace** via Apify (actor override `OVERCAST_PERSON_ACTOR`, default `apivault_labs~skip-trace-people-finder`). Ref: `person:<Full Name>` with an optional `@<location>` hint (a state, city+state, or full street address) to disambiguate. One hit per matched person — `payload` carries `age`, `born`, `phones`, `best_phone`, `emails`, `best_email`, `current_address`, `past_addresses`, `aliases`, `relatives`, `confidence`. The actor prepends compliance-notice rows (`recordType` set) which are dropped. **Not an FCRA report** — no employment/credit/tenant use; accuracy not guaranteed. `--limit` caps records; `--since` ignored.
- **`phone`** — reverse phone / **number OSINT** via Apify PhoneInfoga (actor override `OVERCAST_PHONE_ACTOR`, default `datacach~phoneinfoga-phone-number-osint-scanner`). Ref: `phone:<E.164>` (e.g. `phone:+14155551212`). One hit — `payload` carries the offline libphonenumber parse (`carrier` guess, `country`, `country_code`, `valid`, local/international formats) and the grouped web `footprint` (Google-dork URLs by category). `APIFY_TOKEN` only, no other key. No natural media (metadata evidence). `--limit` caps records (normally 1); `--since` ignored.
- **`property`** — address → **county assessor / tax / recorder records** via Apify (actor override `OVERCAST_PROPERTY_ACTOR`, default `shelvick~county-property-records`). Ref: `property:<street, city, ST zip>` (include city + state for reliable county routing). One hit per resolved parcel — `payload` carries `owner`, `assessed_value`/`market_value`, `parcel_id`, `last_sale`, `sale_history`, `tax_history`, `characteristics`; `media.ref` is the county source-of-record page. Public records but privacy-relevant; verify against the county source.
- **`plate`** — license plate → **vehicle spec** (VIN / year / make / model) via a **bound** Apify actor. **No default actor** — US plate→vehicle data is DPPA-restricted and there is no reliable public actor, so you must set `OVERCAST_PLATE_ACTOR` (an actor taking `{plate, state, maxItems}`) or point `OVERCAST_SOURCE_PLATE_CMD` at a direct plate API (PlateToVIN/CarsXE). Ref: `plate:<ST>:<plate>` (state optional). **Vehicle SPEC only — registered-owner lookup is legally restricted and not returned.** Output field names are parsed defensively (`vin`/`make`/`model`/`year`).
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
bash providers/sources/tiktok/tiktok.sh describe
```

### Consume an MCP server as a source (prototype/example)

`examples/providers/sources/mcp-bridge.ts` drives **any stdio [MCP](https://modelcontextprotocol.io) server** as an overcast `mcp` source — no `src/`, dependency, or `package.json` changes. It speaks the MCP stdio JSON-RPC handshake by hand (`initialize` → `tools/list` → `tools/call`), ranks a search-shaped tool, and maps results into `scan.hit` records. Bind it like any custom exec source via `OVERCAST_SOURCE_MCP_CMD`, pointing at a server with `MCP_SERVER_CMD`.

Worked example — the reference **filesystem** server (`@modelcontextprotocol/server-filesystem`) searching a `/data` tree. Its `search_files` tool takes a `path` + a glob `pattern`, so it needs the per-server overrides:

```bash
export OVERCAST_SOURCE_MCP_CMD='npx tsx examples/providers/sources/mcp-bridge.ts'
export MCP_SERVER_CMD='npx -y @modelcontextprotocol/server-filesystem /data'
export MCP_SEARCH_TOOL='search_files'    # force the tool (else ranked by name)
export MCP_QUERY_ARG='pattern'           # which arg the --query fills (a glob here)
export MCP_TOOL_ARGS='{"path":"/data"}'  # static args merged into every tools/call

overcast source add "mcp:*.md"
overcast scan --source mcp --query "*.md" --json
```

Config knobs (all env — the exec transport ignores the bridge's stdin):
- `MCP_SERVER_CMD` **(required)** — command that launches the stdio server (quote-aware).
- `MCP_SEARCH_TOOL` — force a tool name (else ranked `search > find > query > lookup > retriev > list`).
- `MCP_QUERY_ARG` — force which argument the query fills (else the first required string).
- `MCP_TOOL_ARGS` — JSON object of static args merged into every `tools/call`.

**Trust caveat:** binding an MCP server means overcast **spawns that server's code locally on every scan** — `npx -y <pkg>` pulls and runs arbitrary code, a supply-chain/RCE surface plain HTTP scrapers don't have. Treat binding an MCP source as *running a program*: prefer pinned/vetted commands over `npx -y`, and only bind servers you trust. Server-returned text enters records as evidence — the same trust class as `web`/`scan` (invariant #10).

Prototype limits: name-based tool selection is a fine default, but query-argument mapping doesn't generalize across servers (hence the per-server `MCP_*` overrides), and the spawn-per-scan exec model suits a one-shot `scan` more than tight `monitor --every` loops. A first-class `profile.mcp[]` binding (named servers with `{ tool, queryArg, staticArgs }` + a `doctor` probe + an explicit "spawn is code execution" consent gate) is the natural next step.

## Memory providers

`ask`/`brief` read through bound **memory** providers (fan-out). The always-on
default is `local-grep`, which scans indexable fields from `.overcast/records`
(`note.text`, `watch.content`, `listen.transcript`, scan titles/snippets, etc.).
Only primary evidence records are eligible for memory and briefs: read/meta and
operational bookkeeping records (`ask`, `brief`, `case`, `setup`, `doctor`,
`index`, `target`, `source`, `prebrief`, legacy `collection`, etc.) are excluded even if they contain matching
text. Root `finding`s follow the same rule as flows.md's searchability table:
accepted findings are evidence, but `suggested` (until accepted) and dismissed
findings are quarantined from memory/briefs. Remote indexes stay explicit
through the case index mirror and
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

### Cloudglue cloud tier (`ask --deep`, opt-in)

`ask --deep` can also fan out to a case-linked Cloudglue **media-descriptions**
collection — true cross-modal search over the case's actual video at cloud scale.
This is the `cloudglue` memory provider (alias `tinycloud`), and it is strictly
**opt-in** because uploading/querying a Cloudglue collection costs money:

```bash
overcast index create Scenes --type media-descriptions   # a remote collection for the case
overcast index add clip.mp4 --to <id>                     # (uploads cost money)
overcast setup memory cloudglue                           # opt in (uses the first attached media-descriptions index)
overcast setup memory cloudglue <index>                   # …or pin a specific index by id/name
overcast setup memory cloudglue off                       # opt back out
overcast ask "where did the buyer object to the price?" --deep --json
```

The opt-in lives in the case setup (`.overcast/setup.json`, `memory.cloudglue`) —
it is off by default and never auto-enabled. The provider engages ONLY when all of
these hold: `--deep` was requested, the case opted in, a media-descriptions
collection resolves, and a Cloudglue key is present (`CLOUDGLUE_API_KEY`, or
`~/.tinycloud/config.json`). A plain `ask` (no `--deep`) never touches the cloud —
the provider's local `query()` returns nothing, so there is no silent spend. It
only READS the collection; adding captured media to it is a separate, deliberate
step (`index add`), not something `ask` does. Under the hood it goes through the
public tinycloud ask verb (the same path as `ask --index`) and maps cited moments
to `record.id` + `media.at` citations — never the Cloudglue SDK (invariant #9).
`ask --deep --memory cloudglue` forces just this provider; combine with qmd to
merge local semantic hits with the cloud answer.

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
on `PATH`; `overcast doctor` reports the installed version, warns below the
0.3.12 floor, and recommends the latest tested tinycloud, currently 0.3.12.

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
query image must be JPEG/PNG; the tinycloud face preflight rejects
webp/heic/gif/bmp/tiff/avif (0.3.7's webp support is see/extract-only). Bind your own
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
tinycloud CLI **and its version** (the floor is ≥ 0.3.12 — `watch.speech.v1`
inlines the verbatim `watch`/`listen` transcripts; `face`/`index` need ≥ 0.3.4;
the opt-in `see:tinycloud` provider needs ≥ 0.3.7), the
home/profiles, and the active provider bindings. Version 0.3.12 is the current
recommended tinycloud build.
