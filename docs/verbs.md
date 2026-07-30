# Verb & source reference

The full verb surface and every built-in source ref. This is the human-readable
companion to the authoritative registry — run `overcast commands --json` for the
source of truth, or `overcast <verb> --help` for a man page. (`overcast --help`
shows the full surface + env vars.) For how the verbs chain into real
investigations, see the [Field Manual](field-manual.md); for binding backends,
see [configuration.md](configuration.md).

## Verbs

**Senses** — turn media into records
| verb | does |
|---|---|
| `watch` | analyze a video → `content` / `transcript` / `detailed` (default: Cloudglue); `--segment shots\|chapters\|segments\|uniform:<s>` picks the provider's segmentation (`--shot-min-seconds`/`--shot-max-seconds` tune shot detection); `meta.segmentation` reports what ACTUALLY ran — trust it over the `detailed` echo (tinycloud ≤ 0.3.15 echoes `uniform:20` there even on a shots run), and a request/ran kind mismatch adds `payload.warning` |
| `listen` | transcribe audio / a video's audio; `--describe` for the full audio-scene |
| `see` | caption / OCR / detect on an image, image URL, or video frame (default: the brain LLM when image-capable; falls back to HF, or bind a VLM / the opt-in tinycloud `see`+`extract` provider, ≥ 0.3.7) |
| `face` | detect faces in a video, `--match <img>` to find a person, or search a face-analysis index |
| `image` | match images/video frames against a local OpenCV RANSAC image index |
| `audio` | Shazam-style exact audio matching against a local `audio-fp` index (time-offset alignment), or clip-to-clip `audio match <query> <reference>`; `--min-margin` rejects sped re-uploads, `--draw` renders an SVG alignment plot for briefs |
| `voice` | speaker verification: enroll voices into a local `voice-print` index (`voice add`), rank members containing a reference speaker (`voice match <sample> --index`), or locate WHERE a speaker talks in a clip (`voice match <clip> <sample>`; `--diarize` for the overlap-aware pyannote tier). Rank scores, not liveness — clones can score high |
| `cluster` | local face DB: ingest faces → group into people (assign-or-create), `identify`, `recluster`, `label`, HTML `view` |
| `similar` | cross-modal semantic search over a local CLIP (`basic-clip`) or CLAP (`basic-clap`) index — `search` by text, `match` by image/audio, video/audio moments included |
| `exif` | embedded metadata from an image or video (ExifTool) — GPS (`payload.gps`), capture time, camera make/model/serial/lens (the fingerprint `devices` groups by), editing software; `--geocode` reverse-geocodes via the opt-in geocode provider. The geocode provider also has a **forward** mode (`bash providers/senses/geocode/geocode.sh --query "<address>"` → `{lat,lng,place}`, keyless Nominatim) — the address→point step used by the `overcast-canvass` skill to fan `overpass`/`webcam` camera sources around a location |
| `verify` | C2PA / Content Credentials provenance check (c2patool) — `has_manifest`, signer, claim generator, validation state; no credentials is a clean record, not an error |
| `screenshot` | render a web page or a local `.html` export to a PNG evidence record via headless Chromium (playwright optional dep); `--full-page`, `--viewport WxH`, `--wait ms` |
| `enhance` | denoise / normalize / upscale via system ffmpeg, a bound restore model, or the provider ops — `--ops separate` (per-speaker tracks, `--summarize` to transcribe each), `--ops segment --prompt` (text-prompted masks + cutouts), `--ops ela` (ELA/noise/luminance forensic overlays), `--ops panorama` (stitch a panning video into one wide still) — one evidence record per artifact |
| `reconstruct` | **speculative** camera reposition from a still — `--rotate`/`--elevate`/`--zoom`, `--ops sweep` (360° turntable), `--ops model` (image→3D GLB), `--ops depth`, `--ops age --age-years <±N>` (age-progress / de-age the subject of a REAL photo, −40..+60 — the output is a synthesized LIKENESS with an extended caveat: NEVER a `face`/`cluster`/`similar` match probe, and composite-from-text-description is an explicit non-goal) — via a bound fal provider; a hypothesis renderer, never evidence (`payload.caveat`, quarantined from ask/brief) |
| `chronolocate` | chronolocation from the sun/shadows — pure offline solar math, no key: verify a claimed capture time (`--at-time`) or solve the time window a shadow bearing implies (`--shadow-azimuth`) |

