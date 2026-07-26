# CLAUDE.md

Guidance for Claude Code / pi / any agent working in this repo — the quick map +
the invariants you must not break. `overcast commands --json` is the authoritative
verb surface; verify against it, not memory.

## What this repo is

**overcast** — a portable toolkit that gives an agent *senses* (video / audio /
image understanding) and *OSINT reach* (search / capture / monitor), organized
around an investigation **case**. Built **on top of
[pi](https://github.com/earendil-works/pi)** (the agent harness), with **tinycloud
/ Cloudglue** as the default perception backend.

It ships three ways from one source of truth (`src/registry/verbs.ts`): a **pi
package** (extension + skills + prompts + theme), a **standalone bun binary**, and
**agent skills** that drive the CLI from any harness.

## Stack (pinned)

- `@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`, `pi-coding-agent` —
  **exactly `0.80.3`**. Don't float these; treat upgrades as reviewed changes.
- `@cloudglue/cloudglue-js` — the default sense backend (via the tinycloud CLI,
  `exec`). Cloudglue is **also** a pickable *brain* LLM provider (anthropic-messages
  API) so it appears in `/model` — never forced. The tinycloud CLI is a runtime
  prerequisite (like ffmpeg), not an npm dep; the floor is tinycloud
  **≥ 0.3.12** (`watch.speech.v1`) — the watch envelope inlines VERBATIM speech
  (`segments[].speech`), so `watch`/`listen` transcripts are single-call
  (`listen --diarize` still rides the public `caption` verb, which is also the
  fallback for 0.3.10/0.3.11 envelopes that ship `segments: []`); `face` +
  `index` need ≥ 0.3.4, and image `see`/`extract` (the opt-in `see:tinycloud`
  provider) need ≥ 0.3.7.
- `ffmpeg` + `ffprobe` — a **system prerequisite** (on `PATH`, or via
  `OVERCAST_FFMPEG` / `OVERCAST_FFPROBE`); the internal media toolkit, NOT bundled.
- uv-managed visual/audio DB Python — optional for visual/audio DBs,
  `face:deepface-local`, and the `enhance:local-models` split ops:
  `scripts/visual-db-uv.sh --face` installs OpenCV/Numpy and DeepFace/TensorFlow;
  `--clip` adds OpenAI CLIP (open_clip + torch + pillow) for the `basic-clip`
  semantic DB; `--detect` adds the OWLv2 open-vocab detector (torch + transformers
  + scipy + pillow) that backs `see --detect` (set `DETECT_PY` to the venv);
  `--audio` adds scipy for the `audio-fp` Shazam-style fingerprint DB; `--clap`
  adds LAION CLAP (transformers + torch) for the `basic-clap` audio-embedding DB;
  `--voice` adds pyannote.audio (`enhance --ops separate` + the `voice-print`
  speaker-verification DB for `voice`), `--segment` adds
  transformers + SAM2/GroundingDINO (`enhance --ops segment`), `--enhance` adds both
  enhance stacks, `--all` installs everything. Override with `OC_VISUAL_DB_PY` /
  `OVERCAST_VISUAL_DB_PY`. Voice separation and `voice match --diarize` additionally
  need `HF_TOKEN` + accepted pyannote license (the windowed `voice` default is
  ungated).
- TypeScript / ESM / Node ≥22; `tsup` (dev build) + `bun build --compile` (binary).

## Invariants (do not violate)

1. **Don't fork pi.** Reuse pi's loop, TUI, sessions, base tools
   (`read/write/edit/bash/grep/find/ls`), and provider layer. overcast attaches as
   a pi **package/extension**; net-new code is the verbs + providers + record store.
2. **BYO LLM.** Never hardcode the brain provider. Keep the *brain provider*
   (pi-ai) and the *sense providers* (tinycloud / VLM / STT) separate everywhere.
   *One deliberate, opt-out bridge:* `see` defaults to the **brain LLM** for image
   description when it's image-capable (`src/providers/brain/vision.ts`) — it
   resolves whatever brain the profile/env already points at (BYO, never a
   hardcoded one) and is one switch away from the classic sense provider
   (`setup provider see builtin:hf` / `OVERCAST_SEE_BRAIN=off`). Don't extend this
   pattern to other verbs without the same "resolved-not-hardcoded + opt-out" bar.
3. **The record is loose.** Output contract = `{ id, verb, format (json|md|txt),
   payload, media?{ref,at}, meta?, error?, state? }` and nothing more. Map provider
   output to the record at the exec boundary; never reintroduce a rigid envelope.
   `state`/`error` are the only optional control fields; a missing `state` = `ready`.
4. **Case = a folder.** No bespoke case object — a case is a directory with a
   `.overcast/` store; pi's per-directory sessions are the case history. Switch
   cases by `cd` or `--case <dir>`.
5. **One verb spec → three surfaces.** Declare each verb once in
   `src/registry/verbs.ts`; the CLI subcommand, the pi AgentTool, and the skill doc
   are generated from it. `overcast commands --json` is the source of truth.
6. **Providers are pluggable.** Three classes share one machinery — **sense**
   (`watch/listen/see/face/cluster/image/audio/voice/similar/enhance/reconstruct/exif/verify/screenshot/chronolocate` —
   `cluster` shares the face provider, `chronolocate` is pure local math), **source**
   (`scan/capture/monitor`; youtube, tiktok, x, web, lens, yandeximg, dl, instagram, telegram,
   gdelttv, overpass, firms, dispatch, flights, webcam, facesearch, dork, shodan, browser,
   username, person, phone, property, plate), and **memory** (`ask/brief`; local-grep, optional qmd). Bindings live in the profile;
   the transport is `exec` (default) — `http`/`in-proc` are declared in the binding
   shape but **not yet wired** (`runBoundProvider` errors on them). Default sense binding =
   tinycloud (exec) — except `see`, whose default is the in-proc brain-vision
   backend (invariant #2), falling back to the HF exec captioner;
   `face:deepface-local` is the local DeepFace profile provider for face
   detection/matching, `basic-clip` is the local OpenAI CLIP DB for
   `similar` (cross-modal semantic search), `audio-fp` is the local numpy/scipy
   Shazam-style fingerprint DB for `audio` (exact audio matching), and
   `basic-clap` is the local LAION CLAP DB for `similar` audio↔audio + text→audio
   search, and `voice-print` is the local pyannote/wespeaker speaker-verification
   DB for `voice` (find a reference speaker; ungated windowed default, HF-gated
   `--diarize` tier). Shipped provider scripts live in the top-level `providers/`
   tree (`sources/`/`senses/`/`engines/`), each provider dir carrying a
   **`provider.json` manifest**; the catalog + source registry are **built by
   scanning those manifests at runtime** (`src/providers/manifests.ts`) — a
   provider is declared once in its manifest, not hand-listed in `catalog.ts`
   (the invariant-#5 pattern, for providers). Manifest descriptors reference
   scripts as **`shipped:<relpath>` refs** (never absolute paths — `src/providers/
   shipped-ref.ts` resolves at spawn, so profiles survive install moves); old
   absolute-path profiles/case policies are **healed on load**, and `doctor`
   (`provider-paths`) flags refs that don't resolve. Third parties add a provider
   by authoring a manifest package and `overcast provider install <path|tarball>`
   (→ `<home>/providers/<pkg>/`, resolved via the **`installed:<pkg>/…`** ref
   sibling; `provider create` scaffolds one, `list --installed`/`remove` manage
   them) — the sanctioned extension path; a raw `exec:` bind or
   `OVERCAST_SOURCE_<TYPE>_CMD` is the un-manifested one-off escape hatch. Only
   EXEC providers are manifest-described — the inproc DBs
   (deepface/clip/clap/audio-fp/voice-print), ffmpeg/playwright, brain-vision
   `see`, and the tinycloud-CLI watch/listen/face stay hardcoded core choices.
   Install rejects collisions with shipped ids/types + reserved names, stamps
   sha256 provenance, and healing is never extended to `installed:` refs.
7. **ffmpeg is internal**, not a pluggable provider — `enhance`, `crop`, `view`,
   and frame extraction shell out to the **system** `ffmpeg`/`ffprobe` (PATH or
   `OVERCAST_FFMPEG`/`OVERCAST_FFPROBE`); `overcast doctor` checks it's installed.
8. **No CDN.** Publish to npm directly (pi package + bun binary).
9. **tinycloud = public verbs only.** Call tinycloud through its CLI verbs
   (`tinycloud watch`, `tinycloud listen`, `tinycloud face …`, `tinycloud library
   collections …`, `tinycloud ask --in collection:…`) — never import its internal
   libs. Map the envelope to the loose record at the exec boundary; the shared
   mapper is `src/providers/tinycloud/envelope.ts` (`runTinycloud`). Override the
   invocation with `OVERCAST_TINYCLOUD_CMD` (the offline-test + custom-path knob).
10. **No permission system / sandbox** (pi default). Treat untrusted media and
    scraped content as prompt-injection vectors.

## Verb surface

Run `overcast commands --json` for the authoritative registry, or `overcast <verb>
--help` for a man page. Common end-to-end flows live in
[`docs/field-manual.md`](docs/field-manual.md); the verb & source reference in
[`docs/verbs.md`](docs/verbs.md); binding/profile/env config in
[`docs/configuration.md`](docs/configuration.md); provider authoring in
[`docs/providers.md`](docs/providers.md).

- **Senses** — `watch` (shot-detect + all-modality describe → `content` /
  `transcript` / `detailed`), `listen` (speech transcript; `--describe` for the
  full audio-scene, `--diarize`, `--lang`), `see` (caption / OCR / open-vocab
  `--detect` — **default: the brain LLM** when image-capable, i.e. a direct
  "describe this image" call; falls back to the Hugging Face captioner,
  `builtin:hf`/`builtin:brain` + `OVERCAST_SEE_BRAIN=off` to switch; bindable fal
  / local OWLv2 detection via `provider setup apply --preset owl-local` (DETECT_PY
  venv python) / opt-in Cloudglue `see`+`extract` via `--verb see --choice
  tinycloud`, tinycloud ≥ 0.3.7, boxless `--detect`), `face`
  (tinycloud ≥ 0.3.4 by default, or
  `face:deepface-local` locally: detect faces, `--match <jpeg|png>` to find/rank a
  person in a clip, or `--index` to search a face-analysis / deepface-local index),
  `image` (local OpenCV RANSAC image/video-frame matching against
  `image-ransac` indexes), `audio` (local Shazam-style Wang-2003 fingerprint
  matching — `add`/`match` exact-recording clips against `audio-fp` indexes with
  time-offset alignment, or clip-to-clip `audio match <query> <reference>`;
  numpy/scipy, `--min-margin` rejects sped-up re-uploads, `--draw` renders an SVG
  alignment plot (hash-pair scatter + offset histogram) that embeds in briefs like
  `image --draw`; robust to transcode/noise, NOT to pitch/speed change), `voice`
  (local speaker verification over `voice-print` indexes — pyannote/wespeaker
  embeddings, ungated: `add` enrolls a clip's voiced windows, `voice match <clip>
  <sample>` ranks WHERE a reference speaker talks (windowed scan; `--diarize` =
  overlap-aware diarize-then-match vs pipeline centroids, HF_TOKEN-gated with
  windowed fallback), `voice match <sample> --index` ranks members containing the
  speaker; `similarity` is an anchored-cosine 0–100 RANK score + raw `cosine`,
  `--min-margin` gates best-vs-runner-up; NOT liveness — clones score high, every
  record carries `payload.caveat`), `cluster`
  (persistent LOCAL face DB: ingest faces out
  of media → assign-or-create people, `identify`, `recluster`, `list/show/label`,
  and an HTML gallery `view`; deepface-only, over a `face-cluster` local index),
  `similar` (local OpenAI CLIP + LAION CLAP cross-modal semantic
  search — `add`/`match`/`search` image→image, text→image against `basic-clip`
  indexes, or audio→audio, text→audio against `basic-clap` indexes; videos
  frame-sampled + pooled, audio windowed into 10s moments), `enhance` (system
  ffmpeg ops, a bound restore model, or the provider-only fan-out ops
  `--ops separate` = per-speaker tracks + optional `--summarize`, `--ops segment
  --prompt` = text-prompted masks/cutouts (bound `local-models` or `fal`),
  `--ops ela` = ELA/noise/luminance forensic overlays from an image (heuristic
  edit-detection leads; catalog choice `enhance:ela`), and `--ops panorama`
  = stitch a panning video into one wide still for skyline/landmark geolocation
  (catalog choice `enhance:panorama`) — each fanned out one record per artifact),
  `reconstruct` (SPECULATIVE scene reconstruction from a still or `--at` video
  frame via a bound generative provider — fal toolbox: `--rotate/--elevate/--zoom`
  camera reposition + `--ops sweep` 360° stops → contact sheet + turntable mp4
  (Qwen-2511 multi-angle), `--ops model` image→3D GLB (Trellis/Hunyuan via the
  fal QUEUE API) rendered in an embedded no-dep WebGL orbit viewer, `--ops depth`
  Depth-Anything map → drag-parallax viewer; same outputs[] fan-out as enhance;
  EVERY record carries `payload.caveat` and the verb is in `OPERATIONAL_VERBS` —
  viewable/chainable but NEVER ask/brief evidence or findings input; no builtin,
  bind `provider setup apply --verb reconstruct --choice fal`),
  `exif` (ExifTool metadata/GPS on image **or** video → `payload.gps{lat,lng}`
  (WGS84-validated at the provider), capture time, device, editing software,
  camera `serial`/`lens` (device-linking fingerprint), dimensions; shipped
  `exiftool` provider, raw tag dump stays in-provider; `--geocode` reverse-geocodes
  the GPS to `payload.place` via an **opt-in** bound `geocode` provider — catalog
  choice `geocode:nominatim`, no key, never default; the `geocode` provider also
  has a **forward** mode (`--query "<address>"` → `{lat,lng,place}`, keyless
  Nominatim `/search`) — the address→point step the `overcast-canvass` skill uses
  to fan `overpass`/`webcam` camera sources around a location), `verify` (C2PA / Content Credentials provenance
  via `c2patool` → `has_manifest`, signer, claim generator, validation state; no
  credentials is a clean `ready` record, not an error — distinct from source-post
  provenance in `src/verbs/provenance.ts`), `screenshot` (browser screen capture —
  render a web page **or a local `.html` export** to a PNG evidence record via
  headless Chromium; the shared Playwright engine in `providers/engines/screenshot/`
  also backs the `browser:` source, runs under system `node` with the playwright
  **optional dep** — missing → `needs_credentials`; `--full-page`, `--viewport WxH`,
  `--wait ms`; re-implements the fetch SSRF guard over HTTP **and** WebSocket
  (`ws`/`wss`), private/loopback refused by default with
  `OVERCAST_ALLOW_PRIVATE_FETCH` opt-out; rendered pages are untrusted,
  invariant #10), `chronolocate` (chronolocation from the
  sun/shadows — pure offline solar-position math in `src/solar.ts`, no API/key:
  **verify** (`--at-time`) computes the sun az/altitude + expected shadow bearing &
  length for a claimed time (a mismatch flags a mis-dated/staged image), **solve**
  (`--shadow-azimuth`, optional `--height-ratio` = object:shadow length) returns the
  local-solar-time window(s) a shadow bearing implies on `--date`; location from
  `--lat`/`--lng` or a linked record's `payload.gps`; carries `payload.gps` (plots on
  `map`) + `payload.caveat` — a lead, not proof).
- **Deliberately out of scope — no deception detection.** overcast does not and
  will not ship deception detection, voice-stress analysis, or micro-expression
  "lie detection". The underlying methods are not scientifically validated; a
  verb emitting "72% likely lying" would be confident-sounding junk, the exact
  opposite of the honesty bar the senses already hold (`voice` disclaims
  liveness + carries `payload.caveat`; `reconstruct` is quarantined out of
  evidence). This is a permanent, principled exclusion — not a roadmap gap, not
  "coming soon". For DESCRIPTIVE acoustics (tone, ambience, the audio scene)
  use `listen --describe`; for WHO is speaking (identity, never truthfulness)
  use `voice`.
- **Inspect** — `view` (self-contained HTML media player; `--at`, `--spectrogram`,
  `--no-open`; on an `enhance` split-op parent it renders a GALLERY of the fanned-out
  children — per-track audio + spectrograms for `separate`, cutouts for `segment`,
  via `renderEnhanceGallery` in `src/report/html.ts`), `crop` (materialize `face`/`see` detection boxes into cropped
  image evidence records via ffmpeg — `--all/--id/--class/--kind`, `--pad`,
  `--square`), `grid` (tile timestamped video frames into ONE labeled contact
  sheet for a single-call VLM triage pass — the "grid trick" for temporal search;
  `--count`/`--at`/`--start`/`--end`/`--cols`/`--width`; emits `media.grid` with a
  cell-number→timestamp map; labels burned only when ffmpeg has `drawtext`, else
  positional; `--view` renders a clickable HTML board — CSS-labeled numbered cells
  that seek the source clip — the human counterpart to the VLM-facing PNG),
  `wall` (control-room monitor wall: case videos muted + looping at
  their evidence moments — open finding > face hit > record anchor — with
  coverage badges and scan/monitor/brief freshness overlaid; `--limit`,
  `--source`/`--since`, `--refresh`, `--infinite` endless repeat-to-fill wall,
  `--theme plain|csi`, `--no-open`),
  `situation` (the LIVE twin of `wall` — "monitor the situation": a
  token-authed local server (`src/situation/` over the shared
  `src/live/httpd.ts`, default `127.0.0.1:7374`) that serves a self-updating
  multi-panel page — wall tiles + reverse-chron scan/monitor feed + live gps
  map (flights build tracks) + refreshing webcam/browser stills — panels
  auto-picked from configured sources. `serve` (default) is a BLOCKING,
  operator/CLI-only op meant for its own pane (opening a listener is an operator
  action, invariant #10 — the agent tool + `/situation` slash serve only
  `status`/`set`/`stop`); `--every <interval>` makes the serving process own the
  monitor cadence too. Refresh = poll the store fingerprint (no eventing) → SSE
  `refresh` → the browser refetches whole. Local media streams over an
  authenticated `/media` route with Range (a page served from http:// can't load
  `file://` like the static wall); remote embeds gated by
  `OVERCAST_REPORT_REMOTE_MEDIA`. Control plane = `.overcast/situation/`
  (`runtime.json` discovery + an append-only `control.d/` patch log, drained on
  the ~2s poll tick), so
  `situation set`/`stop` (CLI, agent tool, or chair→agent) retune/stop a running
  page cross-process. `/situation on` in the TUI runs the SAME server in-process,
  bound to the session lifecycle, as a viewer (the agent feeds it). Operational:
  out of `ask`/`brief` evidence),
  `map` (plot every case record carrying `payload.gps` on ONE self-contained HTML
  map — markers link back to source, geocoded place + thumbnail + capture time;
  online = inlined-JS OSM raster tiles at view time, `--offline` = coordinate
  scatter + openstreetmap.org deep links, no egress; `--since`/`--limit`/`--theme`/
  `--no-open`; `--near <lat,lng>`/`--radius <m>` (default 500) or
  `--bbox <minLat,minLng,maxLat,maxLng>` spatially pre-filter the plotted points
  (same fence semantics as `geofence`, shared `src/geo.ts` primitives);
  recency uses exif capture time, not ingest),
 `geofence` (the geofence-warrant query — every case record whose `payload.gps`
 falls inside a `--near <lat,lng>` circle (`--radius <m>`, default 500) or a
 `--bbox` box (inclusive, non-wrapping) captured within `--since`/`--until`
 (capture-time-aware like `map`; undated records that intersect spatially are
 KEPT, `capture_time` null); pure local read over gps-bearing records (`exif` +
 geo sources dispatch/firms/flights/overpass), no provider/network; ONE rollup
 record — matches newest-first, per-verb counts, query echoed back; empty
 intersection = clean `ready` + guidance, not an error; haversine/bbox math in
 `src/geo.ts`),
 `devices` (case-wide rollup grouping `exif` records by camera fingerprint —
 serial-only strong link, make+model+lens weak fallback; one entry per file; a
 pure read over case memory, `--min`, `--findings` emits serial-linked suggested
 findings),
 `graph` (case knowledge graph — "connect the dots": records (ask/brief evidence
 boundary via `memoryRecords`), shared media hubs, targets, accepted/open findings,
 cluster people, device fingerprints, places, and regex-harvested typed entities
 (email/phone/@handle/url/domain/hashtag + exif serial / scan identity lifts)
 rendered as ONE self-contained interactive HTML force-graph (hand-rolled canvas
 JS, no CDN/egress; pan/zoom/drag, type toggles, text filter, node inspector with
 `view`/`case memory get` hints); edges carry provenance record ids —
 record↔media, finding→source/target, note→record, match-verb links, device
 membership, entity mentions, and the SHARED thread matcher for target↔evidence;
 `--extract` adds an opt-in brain-LLM entity/relation pass (BYO, text-only,
 cached to `.overcast/graph/extract.jsonl`, delete to re-extract; results are
 marked leads-not-proof with `payload.caveat`), `--focus` = 2-hop neighborhood
 (the anchor never trims), `--limit` trims lowest-degree leaf entities first,
 `--since` (capture-time-aware like `map`; co-filters `--extract`; an in-window
 finding pulls its out-of-window source record back in), `--theme
 plain|csi`, `--no-open`). `map` + `geofence` + `devices` + `graph` are
 operational (out of `ask`/`brief` evidence).
- **OSINT** — `scan` / `capture` / `monitor` (sources: youtube / tiktok / x / web /
  lens + yandeximg reverse-image / dl generic-yt-dlp capture / instagram / telegram /
  gdelttv broadcast-TV / overpass OSM-features / firms active-fires /
  dispatch police-CAD-calls / flights ADS-B-aircraft / webcam live-cams / facesearch reverse-face /
  dork Google-dorking / shodan host-recon / browser rendered-page-capture /
  username account-discovery / person people-search / phone reverse-phone /
  property assessor-records / plate license-plate /
  chain crypto-tx-history / edgar SEC-filings;
  `--since` recency; `--pull`/`--pipe` to capture+sense; `--transcript`/`--thumb`
  fetch-kind overrides (yt-dlp sources: captions+metadata / thumbnail instead of
  the video, no video download; `--lang` picks caption language);
  `monitor --once/--every`).
  With no enabled sources, `scan` falls back to local case media/indexes
  (`scan --local`). `index` (create/attach/add/list/show/delete/remove/entities —
  typed remote tinycloud indexes: media-descriptions → `ask --index`, entities →
  `index entities`, face-analysis → `face --index`; local DBs:
  `image-ransac` for `image match`, `deepface-local` for local face search,
  `face-cluster` for the `cluster` face DB, `basic-clip` for `similar` CLIP
  semantic search, `audio-fp` for `audio match` fingerprinting, `basic-clap` for
  `similar` CLAP audio search, `voice-print` for `voice` speaker matching).
  Built-in source refs: `youtube:@handle` (`youtube:shorts:@…`/`youtube:streams:@…`
  tabs; `--limit 0` = whole channel), `youtube:playlists:@handle` (playlists TAB —
  one hit per playlist w/ a ready `playlist_ref`), `youtube:search:<q>`,
  `youtube:playlist:<id>` or a URL; `tiktok:@user`, `tiktok:#tag`; `x:@handle`,
  `x:<advanced query>`, `x:video:<q>` / `x:image:<q>` (media targeting); `web:<q>`;
  `lens:<image url|path>` (Google Lens reverse image search via Apify);
  `yandeximg:<image url|path>` (Yandex reverse image search via Apify — the
  reverse-image twin of `lens`, strongest for faces/places; ships a working default
  actor + `image_url` input key, override via `OVERCAST_YANDEX_ACTOR` /
  `OVERCAST_YANDEX_IMAGE_KEY`);
  `dl:<url>` (any yt-dlp host — Rumble/BitChute/Odysee/Vimeo/Reddit/…; a
  channel/playlist/user URL `enumerate`s via yt-dlp flat-playlist so `scan`/`monitor`
  work there, a single-video URL stays capture-only → `[]`); `instagram:@handle` /
  `instagram:#tag` / a post URL
  (Apify); `telegram:<channel>` or a `t.me` URL (Apify, public channels);
  `gdelttv:"<query>"` (GDELT 2.0 TV broadcast-news clips → bounded Internet-Archive
  `.mp4`, **no key**); `overpass:key=value@around:<radius>,<lat>,<lng>` /
  `overpass:key=value@<south,west,north,east>` / raw OverpassQL (OpenStreetMap
  features via the Overpass API, **no key** — each element carries top-level
  `payload.gps` so scan records plot on `map`; media.ref = the OSM element page);
  `firms:<west,south,east,north>` (NASA FIRMS active-fire
  hotspots — bbox/area only, no country endpoint; CSV parsed by header name →
  `payload.gps` + ISO capture time; **free** `FIRMS_MAP_KEY`; `--since Nd` →
  dayrange 1–10; media.ref = a FIRMS fire-map deep link);
  `dispatch:sf` / `dispatch:seattle` / `dispatch:<domain>/<dataset>[@<datefield>]`
  (police CAD / calls-for-service feeds on the Socrata SODA API — **no key**,
  optional `SOCRATA_APP_TOKEN` raises rate limits; gps/call-type/id columns
  auto-detected per row, hits carry top-level `payload.gps` → `map`; media.ref = a
  stable per-row SODA deep link, the monitor dedup key; the real-time feeds are
  rolling windows (SF ~48h) → strong `monitor --every` fit);
  `flights:<west,south,east,north>` / `flights:<icao24>` /
  `flights:<callsign>` (live ADS-B aircraft positions via OpenSky — keyless-capable
  anonymous access, optional `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` OAuth2 to
  raise rate limits; each aircraft carries top-level `payload.gps` so scan records
  plot on `map` and `monitor --every` builds a track; media.ref = the aircraft-
  profile page; opt-in, never a default; AIS/vessel tracking is a deferred
  websocket-only follow-up); `webcam:<lat>,<lng>[,radius]` / `webcam:country:<ISO2>` /
  `webcam:category:<slug>` / `webcam:<id>` (Windy Webcams — current still per poll,
  `recapture` ephemeral monitor fit); `facesearch:<image url|path>` (opt-in,
  ToS/privacy-gated reverse **face** search via Apify — never a default);
  `dork:<google dork>` (Google dorking via Serper.dev — real Google SERPs that
  **honor** `site:`/`filetype:`/`inurl:`/… operators, unlike `web`; `SERPER_API_KEY`);
  `shodan:<search query>` or `shodan:<ip>` (host/service/banner recon via Shodan —
  search filters or a bare-IP host lookup; `SHODAN_API_KEY`); `browser:<url>`
  (rendered-page capture via the shared headless-Chromium screenshot engine — one
  ephemeral `recapture` hit, `fetch` renders the current page to a PNG; the
  `screenshot` verb is the one-shot surface, this source is the monitor/page-watch
  surface; no key, playwright optional dep); and the **identity / records** sources
  (all Apify-backed, `APIFY_TOKEN`, opt-in, PII on real people):
  `username:<handle>` (Maigret account discovery across 3000+ sites),
  `person:<Full Name>` / `person:<Full Name>@<location>` (people-search / skip-trace
  via Apify skip-trace — addresses/phones/emails/relatives/age; **not** an FCRA report),
  `phone:<E.164>` (reverse phone / number OSINT via PhoneInfoga — offline parse +
  web footprint), `property:<street, city, ST zip>`
  (address→assessor/tax/recorder records), and `plate:<ST>:<plate>` (license
  plate→vehicle SPEC via a bound actor — no default, `OVERCAST_PLATE_ACTOR`
  required, US owner data is DPPA-restricted). `dork`/`shodan`, `browser`, and every
  identity source are authorized-recon-only / opt-in, never a default binding.
  And the **financial** sources (the public money trail — real bank/transaction
  data is out of scope; each tx/filing is one scan record with `payload.created` =
  the event time, a stable per-item `media.ref`, and **no gps** → plots on `graph`,
  not `map`): `chain:btc:<address>` (BTC tx history via mempool.space, **keyless**)
  / `chain:eth:<address>` (ETH tx history via Etherscan, free `ETHERSCAN_API_KEY`;
  the explicit `btc:`/`eth:` prefix is required, amount normalized sats→BTC / wei→ETH,
  `direction` in|out|self + `counterparties`), and `edgar:<CIK>` /
  `edgar:"<company or full-text query>"` (SEC EDGAR corporate filings, **keyless** —
  SEC requires a descriptive contact-email User-Agent, `OVERCAST_HTTP_UA` default is
  compliant; bare CIK → submissions API, else full-text search; `media.ref` = the
  `sec.gov/Archives` filing document).
- **State** — `archive` (GLOBAL cross-case media buckets — case-shaped folders
  under `<home>/archive/<bucket>`, no registry file: `init | list | show | add |
  remove | setup`; items are sha256-deduped `capture` records with tags/notes/
  origin provenance; `archive setup` is the bucket index wizard, plan/`--yes`
  like case setup, backfilling existing media. From any case:
  `archive:<bucket>/<item>` resolves as a media arg (watch/capture/note --ref…),
  `--index archive:<bucket>/<index>` scopes face/similar/image/audio/voice/cluster/ask
  queries to the bucket — DB artifacts + mirror stay in the bucket, evidence
  persists to the active case stamped `meta.archive` — and
  `ask --archive <bucket>` searches the bucket's memory). `target` / `source`
  manage standing scope; a target is a *line of
  investigation* (`add --question`, `close <id> --as answered|dead-end --note`,
  `reopen`; closed lines stop seeding scans). `note` records human observations
  (anchored via `--ref`/`--at`/`--tag`/`--confidence`; the `thread:<tgt_id>` tag
  narrates a line for the brief/status thread cards). `finding`
  (create/list/accept/dismiss) holds manual + *suggested* findings: score/text
  triggers (face ≥75, image RANSAC, similar ≥85, cluster ≥70, voice ≥80, audio fingerprint,
  target-phrase matches) emit `status:"suggested"` leads that stay OUT of ask/brief evidence
  until reviewed — `finding list --state triage` queues them, `accept` promotes a
  lead to evidence (`--target <id|value>` stamps it onto a line of investigation,
  `--note <why>` records the review rationale on the review record),
  `dismiss` rejects it (never re-fires). Only AUTOMATED leads are quarantined:
  `finding create` is the operator's own promotion — an `open` finding that is
  evidence immediately (deliberate + attributed + reversible, not reviewed;
  `meta.provider` = `human` from the CLI/TUI vs `agent` via the agent tool,
  review rows `human-review`/`agent-review`). Mode is
  `setup.findings` (`suggest` default | `review` legacy | `off`), thresholds via
  `case setup --findings-threshold`. `prebrief` stands up name+target+source in
  one shot.
- **Read** — `ask` (cited retrieval over case memory; `--deep`/`--memory qmd` for
  semantic local search; `--index <id>` answers over a media-descriptions index,
  `--probe` for moment search), `brief` — **short by default**, story-first:
  Verdict (analyst `tldr` note leading; machine coverage line + pulse headline +
  "since last brief" delta demoted to one meta line) → one story per line of
  investigation (question → answer-so-far → linked findings → latest evidence →
  NEXT; findings link via `target_id` stamps or text match, rendered by the
  SHARED mission renderer `src/report/mission.ts` that `case status` also uses) →
  unattached findings → triage queue (score + source excerpt + review commands) →
  ONE coverage table (configured funnel + ad-hoc sweeps, never-scanned flagged) →
  newest-first record trail; `--full` swaps in the verbatim chronological record
  dump (audit), `--export` md/html, `--theme plain|csi`. In a terminal, `brief`
  and `case status` print the md report by default (`--json` for the envelope).
  `/debrief` (prompt) drives the analyst loop: triage leads (`finding accept
  <id> --target <line>`) → narrate each thread → close resolved lines → refresh
  `tldr` → export.
- **Case** — `case init | setup | status | info | records | memory | clear`.
  `case status`/`records`/`brief` HTML `--export` takes `--theme plain|csi`
  (direct CLI defaults to `plain`; agent/TUI `.html` exports default to `csi`).
  `case setup`
  is the first-run wizard + saved-setup manager (`status|show|edit|plan`, persisted
  to `.overcast/setup.json`). `case memory get <id> --field <name>
  --offset/--limit` pages a large record field in full — the non-truncating way to
  read a `watch` `content` / `listen` transcript, vs head/tail-ing raw jsonl.
  `case memory index status|rebuild|start|retry` manages materialized case-search
  backends (qmd).
- **Config / dist** — `setup` (bind brain LLM + per-verb providers, manage
  profiles), `provider` (`setup plan|apply|show` catalog-backed profile setup, plus
  `init|list|describe`), `doctor` (preflight; `--sources` also checks source
  creds), `skills` (generate/install).
- **Base verbs from pi** (don't reimplement): `read write edit bash grep find ls`.

Slash commands (TUI): `/target /source /index /archive /case /prebrief /view /wall /graph
/map /setup /provider /finding` (extension commands), `/chair` (man in the chair: token-authed
localhost/tailnet bridge + phone web console that remote-drives the live session —
steer/follow-up/abort/case glance, typed or mic-dictated via the browser's Web
Speech API (secure-context only — `/chair on --serve` fronts the QR with
`tailscale serve` HTTPS so phone voice works; also auto-detects an existing
serve, or `--url`/`OVERCAST_CHAIR_URL` for an explicit origin; `src/chair/serve.ts`);
extension-only, no agent tool, emits no case records), `/situation` (the live
monitoring page: `on [tailnet|--bind|--port|--panels …]|off|status|qr|set …|stop`
— an in-process `SituationServer` bound to the session, same operator-only-to-open
rule as `/chair`; `set`/`stop` delegate to the agent-safe verb ops; the chair's
case glance surfaces a "SITUATION LIVE" card off `runtime.json`), and
`/ask /brief /debrief` (prompt templates in `prompts/`), plus pi
built-ins (`/model /tree /session /resume`).

## Case model & memory

A case is a directory + its `.overcast/` store (records as JSONL, media, state,
index mirrors). `case setup` saves a *mutable* setup model to
`.overcast/setup.json` and emits *immutable* `case` history records
(`payload.op = startup_setup` / `startup_setup_update`). An **archive bucket**
is a case-shaped folder under `~/.overcast/archive/<bucket>` — the same store,
reused by the same machinery; `src/archive.ts` owns bucket naming/refs and the
`resolveIndexScope` seam the typed verbs use for `--index archive:…`.

Case memory is **evidence-only**. `ask` / `brief` read primary evidence
(`watch listen see face image audio voice similar crop note scan capture enhance
exif verify screenshot chronolocate` + root `finding`s + `cluster` ingest/identify) through
bound memory providers — `local-grep` (always on) and optional `qmd` (semantic;
`setup memory qmd`, then rebuild before querying). Read/meta and operational
records (`ask brief case setup doctor provider skills index archive target source
prebrief wall situation grid map geofence devices graph reconstruct` — reconstruct deliberately: synthesized pixels
stay out of evidence, `payload.caveat` on every record —, finding review-rows,
dismissed **and suggested** findings (a
suggested lead is quarantined until `finding accept` promotes it), cluster DB
reads/maintenance `list/show/view/label/recluster`) are excluded even when they
match the query. `face`/`see`/`image`/`audio`/`voice`/`similar`/`cluster` detections index only
compact summaries / counts / moments / matched refs / offsets — raw boxes, thumbnails,
homographies, fingerprint hashes, and vectors stay in the record for exact reads and `crop`.
Local visual DB artifacts stay in typed local indexes: local-grep/qmd ingest the
records and summaries, not binary media, embeddings, sampled frames, match
visualizations, or raw face boxes.
The saved setup's memory signal list + per-provider `indexable` flags narrow what
each case searches. Provider execution always follows the **active profile
binding**; case setup records expected choices/policy and can clear built-ins like
`enhance:ffmpeg`, but never pins a stale exec descriptor.

## Commands

```bash
bash scripts/setup-dev.sh # one-shot dev init: npm ci + build + optional e2e-media fetch + tool report
                          # (--tinycloud installs the tinycloud CLI; --venv [mode] builds the uv
                          #  Python venv + wires OC_VISUAL_DB_PY/DETECT_PY; --system-deps installs
                          #  missing system tools via brew/apt (ffmpeg, exiftool, …) + yt-dlp via
                          #  uv tool/pipx/pip with curl-cffi impersonation; --full = all of the above)
npm run build            # tsup (dev/library build) + vite chair-console build
npm run typecheck        # tsc --noEmit (src + web/chair)
npm test                 # unit tests (offline; fixtures)
npm run test:e2e         # offline e2e (fixture providers, no creds)
npm run test:e2e:live    # LIVE real-data e2e (builds bun binary, sources .env)
npm run e2e:media        # fetch the hosted live-e2e media bundle (needs OC_E2E_MEDIA_URL)
npm run dev:clean        # prune old e2e run output in .dev/ (scripts/clean-dev.sh)
npm run build:bun        # bun build --compile → dist/bin/overcast
overcast commands --json # dump the verb registry (authoritative)
overcast doctor          # preflight: pi, providers, creds, ffmpeg
```

**e2e procedure: [`test/e2e/README.md`](test/e2e/README.md)** — what each suite
covers, the `.env`/clip contract ([`.env.example`](.env.example)), and how to add a
case. CI gates shell scripts with `shellcheck -S warning`.

## Verifying changes

Ground claims in reality: for provider/record changes, run a verb against a fixture
and inspect the emitted record JSONL. For skill/doc changes, check against
`overcast commands --json`. For TUI/theme, launch `overcast` and eyeball the banner
+ colors. For end-to-end proof against real backends (providers, record contract,
CLI router, bun binary), run the live suite (`npm run test:e2e:live`) and inspect
the generated `report.md`. Keep pi touch-points isolated in `src/extension/` and
`src/registry/to-agent-tool.ts` so a pi bump has a small blast radius.

## Cursor Cloud specific instructions

The startup update script runs `npm ci` for the root, `vscode/`, and the sibling
`overcast.video` marketing-site repo (all guarded by their `package.json`, via
`npm --prefix`, so it is cwd-independent and safe if a repo is absent); the root
`postinstall` (`scripts/brand-pi.mjs`) runs automatically. `ffmpeg`/`ffprobe`
are already installed system-wide. Standard verb/test/build commands live in the
`## Commands` section above and in `package.json` — reference those, not copies.

The source-controlled update script is `scripts/cursor-update.sh` — point the
Cursor environment "Update Script" field at it
(`bash /agent/repos/overcast/scripts/cursor-update.sh`). It does a guarded per-repo
`npm ci` (root + `vscode/` + the sibling `overcast.video`) plus the optional
`scripts/fetch-e2e-media.sh` media wiring, and nothing else — no build, tests, or
`npm i -g` (those are on-demand / snapshot-layer). Do NOT point the Cursor update
script at `scripts/claude-setup.sh`: that wrapper is gated on `CLAUDE_CODE_REMOTE=true`
(a Claude Code cloud SessionStart hook) and no-ops under Cursor. (`scripts/setup-dev.sh`
is the richer shared repo-setup layer — deps + build + media — but it builds and
covers only the overcast repo, so it is not the update-script default.)

This cloud workspace mounts two sibling repos under `/agent/repos/`: this one
(`overcast`, the CLI toolkit) and `overcast.video` (a Vite + React + Tailwind
marketing site — `npm run dev` on `http://localhost:5173`, `npm run lint` =
oxlint, `npm run build` = `tsc -b && vite build`; see its own `README.md`).

Non-obvious caveats (Cursor Cloud — the Claude Code on the web section below notes
where that environment differs; conceptual items here like offline-by-default,
which Secrets matter, the fast test loop, and "no ESLint" apply in both):

- **`bun` is not in the base Cursor Cloud image — install it (snapshot-layer).**
 The whole node dev loop works without it: the dev build (`tsup`/`vite`), typecheck,
 `npm test`, and offline `npm run test:e2e` all run under `node`, and the live suite
 runs under `node` with `OVERCAST_USE_NODE=1`. bun is only needed to compile the
 real binary (`npm run build:bun`) and as the live suite's default runner. Install
 it once with `bash scripts/setup-dev.sh --bun` (or `curl -fsSL https://bun.sh/install
 | bash`) → it lands in `~/.bun` and appends `~/.bun/bin` to `~/.bashrc`, so a saved
 VM snapshot keeps it for later sessions (same snapshot-layer pattern as the
 tinycloud CLI above — keep it OUT of the update script).
- **Run the built CLI as `node dist/bin/overcast.js`** (no global `overcast` bin on
 PATH); `npm run dev` (`tsx bin/overcast.ts`) runs it from source. A local case is
 just a folder — `case init` in any dir, or `--case <dir>`.
- **Node version.** The default `node` is 22.14.x, which runs the CLI, build,
 typecheck, and all test suites fine. `@earendil-works/pi-tui` declares
 `engines.node >= 22.19.0`, so `npm ci` prints an `EBADENGINE` **warning** (not an
 error). If the interactive pi TUI (bare `overcast` / `npm run dev`) misbehaves,
 `nvm use 22.22.2` (already installed) satisfies that engine floor.
- **Offline by default — no keys needed for core dev.** `overcast doctor` will
 report `cloudglue`/`tinycloud`, `playwright`, `uv`/`visual-db`/`audio-db`,
 `exiftool`, and `c2patool` as missing/failed — these are all *optional*
 cloud/OSINT/Python backends. The core product (case management + local senses
 like `chronolocate`, plus `note`/`target`/`finding`/`brief`) works fully offline.
- **What needs secrets to run for real** (add via Secrets, not required for tests):
 tinycloud CLI + `CLOUDGLUE_API_KEY` for the default `watch`/`listen`/`face`/`index`
 senses; a brain-LLM key (BYO, e.g. `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) for the
 agent TUI and the default vision `see`; OSINT source keys per `.env.example`.
- **Installing global npm CLIs (e.g. the tinycloud binary) needs a writable
 prefix.** The default `node` on PATH here (`/exec-daemon/node`) has its npm global
 prefix set to `/`, so a bare `npm i -g @cloudglue/tinycloud` fails with
 `EACCES … mkdir '/usr/lib/node_modules'`. Install into a user-writable prefix and
 put it on PATH once (snapshot-cached for later sessions):
 `export NPM_CONFIG_PREFIX="$HOME/.npm-global"` → `npm i -g @cloudglue/tinycloud`
 → add `$HOME/.npm-global/bin` to PATH (e.g. in `~/.bashrc`). This installs
 tinycloud ≥ 0.3.12 (verified: watch/listen/face light up with real Cloudglue once
 `CLOUDGLUE_API_KEY` is set + e2e media is fetched). This is snapshot/system-layer
 work — keep it OUT of the update script (a hard `npm i -g` failure there would
 block session startup), like the apt/system tools noted in `scripts/claude-setup.sh`.
- **Live e2e media** is fetched by `scripts/fetch-e2e-media.sh` when the
 `OC_E2E_MEDIA_URL` (+ optional `OC_E2E_MEDIA_SHA256`) Secrets are set — it caches a
 bundle outside the repo and splices absolute paths into a managed `.env` block. Run
 the live suite with `OVERCAST_USE_NODE=1 npm run test:e2e:live` (no bun here);
 cases without their key/tool/clip SKIP (counted as pass).
- **Fast test loop.** After one `npm run build`, reuse `dist/` with
 `SKIP_BUILD=1 npm run test:e2e`. Offline unit + e2e suites need no network/creds;
 the live suite (`npm run test:e2e:live`) does and is not runnable here without
 `.env` keys + media.
- **Running the LIVE suite here.** Set `OC_E2E_MEDIA_URL` (+ optional
 `OC_E2E_MEDIA_SHA256`) as a Secret, run `bash scripts/fetch-e2e-media.sh` once
 (downloads the unlisted media bundle to `~/.cache/overcast-e2e-media` and splices
 the paths into `.env` under a managed block), then
 `OVERCAST_USE_NODE=1 npm run test:e2e:live` (bun is absent). Cloud-backed cases
 also need their provider Secrets; anything unset just SKIPs. Prune accumulated
 run output with `npm run dev:clean` (`scripts/clean-dev.sh`).
- **No ESLint.** Lint in CI is `shellcheck -S warning` over `*.sh` only.

## Claude Code on the web (cloud sessions)

Repo setup on Claude Code on the web splits across **two** places — get the split
right or the session comes up inert:

- **Environment "Setup script" field** = SYSTEM tools only. It runs BEFORE Claude
  Code launches, **as root, with `cwd=/`** (the repo is NOT the working directory),
  and its output is snapshot-cached. A bare `npm install`/`npm run …` here fails
  with `ENOENT: … open '/package.json'` and the non-zero exit blocks the session.
  Put ONLY package-manager installs here — this exact content is source-controlled
  as `scripts/claude-cloud-system-setup.sh` (paste that file):

  ```bash
  #!/bin/bash
  apt-get update && apt-get install -y ffmpeg libimage-exiftool-perl || true
  # apt yt-dlp is too old for current YouTube; curl-cffi = impersonation for
  # TLS-fingerprinting hosts. Plain-yt-dlp fallback: a failed extra rolls back
  # the whole pip transaction, and impersonation-less beats absent.
  pip install -U --break-system-packages "yt-dlp[default,curl-cffi]" \
    || pip install -U --break-system-packages yt-dlp || true
  npm i -g @cloudglue/tinycloud || true                   # default watch/listen/face/index backend
  ```

  (The `npm i -g` runs as root here, so it installs cleanly; if a variant of this
  environment instead has an npm global prefix of `/`, use the writable-prefix
  workaround from the tinycloud caveat in the Cursor Cloud section above.)

- **Repo build** = the `SessionStart` hook (`.claude/settings.json` →
  `scripts/claude-setup.sh` → `scripts/setup-dev.sh`): `npm ci` + build + e2e-media
  fetch, run after launch inside the clone on every session start. Cloud-only by
  default (`CLAUDE_CODE_REMOTE=true`; `OC_CLAUDE_SETUP_LOCAL=1` opts a dev box in),
  with a warm-session fast path gated on a `.dev/claude-setup-ok` success stamp.

Environment-specific caveats (deltas from the Cursor Cloud notes above; the
conceptual ones there — offline-by-default, which Secrets matter, the fast test
loop, `node dist/bin/overcast.js` to run the CLI, no ESLint — hold here too):

- **`bun` is usually available** here (this environment ships it, unlike Cursor
  Cloud), so `npm run test:e2e:live` can build the real binary. Don't rely on it
  unconditionally, though: `OVERCAST_USE_NODE=1` (run `node dist/bin/overcast.js`)
  is the safe default, is usually pre-set, and is the fallback if `bun` is absent.
- **Chromium for `screenshot`/`browser:`** — the image pre-installs a Chromium under
  `PLAYWRIGHT_BROWSERS_PATH` (e.g. `/opt/pw-browsers`) with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and its revision often differs from the one
  the pinned `playwright` expects. The screenshot engine
  (`providers/engines/screenshot/render.mjs`, `resolveChromiumExecutable`) and the
  `doctor` probe auto-detect the on-disk build, so this needs no extra step;
  `OVERCAST_PLAYWRIGHT_EXECUTABLE` is the override if it can't be found.
- **Live e2e media** — set `OC_E2E_MEDIA_URL` (+ `OC_E2E_MEDIA_SHA256`) as Secrets;
  the hook's `fetch-e2e-media.sh` wires the paths into `.env`. Provider Secrets
  (`CLOUDGLUE_API_KEY`, `APIFY_TOKEN`, `SERPER_API_KEY`, …) flow from the session
  env; anything unset just SKIPs.
- **The `tinycloud` CLI (a `bun` binary) can't reach the network through a
  TLS-re-terminating egress proxy** — so on Claude Code on the web the default
  `watch`/`listen`/`face`/`see:tinycloud` senses fail even with a valid
  `CLOUDGLUE_API_KEY`. `bun`'s `fetch` completes the proxy `CONNECT` (`200
  Connection Established`) but then dies on the MITM TLS handshake with `Cloudglue
  returned a transient error (500): The socket connection was closed unexpectedly`
  (`cloud_ready:false`) — and `NODE_EXTRA_CA_CERTS` does NOT fix it (bun 1.3.11
  ignores it for tunneled TLS; reproduce with `bun -e 'await
  fetch("https://example.com")'` failing while `node -e 'await
  fetch("https://example.com")'` returns 200). This is a **bun+proxy limitation,
  not an egress-allowlist, CA, or Cloudglue-API problem** — the REST API works
  directly (`curl -F file=@… https://api.cloudglue.dev/v1/files` → 200), and every
  node/curl-based provider (HF, ElevenLabs, Apify sources, yt-dlp) is unaffected.
  The whole sense-dependent chain (`index`/`findings`/`case_search`/`brief`/`graph`/
  `wall`) cascades red in the live suite as a result. **The fix:** set
  `OVERCAST_TINYCLOUD_DIRECT_EGRESS=1` — overcast then strips the proxy vars from
  the tinycloud subprocess only, so its bun runtime connects DIRECTLY (this
  environment allows direct egress; verified: `watch`/`face` go `ready` with it
  set). This deliberately bypasses the egress proxy for tinycloud traffic, so it's
  opt-in (like `OVERCAST_ALLOW_PRIVATE_FETCH`), never a default; leave it off if
  your policy forbids bypassing the proxy. A tinycloud error while a proxy is set
  now carries this hint. Long-term the real fix is upstream (bun applying the proxy
  CA to tunneled TLS); the embedded runtime means the system bun version is
  irrelevant.