**Deliberately out of scope — no deception detection.** overcast does not and
will not ship deception detection, voice-stress analysis, or micro-expression
"lie detection". This is a principled choice, not an oversight or a roadmap
gap: the underlying methods have no validated scientific accuracy, and a verb
that outputs "72% likely lying" would manufacture confident-sounding junk. The
senses already hold the opposite bar — `voice` scores identity, explicitly NOT
liveness or truthfulness (clones score high; every record carries
`payload.caveat`), and `reconstruct`'s synthesized pixels are quarantined out
of evidence. For **descriptive** acoustics — tone, ambience, what the audio
scene contains — use `listen --describe`; for WHO is speaking, use `voice`.

**Inspect** — look at the evidence
| verb | does |
|---|---|
| `view` | open media in a scrubbable local HTML player (timeline markers, spectrogram); on an `enhance` split-op parent, a gallery of the tracks (audio + spectrograms) or cutouts |
| `crop` | materialize face/object detections as cropped image records with provenance |
| `grid` | tile timestamped frames into one contact sheet for single-call VLM triage (cell → timestamp map); `--view` for a clickable, numbered HTML board that seeks the clip |
| `wall` | control-room monitor wall — every case video muted + looping its best evidence moment, case state overlaid |
| `situation` | **monitor the situation** — a live, token-authed local page (default `127.0.0.1:7374`) over the case: wall tiles + reverse-chron scan/monitor feed + live gps map + refreshing webcam/browser stills, self-updating as records land; `serve` (default) is operator-only, `status`/`set`/`stop` are the agent-safe control plane, `--every` makes it own the monitor cadence |
| `map` | plot every case record carrying `payload.gps` on one self-contained HTML map — markers link back to their source records; `--offline` for a no-egress coordinate scatter; `--near <lat,lng>` (`--radius <m>`, default 500) or `--bbox <minLat,minLng,maxLat,maxLng>` spatially filter the plotted points (the same fence semantics as `geofence`) |
| `geofence` | the geofence-warrant query — list every case record whose `payload.gps` falls inside a `--near <lat,lng>` circle (`--radius <m>`, default 500) or a `--bbox <minLat,minLng,maxLat,maxLng>` box (inclusive, non-wrapping), captured within `--since`/`--until` (capture-time-aware like `map`; undated records that intersect spatially are kept, `capture_time` null). Pure local read over `payload.gps`-bearing records (`exif`, geo sources dispatch/firms/flights/overpass); emits ONE operational rollup record — matches newest-first + per-verb counts + the query echoed back — a viewer over evidence, never ask/brief evidence; an empty intersection is a clean ready record with guidance |
| `devices` | group case `exif` records by camera fingerprint (serial = strong link, make+model+lens = weak) into shared-device clusters; `--findings` emits serial-linked suggested findings |
| `graph` | **connect the dots** — build the case knowledge graph (records, media, targets, findings, cluster people, device fingerprints, places, typed entities) and render it as one self-contained interactive HTML force-graph; `--focus <node>` for a 2-hop view, `--extract` adds an opt-in brain-LLM entity pass (leads, not proof) |

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
| `finding` | manual + **auto-suggested** findings (`create` / `list` / `accept` / `dismiss`). Score triggers (face / image / similar / cluster / audio match) + target text hits auto-emit `suggested` leads via a hook on every verb; `finding list --state triage` queues them, `accept` promotes a lead to evidence (`--target <id\|value>` stamps it onto a line of investigation so it renders in that thread, `--note <why>` records the review rationale), `dismiss` blocks re-suggestion. Leads are quarantined from ask/brief until accepted. Only **automated** leads are quarantined: `create` is the operator's own promotion — an `open` finding that is evidence immediately, attributed on `meta.provider` (`human` from the CLI/TUI, `agent` via the agent tool) and reversible with `dismiss` |
| `prebrief` | stand up a case (name + target + source) in one shot |

**Read** — synthesize the case
| verb | does |
|---|---|
| `ask` | natural-language query over case memory → answer with `record.id` + `media.at` citations; `--deep` uses configured semantic memory such as qmd; `--index <id>` answers over a media-descriptions index (`--probe` for moment search); `--archive <bucket>` asks over a global archive bucket |
| `brief` | analyst report — **short by default** (verdict + delta / per-line-of-investigation stories / unattached findings / triage with score + excerpt / one coverage table / newest-first trail), `--full` for the verbatim timeline; `--export` to md/html; prints the md report in a terminal |
| `case` | inspect/manage the case: `init` / `setup` / `status` (mission board) / `info` / `records` / `memory` / `clear` (`memory get <id> --field <name> --offset/--limit` pages a large record field in full) |

**Config / SDK / dist** — `setup` (bind providers + brain LLM), `provider`
(init/list/describe), `doctor` (preflight), `skills` (generate/install).

**Base verbs** come from pi: `read` `write` `edit` `bash` `grep` `find` `ls`.

## Case setup

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
tinycloud-backed for scale and portability. Note the upstream default:
`media-descriptions` collections created through tinycloud index **speech +
summary only** (the Cloudglue-side `describe_config` disables visual scene
descriptions, scene text, and audio descriptions; the tinycloud CLI has no flag
to change it, and the config is immutable after create) — `ask --index` over
such a collection answers from the spoken words, not the visual channel. For
visual/on-screen-text questions, `watch` a clip directly (its default describe
IS full multimodal) or create the collection out-of-band with an explicit
`describe_config`. When setup applies with local videos
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

## Global archive

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

## Built-in source refs

- `youtube:@handle` — enumerate a channel's videos (`youtube:shorts:@handle` / `youtube:streams:@handle` for those tabs; `--limit 0` = the whole channel/playlist).
- `youtube:playlists:@handle` — enumerate a channel's playlists TAB: one hit per playlist, each carrying a `youtube:playlist:<id>` ref ready for `source add`.
- `youtube:search:<query>` or `youtube:<keyword>` — YouTube keyword search.
- `youtube:playlist:<id>` or `youtube:<full YouTube URL>` — enumerate a playlist/video URL. `scan … --pull --transcript` (or `capture <url> --transcript`) pulls captions + full metadata per video with NO video download (`--thumb` = thumbnail image; `--lang` picks the caption language).
- `tiktok:@user` — enumerate a TikTok profile.
- `tiktok:#tag` — enumerate a TikTok hashtag.
- `x:@handle` — enumerate an X (Twitter) profile's posts.
- `x:<query>` or `x:#tag` — X advanced search (`from:`, `filter:native_video`, `min_faves:`, …).
- `x:video:<query>` / `x:image:<query>` — only X posts with native video / images (media targeting).
- `web:<query>` — web search through Tavily, falling back to Brave when Tavily is unset.
- `lens:<image url or local path>` — Google Lens reverse image search (Apify): exact + visual page matches for an image.
- `yandeximg:<image url or local path>` — Yandex reverse image search (Apify) — the reverse-image twin of `lens`, strongest for faces/places; ships a working default actor (`OVERCAST_YANDEX_ACTOR` / `OVERCAST_YANDEX_IMAGE_KEY` to override).
- `dl:<url>` — generic yt-dlp fetcher for any supported host (Rumble, BitChute, Odysee, VK, Bilibili, Vimeo, Dailymotion, Reddit, Facebook, …). A channel/playlist/user URL enumerates via yt-dlp flat-playlist so `scan`/`monitor` work; a single-video URL stays capture-only (`[]`), routing ad-hoc `capture <url>`.
- `instagram:@handle` / `instagram:#tag` / `instagram:<post URL>` — Instagram posts & reels (Apify); `--since` honored server-side.
- `telegram:<channel>` / `telegram:<t.me URL>` — public Telegram channel posts (Apify, no login); stable `t.me/<channel>/<id>` per-post URL for clean monitor dedup.
- `gdelttv:"<query>"` — GDELT 2.0 TV API broadcast-news clips (**no key**) → bounded Internet-Archive `.mp4?start=…&end=…` segments; `--since` maps to the GDELT date window.
- `overpass:key=value@around:<radius>,<lat>,<lng>` / `overpass:key=value@<south,west,north,east>` / raw OverpassQL — OpenStreetMap features via the Overpass API (**no key**); each element carries `payload.gps` so hits plot on `map`, and `media.ref` is the OSM element page.
- `firms:<west,south,east,north>` — NASA FIRMS active-fire hotspots for a bbox (free `FIRMS_MAP_KEY`); `--since Nd` maps to dayrange 1–10; hits carry `payload.gps` + a FIRMS fire-map deep link.
- `dispatch:sf` / `dispatch:seattle` / `dispatch:<domain>/<dataset>[@<datefield>]` — police CAD / calls-for-service feeds on the Socrata SODA API (**no key**; optional `SOCRATA_APP_TOKEN` raises rate limits): real-time dispatched 911 calls with auto-detected gps/call-type/id columns; hits carry `payload.gps` (→ `map`) and a stable per-row deep link, and the rolling real-time windows (SF ~48h) make it a strong `monitor --every` fit.
- `flights:<west,south,east,north>` / `flights:<icao24>` / `flights:<callsign>` — live ADS-B aircraft positions via OpenSky (**anonymous works**; optional `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` OAuth2 raises rate limits); hits carry `payload.gps` so they plot on `map` and `monitor --every` builds a track.
- `webcam:<lat>,<lng>[,radius]` / `webcam:country:<ISO2>` / `webcam:category:<slug>` / `webcam:<id>` — live public webcams (Windy Webcams API); each hit's `media.ref` is the current still, re-captured every `monitor` pass (`recapture`).
- `facesearch:<image url or local path>` — **opt-in** reverse **face** search (Apify); ToS/privacy-gated, never a default source.
- `dork:<google dork>` — Google dorking via Serper.dev: real Google SERPs that **honor operators** (`site:`, `filetype:`, `inurl:`, `intitle:`, `ext:`, `-term`, `OR`), unlike `web`. The result page is captured as evidence. **Authorized recon only**, never a default source.
- `shodan:<search query>` / `shodan:<ip>` — host/service/banner intelligence via Shodan: search filters (`org:`, `net:`, `ssl:`, `product:`, `port:`, …) or a bare IP → full host lookup. Hits carry ip/port/org/product/cpe/vulns/geo; `media.ref` is the `shodan.io/host/<ip>` report page (`#<port>-<transport>` fragment so each service is distinct). Strong `monitor` fit. **Authorized recon only**, never a default source. **Opt-in (sensitive):** `OVERCAST_SHODAN_SCREENSHOTS=1` also materializes exposed-host screenshots (RDP/VNC/HTTP/camera → `see`/`face`/`crop`) and surfaces RTSP stream endpoints — real unwitting hosts, off by default.
- `browser:<url>` — rendered-page capture via headless Chromium (Playwright optional dep, **no key**). Each `fetch` re-renders the page's current state to a PNG (`recapture` — `monitor --source browser --pull` becomes a page-watch that flows into image `auto_sense`). The one-shot counterpart is the `screenshot` verb. Private/loopback targets refused by default (`OVERCAST_ALLOW_PRIVATE_FETCH=1` to allow).

## Financial sources (the money trail)

The PUBLIC money trail as scan records — real bank/transaction data is out of
scope. Each transaction/filing becomes one `scan` record: `payload.created` = the
event time, `media.ref` = a stable per-item deep link, and **no gps** (the trail
plots on `graph`, not `map`).

- `chain:btc:<address>` / `chain:eth:<address>` — public blockchain transaction history: BTC via mempool.space (**keyless**), ETH via Etherscan (free `ETHERSCAN_API_KEY`). Each tx becomes a scan record — `payload.created` = the block time, `media.ref` = a per-tx explorer deep link (`mempool.space/tx/…` / `etherscan.io/tx/…`), `amount` normalized to whole units (sats→BTC, wei→ETH), `direction` `in`|`out`|`self` (from whether the queried address is on the input side, output side, or both), and `counterparties[]`. The explicit `btc:`/`eth:` prefix is **required** (v1) — a bare address is rejected. `--since` filters by block time.
- `edgar:<CIK>` / `edgar:"<company or full-text query>"` — SEC EDGAR corporate filings (**no key**; SEC 403s a blank/bot User-Agent, so a descriptive one carrying a contact email is sent — `OVERCAST_HTTP_UA` overrides the default, but a URL/parens value SEC would reject is ignored in favor of the compliant default). A bare 1–10 digit CIK (optional leading `CIK`) → the company's recent filings (submissions API); anything else → EDGAR full-text search. Each filing becomes a scan record — `payload.created` = the filing date, `media.ref` = the `sec.gov/Archives` filing document, plus `form`/`accession`/`cik`/`company`. `--since` filters by filing date (pushed to the EFTS server for full-text). The CIK/submissions path is newest-first; **full-text is relevance-ranked** (EFTS exposes no server date sort — use a CIK for exhaustive chronology) and is paginated so `--limit` is honored past the ~10-hit default page.

## Identity / records sources

Apify-backed (`APIFY_TOKEN`); opt-in, live PII on real people, **authorized use
only**, never a default source. Read [RESPONSIBLE_USE.md](../RESPONSIBLE_USE.md)
before pointing any of these at a person.

- `username:<handle>` — social/forum **account discovery** via Maigret (accounts across 3000+ sites → profile URL + name/bio/avatar per hit). The username twin of `facesearch`.
- `person:<Full Name>` (optional `@<location>`) — **people-search / skip-trace** via Apify (current + prior addresses, phones, emails, aliases, relatives, age). **Not an FCRA report** — no employment/credit/tenant use.
- `phone:<E.164>` — reverse phone / **number OSINT** via PhoneInfoga (offline parse: carrier guess / country / validity + grouped web footprint).
- `property:<street, city, ST zip>` — address → **county assessor / tax / recorder records** (owner, assessed/market value, tax + sale history).
- `plate:<ST>:<plate>` — license plate → **vehicle spec** (VIN / year / make / model) via a **bound** actor. No default — US plate data is DPPA-restricted; set `OVERCAST_PLATE_ACTOR` (or `OVERCAST_SOURCE_PLATE_CMD`). **Vehicle spec only, not the owner.**
