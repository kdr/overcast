# overcast — common flows & usage patterns

How the verbs fit together: the mental model, what becomes searchable, and the
case lifecycles you'll reach for most. Run `overcast commands --json` for the
authoritative verb registry, `overcast <verb> --help` for a man page, and see
[`providers.md`](providers.md) for provider authoring. Every command writes one
or more loose **records** into the case; cite findings by `record.id` +
`media.at`.

## Mental model

overcast is organized around a **case**: a directory with a local `.overcast/`
store. Commands produce records into that store; later commands read those
records by id, by media reference, or through case memory.

The first-run pipeline:

```text
case setup → target/source → scan/monitor → capture → sense/note → ask/brief/view/index
```

`case setup` is the canonical way to stand up a new investigation. It saves the
mutable current setup under `.overcast/setup.json`, emits immutable operational
`case` history records for each apply/edit, and can immediately create/attach
remote indexes and queue selected local media for indexing. The older primitives
(`case init`, `target add`, `source add`, `index create/add`) still work
directly.

Provider configuration has **two levels**:

- **Profile / global setup** is reusable across cases and lives under
  `~/.overcast/profiles`. Use `provider setup plan|apply`, `setup provider`,
  `provider init`, and `doctor` for machine/profile readiness.
- **Case provider policy** lives in `.overcast/setup.json` and records which
  provider choices a case expects, which provider outputs are eligible for local
  memory/indexing, which senses run automatically on newly captured media,
  whether new media is auto-indexed, and how findings auto-suggest — a persist
  hook fires on every verb and emits `suggested` leads from score triggers plus
  target text matches (default `suggest` mode), quarantined until accepted.

Runtime execution always follows the **active profile binding**. Case setup
stores choice/policy metadata and can clear a built-in such as `enhance:ffmpeg`,
but it never pins a stale exec descriptor after the profile is updated.

For non-interactive use, run the profile phase first, then point case setup at
those choices:

```bash
overcast provider setup apply --preset cloudglue --profile default --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json
overcast provider init listen --profile recon --json
overcast doctor --profile recon --json

overcast case setup edit \
  --provider "listen:elevenlabs,see:owl-local" \
  --provider-indexable "listen,see" \
  --auto-sense "watch,listen" \
  --auto-index-new \
  --findings suggest \
  --yes --json
```

Findings **auto-suggest** by default (`--findings suggest`): a persist hook on
every evidence verb emits `status:"suggested"` findings from score triggers
(face ≥75, image RANSAC ≥1 inlier, similar ≥85, cluster ≥70, audio fingerprint) and non-image
target text matches, quarantined until you `finding accept` them. Tune the floors
with `case setup --findings-threshold face=75,similar=85,cluster=70,image_inliers=1`;
`--findings review` is the legacy text-only mode and `off` disables it.

Provider classes:

- **tinycloud / Cloudglue** — default video, audio, face, and remote
  index-backed operations.
- **local ffmpeg** — deterministic media enhancement, audio denoise/normalize,
  frame extraction, detection-crop extraction, and viewer support.
- **opt-in model/media providers** for `see` / `listen` / `enhance` — Hugging
  Face, fal.ai, ElevenLabs, and local detector/Whisper examples.
- **visual DBs** — uv-managed OpenCV RANSAC image matching, DeepFace face
  matching, the `cluster` face DB, and CLIP semantic search, selected by the
  `image-ransac` / `deepface-local` / `face-cluster` / `basic-clip` index types.
- **source providers** — external discovery and URL fetching (youtube / tiktok /
  x / web / lens reverse-image / dl generic-yt-dlp / instagram / telegram /
  gdelttv broadcast-TV / webcam live-cams / facesearch opt-in reverse-face).
- **case memory** over primary evidence for `ask` / `brief` / `case memory` —
  `local-grep` by default, or qmd for lifecycle-managed semantic local search.

Only `exec` transport is wired for bound providers today; `http` and `inproc`
descriptors are accepted but return an explicit "not implemented" error when
invoked.

### Interactive / TUI notes

- Bare `/setup` mirrors `overcast setup show`; bare `/provider` mirrors
  `overcast provider list`; bare `/finding` mirrors `overcast finding list`.
- Bare slash show/list commands emit transient display results — they are not
  written back into `.overcast/records`.
- `case clear --yes` removes records/media/state/indexes plus known root
  artifacts (`brief.html`, `brief.md`) and best-effort drops configured qmd
  collections, then schedules a screen reset + banner replay. Preview-only
  `case clear` does not mutate anything.
- A clean case can run `brief`, but with zero evidence records the result is
  transient/pending and `--export` does not write a misleading empty artifact.
- The TUI/CLI loads `.env` from the active case directory unless
  `OVERCAST_NO_DOTENV=1`; secret-like values are redacted in rendered output.
- `scan --pull` and `monitor` share one per-hit processing model: resolve
  `media.ref` / `payload.url`, capture when needed, run an explicit `--pipe` or
  setup automation / default watch, then classify each hit as completed, pending,
  credential-blocked, or failed. Refless hits are explicit errors in both.
  `monitor` marks hard failures seen so loops don't reprocess them, while
  pending / credential gaps remain retryable.

## Case, memory & searchability reference

The quick answer to "where did this output go, and can `ask` find it later?"

### What goes into a case

The durable local store under `.overcast/records`, plus media/state/index files.

- **Primary evidence records:** `watch`, `listen`, `see`, `exif`, `verify`,
  `scan`, `capture`, `enhance`, `crop`, `note`, and root `finding`s.
- **Typed evidence/tool records:** `face` (detect/match/search/list) and `see`
  object-detection records.
- **Read/meta records:** `ask`, `brief`, `case`.
- **Operational/setup records:** `setup`, `doctor`, `provider`, `skills`,
  `index`, `target`, `source`, `prebrief`, `wall`, `grid`, and finding
  review-rows. (`grid`/`wall` are triage/viewing artifacts — not evidence.)
- **Media files:** captured/copied/enhanced media and crops under
  `.overcast/media`.
- **State files:** targets, sources, index mirrors, seen sets, and memory-index
  manifests/jobs under `.overcast/`.

Being in the case does **not** make a record searchable evidence.

### What becomes searchable

Case memory is **evidence-only**. The default backend is `local-grep`;
`case setup --memory qmd` (or `setup memory qmd` at the profile level) makes qmd
the configured semantic local backend. Both honor the same eligibility rules and
the saved setup's signal filter.

The saved setup memory signal list (`setup.memory.signals`) is the base
evidence-verb allowlist; per-provider `indexable: true` flags (set with
`--provider-indexable`) union in additional provider outputs. Defaults are
`note`, `watch`, `listen`, `see`, `scan`. These local-memory signals are separate
from remote-index default signals — restricting local signals never removes
`index add` from an index route.

Eligible fields when allowed by the signal filter:

| verb | indexed fields | not indexed |
|---|---|---|
| `watch` | content/timeline, transcript, title/summary, segment descriptions | — |
| `listen` | transcript, summary, language, segment text | — |
| `see` | captions/OCR/text/summary + compact detection counts/categories | raw `detections[]` |
| `face` | compact summary/op/moments/reference/index | raw `faces[]`, boxes, thumbnails |
| `crop` | summary, kind, class, detection id, source provenance, time, confidence, path | — |
| `note` | title, text, tags, confidence, ref | — |
| `scan` | title, snippet, url, source, published | — |
| `capture` | title, snippet, text, path, source, kind | — |
| `enhance` | summary, path, ops, op, kind, output, speaker/label, prompt, transcript, count, score | mask/track binaries, raw boxes, segment arrays |
| `finding` | root findings with `text` + `status` | review-rows, suggested, dismissed, list envelopes |

Excluded from memory and briefs: prior read/meta output (`ask`, `brief`,
`case`); setup/operational output (`setup`, `doctor`, `provider`, `skills`,
`index`, `target`, `source`, `prebrief`, `wall`, `grid`); finding review-rows,
finding-command errors, `finding list` envelopes, and `suggested` (excluded until
accepted) or dismissed root findings (still auditable in records/logs).

Raw detection payloads are intentionally not searchable. Use exact record reads
(`case memory get <id>`) or `crop <record-id>` for boxes/images.

### How to search

- **Default case question:** `ask "..."` → local-grep over eligible fields.
- **Semantic local question:** `ask "..." --deep` or `--memory qmd` after
  `setup memory qmd` (or `case setup --memory qmd`) and
  `case memory index rebuild --memory qmd`.
- **Local memory passages:** `case memory search "..."` returns snippets.
- **Briefs:** `brief` reports over the same evidence boundary — short by default
  (verdict → goal status → key findings → lines of investigation → triage →
  coverage → compact record trail); `--full` appends the verbatim per-record
  timeline.
- **Case status:** `case status` is a **mission board**: the goal headline, each
  target as a line of investigation on a stage ladder
  (cold→collecting→leads→corroborated→answered/dead-end), a coverage funnel,
  freshness, and the triage queue — with setup health, store counts, and match
  visualizations below.
- **Case records:** `case records` is the append-only audit log. It includes
  operational/read/meta records that are intentionally excluded from memory and
  briefs, so use it for trace, provenance, and debugging.
- **Remote media index:** `ask "..." --index <media-index>` (Q&A) or `--probe`
  (moment search).
- **Remote face search:** `face --match ./person.jpg --index <face-index>`.
- **Local visual search:** `image match ./clip.mp4 --index <image-ransac-index>`
  for logos/landmarks, or `face ./clip.mp4 --match ./person.jpg --index
  <deepface-local-index>` for local face matching.
- **Local face clustering (who recurs across media):** stand up a DB with `index
  create people --type face-cluster --local`, then `cluster add ./clip.mp4
  --index <id>` to ingest faces (each is assign-or-created into a person). Browse
  with `cluster list` / `cluster view` (HTML contact sheet), name a person with
  `cluster label <person-id> "Name"`, probe a photo with `cluster identify
  ./who.jpg`, and re-tidy groups as the DB grows with `cluster recluster` (human
  labels carry forward). Local + deepface-only — the tinycloud face path exposes
  no embeddings, so clustering rides on `face:deepface-local`.
- **Entity index reads:** `index entities <entity-index> <video>`.
- **Detection crops:** `crop <face-or-see-record-id> --all [--class person]`
  writes crop images and searchable crop records.

When you add a raw local video to a remote index (`index add ./video.mp4 --to
<id>`), overcast first creates missing `watch` evidence if the video hasn't been
watched — so local-grep can search it immediately (qmd on the next rebuild). It
does **not** create a `face` detect record just to populate memory; run `face` or
`see --detect` when you actually need detections, then `crop` for cropped images.

When multiple remote indexes are attached they stay explicit and typed; select by
intent (`ask --index` for media-descriptions, `face --match --index` for
face-analysis, `index entities` for entities). Plain `ask` still searches only
local case memory.

Local `image-ransac` and `deepface-local` indexes are also explicit and case-owned.
They do not upload media and do not change the tinycloud defaults; run
`scripts/visual-db-uv.sh --face` once per checkout/machine, then use
`overcast doctor` to confirm `uv` and `visual-db` are ready. DeepFace face
detection/matching is available as a profile choice (`face:deepface-local`), but the
local searchable DB remains a case-owned `deepface-local` index. Current case setup
should not be used to create visual DBs; create them explicitly with
`index create --type image-ransac --local` or `index create --type deepface-local
--local`. Local-grep/qmd ingest the visual match records and summaries, not
binary media, embeddings, frame samples, or visualization images.

In short: open `brief` when you want the evidence narrative, `case status` when
you want the live mission board (goal, target threads, coverage, triage), and
`case records` when you need the full history of what the system and user did.

Direct CLI HTML exports default to `plain` for compatibility. Agent/TUI tool
calls default `.html` exports to the `csi` visualization theme when the verb
supports themes, unless the call explicitly passes `--theme plain`.

## Recommended case lifecycles

### 1. Reusable provider setup, then case policy

Before starting cases on a new machine/profile, or when a provider choice should
be shared across cases.

```bash
overcast provider setup show  --profile recon --json
overcast provider setup plan  --preset cloudglue --profile recon --json
overcast provider setup apply --preset cloudglue --profile recon --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json
overcast provider setup apply --verb face --choice deepface-local --profile local --yes --json
overcast provider init listen --profile recon --json
overcast doctor --profile recon --json

overcast case setup edit \
  --provider "listen:elevenlabs,see:owl-local" \
  --provider-indexable "listen,see" \
  --auto-sense "watch,listen" \
  --auto-index-new \
  --findings suggest \
  --yes --json
```

1. Pick reusable profile/global providers with `provider setup plan|apply`.
2. Run init hooks + `doctor` to surface missing credentials or local deps.
3. Per case, record the expected provider choices with `case setup --provider`.
4. Mark which outputs are memory/index eligible (`--provider-indexable`).
5. Choose whether scans/monitors auto-sense and auto-index; findings auto-suggest
   on every evidence verb (`--findings suggest`, the default).

### 2. First-run case setup wizard

For a new case, especially when an agent drives setup interactively (ask one
question at a time: name → target/reference image → sources/local media → local
backend + signals → remote collections → providers/automation → notes →
preview/apply).

```bash
overcast case setup
overcast case setup plan --name "find-person" --target ./reference.webp \
  --folder ./videos --index "Faces:face-analysis,Scenes:media-descriptions" \
  --memory local-grep
overcast case setup \
  --name "find-person" \
  --target ./reference.webp \
  --folder ./videos \
  --index "Faces:face-analysis,Scenes:media-descriptions" \
  --memory local-grep \
  --provider "see:owl-local" \
  --provider-indexable "see" \
  --auto-sense "watch,see" \
  --findings suggest \
  --yes
overcast case setup status
overcast scan --local
```

Setup saves `.overcast/setup.json`, registers targets/sources, creates/attaches
remote indexes, expands selected folders into individual AV routes, and queues
routed videos (creating missing `watch` evidence). Image-extension targets are
registered as `kind: image`, so a face-analysis index can be searched by local
scan fallback. Pass `--no-index` to save routes without starting remote ingest.

### 3. Minimal local media analysis

When you already have a file.

```bash
overcast case init --name "demo"
overcast watch ./clip.mp4
overcast note "rear plate is missing" --ref <watch-record-id> --at 12-18 --tag vehicle
overcast ask "What happened in the clip?"
overcast view <watch-record-id>
overcast brief --export report.md        # short verdict-led brief; add --full for the verbatim timeline
```

### 4. Local visual DB: logos, faces, and semantic (CLIP) search

When you need a local, inspectable visual match DB instead of a remote index.

```bash
scripts/visual-db-uv.sh --face   # or --clip for CLIP, --all for both
overcast doctor --json
overcast provider setup apply --verb face --choice deepface-local --profile local --yes --json

overcast index create logos --type image-ransac --local --json
overcast index add ./starbucks-logo.jpg --to logos --json
overcast image match ./candidate.mp4 --index logos --fps 0.7 --draw --json

overcast index create localfaces --type deepface-local --local --json
overcast index add ./person.jpg --to localfaces --json
overcast face ./candidate.mp4 --match ./person.jpg --index localfaces \
  --fps 0.5 --max-frames 32 --min-similarity 20 --json

# CLIP semantic DB — query by text or image (image->image / text->image)
overcast index create scenes --type basic-clip --local --granularity frame --json
overcast similar add ./candidate.mp4 --index scenes --json
overcast similar search "a red car at night" --index scenes --json
overcast similar match ./reference.jpg --index scenes --json
```

Use `--draw` on `image match` to write RANSAC visualizations into the case media
store. Local face results include frame timestamps, similarity, and boxes. Use
`--fps` for video sampling cadence; add `--max-frames` when you need to cap
runtime. With `--profile local`, plain `face ./candidate.mp4` runs local
DeepFace detection through the `face:deepface-local` provider; `deepface-local` indexes are
only needed when you want a reusable/searchable local face DB. `basic-clip` is the
semantic option: `similar add` embeds + caches members (videos are frame-sampled and
pooled, or stored per-frame with `--granularity frame` so matches carry `at`), then
`similar match`/`similar search` rank by cosine similarity (0–100). Stand up a
frame-level and a video-level index side by side in the wizard (one comma-separated
`--index`; per-index config pairs use `;`):
`case setup --index "moments:basic-clip@granularity=frame,clips:basic-clip@granularity=video" --yes`.

### 4b. Local audio DB: fingerprint matching + CLAP similarity

The audio twins of `image` and `similar`: `audio` does Shazam-style **exact**
recording matching (Wang 2003 constellation hashes), and a `basic-clap` index gives
`similar` audio↔audio + text→audio **semantic** search.

```bash
scripts/visual-db-uv.sh --audio   # numpy/scipy fingerprint deps (add --clap for CLAP)
overcast doctor --json            # the `audio-db` check reports fingerprint + clap deps

# exact matching: which recording contains this clip, and WHERE
overcast index create jingles --type audio-fp --local --json
overcast audio add ./original.mp4 --to jingles --json          # fingerprint (videos → audio track)
overcast audio match ./suspect.mp4 --index jingles --json      # offset-aligned: "appears at 01:23"
overcast audio match ./suspect.mp4 --index jingles --min-margin 2 --draw --json  # reject sped re-uploads + plot the alignment
overcast audio match ./clipA.mp3 ./clipB.mp3 --json            # clip-to-clip, no index needed

# semantic similarity: audio->audio and text->audio (CLAP)
scripts/visual-db-uv.sh --clap    # ~776MB model, downloaded once on first use
overcast index create sounds --type basic-clap --local --json
overcast similar add ./scene.wav --index sounds --json         # embed + cache (10s audio windows)
overcast similar match ./query.wav --index sounds --json       # audio -> audio
overcast similar search "crowd chanting" --index sounds --json # text -> audio moments
```

`audio match` reports, per member, the aligned-vote count, the time `offset_seconds`
where the query lines up inside the recording, a `match_ratio`, and a `margin` over
the next-best alignment; `--min-votes` (default 6) is the confidence floor. It is
robust to transcode, noise, and clipping but **not** to pitch/speed change (classic
Wang). A slightly sped-up re-upload can still clear the raw vote floor as a weak
partial alignment (margin ~1.2–1.7× vs a true match's 250–1600×) — pass
`--min-margin 2` for exact-copy detection to reject those (a matching-oriented
`--speed-sweep` is planned separately). A silent/tonal clip fingerprints to 0 hashes
and `audio add` flags it with a `payload.warning`. `--draw` renders an SVG alignment
plot per match (hash-pair scatter + offset histogram, the Shazam analog of `image
--draw`) into the case media store; the `brief`/`case status` HTML embeds it — a true
match shows a tight aligned band + one sharp spike, a rejected copy a short scattered
cluster.
`basic-clap` reuses the `similar` grammar and the `basic-clip` cache layout; audio is
chunked into `--window`-second slices (default 10s), pooled to a track vector, or
stored per-window as moments with `--granularity frame`. The first CLAP call
downloads the model to the HF cache; pre-warm it, then set `HF_HUB_OFFLINE=1` for
fully offline runs. `--clip` and `--clap` share one torch in the venv — install both
together via `scripts/visual-db-uv.sh --all` when you want the whole visual+audio
stack (see [providers.md](providers.md)).

### 5. Local-media-only person search

Candidate videos on disk + a reference image, no external sources.

```bash
overcast case setup --name "find-person" --target ./person.jpg \
  --folder ./candidate-videos \
  --index "Faces:face-analysis,Scenes:media-descriptions" \
  --memory local-grep --yes
overcast scan --local
overcast face --match ./person.jpg --index Faces
overcast ask --index Scenes --probe "Where is the target and what is happening?"
overcast ask "What local findings mention the target?"
```

`scan --local` works with zero registered sources; with an image target plus a
face-analysis, image-ransac, or deepface-local index it runs matching directly.
For local visual DBs, the image target is the reference and the case media are
the candidates being searched. Use `--limit` to cap local visual DB fan-out
(default 5).

### 6. One-shot OSINT pull

Sources registered, immediate acquisition + analysis.

```bash
overcast case setup \
  --name "acme-watch" \
  --target "Acme Corp" \
  --source youtube:@acme \
  --provider "listen:elevenlabs" \
  --provider-indexable "listen" \
  --auto-sense "watch,listen" \
  --findings suggest \
  --yes
overcast scan --limit 5 --pull
overcast finding list --state triage --json      # open + suggested leads
overcast finding accept <finding-id>             # promote a lead to evidence (or: finding dismiss)
overcast ask "What new claims or events appear?"
overcast brief --export acme-watch.md            # short verdict-led brief; --full for the timeline
```

Each pulled AV hit is captured, then run through the setup automation chain
(`watch,listen`) unless an explicit `--pipe` overrides it. An explicit `--pipe`
on a single run always wins over setup automation.

> Cost note: for broad discovery, prefer `scan --limit N` first, review the hits,
> then capture/sense only likely candidates rather than `scan --pull --pipe
> watch` over everything.

### 7. Continuous monitoring

```bash
overcast case setup \
  --name "acme-monitor" \
  --target "Acme Corp" \
  --source youtube:@acme \
  --auto-sense "watch" \
  --auto-index-new \
  --findings suggest \
  --yes
overcast monitor --every 15m --limit 5 --brief --alert .overcast/alerts.jsonl
overcast finding list --state triage --json      # open + suggested leads → finding accept/dismiss
```

Run `monitor --every` under tmux/a scheduler. New hits are captured + sensed;
seen items land in `.overcast/seen.json`; transient setup gaps retry while hard
failures don't loop forever; automated findings are de-duplicated per source
media/target. Turn automation off later without editing JSON:

```bash
overcast case setup edit --auto-sense "" --no-auto-index-new --yes --json
```

### 8. Audio-first monitoring

```bash
overcast source add youtube:@channel
overcast monitor --once --pipe listen --describe --limit 10
overcast note "speaker sounds different after the cut" --ref <listen-record-id> --at 00:01:14 --tag audio,identity
overcast ask --verb listen "What was said and what background audio was present?"
```

### 9. Default case search

The normal CLI path — ask a question against everything already saved.

```bash
overcast watch ./clip.mp4
overcast note "white van stops near the loading dock" --ref <watch-record-id> --at 12-18 --tag vehicle
overcast case memory list
overcast case memory index status
overcast ask "What observations mention the loading dock?"
```

`local-grep` searches indexable fields and returns cited records — no index
setup required.

### 10. qmd case memory

Materialized local semantic memory instead of grep-style matching.

```bash
overcast case setup --memory qmd --yes        # or: setup memory qmd (profile-level)
overcast case memory index rebuild --memory qmd
overcast case memory index status --memory qmd
overcast ask --deep "Which clips mention a white van near a dock?"
overcast ask --memory qmd "Which clips mention a white van near a dock?"
```

Rebuild first clears the named qmd collection, then re-adds + embeds the current
evidence docs (idempotent). qmd queries do **not** auto-rebuild a missing/stale
index — rebuild/start/retry first. Default embedding model
`embeddinggemma-300M-Q8_0`; install with `npm install -g @tobilu/qmd`.

### 11. Remote index-backed search over videos

Portable, cross-video indexed search when local records aren't enough.

```bash
overcast index create "case-videos" --type media
overcast index attach "existing-case-videos"   # mirror an existing remote index
overcast index add --all --to "case-videos"     # register ready captured/sensed AV
overcast ask --index "case-videos" "Where is the product demo discussed?"
overcast ask --index "case-videos" --probe "product demo"
```

### 12. Face search lifecycle

```bash
overcast index create "faces" --type face
overcast index attach "existing-faces" --type face
overcast index add --all --to "faces"
overcast face --match ./person.jpg --index "faces"
```

Adding a raw local video creates missing `watch` evidence for local search but
does **not** create a `face` detect record. Search with a JPEG/PNG reference.

### 13. Enhance then analyze

```bash
overcast enhance ./noisy.mp4 --ops denoise,normalize
overcast watch <enhance-output-path>
overcast ask "What is visible or said after enhancement?"
```

### 13b. Split ops — separate voices / segment objects

Bind a split provider once (on-device or fal), then `enhance --ops separate|segment`
fans out one evidence record per track / masked instance.

```bash
scripts/visual-db-uv.sh --enhance                       # on-device stacks (or use --preset fal)
overcast setup provider enhance "exec:bash examples/providers/local/enhance.sh {{input}}"

overcast enhance ./interview.mp4 --ops separate --summarize   # per-speaker tracks, each transcribed
overcast view <separate-parent-id>                             # gallery: audition each track + spectrograms + cross-talk
overcast ask "Summarize what each separated speaker said"

overcast enhance ./scene.jpg --ops segment --prompt "the red car"   # mask + RGBA cutout per instance
overcast view <segment-parent-id>                              # gallery: every cutout/mask in one page
overcast crop <segment-parent-id> --all                        # same boxes as durable crops
```

Each separated track is a first-class audio evidence record (a `.wav` under
`.overcast/media/separate/`), so it chains into the audio senses — fingerprint-match
an isolated voice against a reference recording, or embed it for CLAP search — to
identify or compare a single speaker pulled out of a mix:

```bash
overcast audio match <track-record-id> ./known-speaker.wav       # exact-recording fingerprint match (clip-to-clip)
overcast similar add <track-record-id> --to voices               # embed the isolated voice into a CLAP index
overcast similar search "calm female narrator" --index voices    # then CLAP-search across the separated voices
```

### 14. Detection crop evidence

Turn face/object boxes into durable, citable, searchable images.

```bash
overcast face ./clip.mp4 --thumbnails
overcast crop <face-record-id> --all --class face --square --pad 0.1

overcast setup provider see "exec:python3 examples/providers/detect/detect.py"
overcast see ./clip.mp4 --detect "person, car, license plate"
overcast crop <see-record-id> --all --class person
overcast ask "Which cropped people or vehicles do we have?"
```

Run `face --thumbnails` before `crop` to preserve provider frame images as crop
sources. Each crop record cites back to source record/media/crop-source/time/
class/id/box. `crop` is separate from `enhance` (whole-media transform).

### 15. Frame-level visual inspection

```bash
overcast watch ./clip.mp4
overcast see frame://<watch-record-id>@42 --prompt "Describe signage and visible objects"
overcast ask "What signage appears around 42 seconds?"
```

### 15b. Temporal localization — *when* did X happen (coarse → fine)

Triage the whole clip in one vision call, then verify the exact moment at the
frame. Every timestamp traces back to a frame the model actually looked at — a
low-res tile invites a plausible-but-wrong read, so the frame check decides.

```bash
overcast watch ./clip.mp4                                   # -> record REC (media on disk)
overcast grid ./clip.mp4 --count 16 --json                  # one contact sheet; payload.cells maps cell -> timestamp
overcast see <montage-path> --prompt "which numbered cells show X? give cell numbers"
# map the chosen cell number through payload.cells[n].at (never a time the model typed)
overcast see frame://REC@<that-second> --prompt "is X happening here?"   # verify at full resolution
overcast grid ./clip.mp4 --start <a> --end <b> --json       # re-grid tighter to zoom in
overcast note "X occurs" --ref REC --at <t1-t2> --confidence medium
```

`grid` is a triage artifact (operational — excluded from case memory), not
evidence; cite the verified `see` frame, and report a window, not a false-precise
frame. `overcast grid ./clip.mp4 --view` opens a clickable HTML board (numbered,
timestamped cells that seek the clip) for eyeballing the same sheet by hand. The
`overcast-pinpoint`, `overcast-frame-grid`, `overcast-event-bisect`,
`overcast-where`, and `overcast-presence-window` skills wrap these loops.

### 16. Human observation / analyst flagging

```bash
overcast watch ./clip.mp4
overcast note "Analyst observation: rear plate is missing" --ref <watch-record-id> --at 12-18 --tag vehicle,plate --confidence high
overcast finding create "Suspect vehicle has no rear plate" --ref <watch-record-id> --at 12-18 --target "white van" --confidence high
overcast ask "What observations mention license plates?"
overcast brief --scope verb:note --export analyst-notes.md
```

Use `note` for observations; use `finding create` to pin confirmed evidence.
Findings also **auto-suggest**: matching verbs (`face --match`, `image match`,
`similar match`, `cluster identify`, or a sense verb hitting a target) emit
`status:"suggested"` leads. Triage them with `finding list --state triage`
(open + suggested), then `finding accept` (→ evidence) or `finding dismiss` (a
dismissed suggestion never re-fires for the same match). Both `suggested` and
dismissed findings stay auditable but drop out of memory/briefs.

### 17. Control-room wall

Ambient monitoring: every case video on one silent wall, muted and looping its
best evidence moment (open finding > face hit > record anchor), with sense
coverage badges and scan/monitor/brief freshness overlaid. Click a tile to open
the media at its anchor; hover for the intel card.

```bash
overcast wall                                # wall the case (opens the browser)
overcast wall --theme csi --limit 16         # bigger neon wall
overcast wall --source youtube --since 24h   # only fresh youtube pulls
overcast wall --refresh 60 --no-open         # re-snapshot while monitor runs
overcast wall --infinite                     # endless wall: feeds repeat to fill the screen
```

The wall references local media by `file://` URL (nothing is embedded), so it
plays whatever is still on disk; missing or browser-hostile containers render
NO SIGNAL / STILL tiles (with an ffmpeg poster frame when extractable).
`--infinite` turns a small case into a full monitor bank: the real feeds repeat
to cover the viewport and the grid keeps extending as it scrolls (rows that
scroll far out of view are recycled, so it stays cheap forever).

### 18. Copycat sweep (x + lens reverse-image)

Find re-uploads of an original clip across X and Google Lens, confirm with the
geometry-gated `image` layer, and keep a standing watch. The packaged version of
this funnel is the `overcast-copycat-sweep` skill.

```bash
overcast index create originals --type image-ransac --local --json
overcast image add ./title-card.png --index <index-id> --json   # fingerprint distinctive frames
overcast source add "x:video:<topic keywords>" --json
overcast source add lens:./original-frame.png --json          # reverse image search
overcast scan --since 7d --limit 10 --json                    # triage first: Apify bills per result
overcast capture <scan-hit-id> --json
overcast image match <capture-id> --index <index-id> --draw --json   # a RANSAC hit auto-suggests a lead
overcast finding list --state triage --json                          # the copycat lead is already suggested
overcast finding accept <finding-id> --json                          # accept it (or hand-author: finding create --ref <image-match-id>; dedup drops the dup)
overcast brief --export copycats.html                               # short verdict-led brief; --full for the frame dump
overcast monitor --every 1d --json
```

`x:` refs target X/Twitter: `x:@handle` (author), `x:<advanced query>`, and the
media-targeted `x:video:<q>` / `x:image:<q>`. `lens:<image url|path>` runs a
Google Lens reverse image search via Apify. `image match` gates on
planar-projection (homography) validity — read the inlier count + ratio and
eyeball the `--draw` overlay before calling a rip; keyword overlap alone is not
a match.

### 19. Triage auto-suggested leads / analyst debrief

Findings auto-suggest as you work — turn the queue of leads into resolved lines
of investigation, then a verdict-led brief.

```bash
overcast face ./clip.mp4 --match ./suspect.jpg --json   # a ≥75 match auto-suggests a lead
overcast finding list --state triage --json             # open + suggested leads awaiting review
overcast finding accept <finding-id> --json             # promote a lead to evidence…
overcast finding dismiss <other-id> --json              # …or block it (never re-suggested for that match)
overcast target close <target-id> --as answered --note "confirmed: suspect appears at 00:14" --json
overcast case status --json                             # mission board: threads on the stage ladder + triage
overcast brief --export debrief.html                    # short verdict-led brief; --full for the timeline
```

Targets are **lines of investigation**: `target add --question` frames one,
`target close <id> --as answered|dead-end --note` resolves it (closed lines stop
seeding scans), and `target reopen` revives it. The `/debrief` prompt automates
this whole loop — triage leads, write `thread:<tgt_id>` narrative notes, close
resolved lines, refresh the `tldr` note, and `brief --export`.

### 20. New OSINT sources: broadcast, social, live cams, reverse-image

Broadcast TV, more social platforms, live webcams, and reverse-image lookups —
same `scan` / `capture` / `monitor` verbs, one loose record shape. All discover
via `enumerate`; add `--pull` to capture + sense each hit.

```bash
overcast scan --source gdelttv --query "climate summit" --since 14d       # GDELT TV → bounded Internet-Archive clips (no key)
overcast scan --source instagram --query @nasa --since 7d --pull           # Instagram posts/reels (Apify)
overcast scan --source telegram --query durov --since 30d                  # public Telegram channel (Apify)
overcast monitor --source webcam --query "48.8584,2.2945,25" --every 30m   # live Paris cams, re-captures each pass
overcast capture "https://rumble.com/v123.html" --source dl                # any yt-dlp host, capture-only
overcast scan --source facesearch --query ./person.jpg --pull              # opt-in reverse FACE search (ToS-gated)
```

`webcam` hits carry `recapture: true` so `monitor` re-captures the CURRENT still
each pass without bloating the seen-set (a permanently broken cam is given up
after repeated failures). An unparseable `--since` fails closed on the
recency-aware sources rather than silently widening the window. `facesearch` is
never a default — you must bind it explicitly.

### 21. Media forensics: metadata, GPS & provenance

Establish where a file came from and whether it carries signed credentials —
evidence records like any other sense, cited by `ask` / `brief`.

```bash
overcast exif ./photo.jpg --json      # ExifTool: GPS lat/lng, capture time, device, editing software
overcast verify ./clip.mp4 --json     # C2PA / Content Credentials: manifest, signer, validation state
overcast exif <capture-record-id>     # or run over a captured scan hit (remote media is fetched first)
overcast ask "what GPS coordinates or camera devices appear?"
```

`exif` needs `exiftool`, `verify` needs `c2patool` (both report
`needs_credentials`, exit 13, when absent). Media with no credentials is a clean
`ready` `verify` record (`has_manifest: false`), not an error — and distinct from
source-post provenance (where a record was scraped from).

## Command matrix

| Command | Group | Main output | Default backing | Override | Role |
|---|---|---|---|---|---|
| `watch` | sense | `video.analysis` | tinycloud | `setup provider watch "exec:…"` | Video understanding |
| `listen` | sense | `audio.analysis` | tinycloud | `setup provider listen "exec:…"` | Speech/audio analysis |
| `see` | sense | `image.analysis` | brain LLM (image-capable) → HF captioner if token → placeholder | `setup provider see "exec:…"` / `builtin:hf` | Image/frame understanding |
| `face` | sense | `face.analysis` | tinycloud | custom exec / pinned tinycloud | Face detect/match/index search |
| `image` | sense | `image.match` | local OpenCV RANSAC (`image-ransac` index) | `OC_VISUAL_DB_PY` | Image/frame geometric matching |
| `cluster` | sense | `cluster` | local DeepFace (`face-cluster` index) | `OC_VISUAL_DB_PY` | Persistent local face DB |
| `similar` | sense | `similar.match` | local CLIP (`basic-clip`) / CLAP (`basic-clap`) | `OC_VISUAL_DB_PY` | Cross-modal semantic search |
| `audio` | sense | `audio.match` | local fingerprint (`audio-fp` index) | `OC_VISUAL_DB_PY` | Shazam-style exact audio matching |
| `enhance` | sense | `media.enhanced` | local ffmpeg | `setup provider enhance "exec:…"` | Improve / split media |
| `exif` | sense | `media.metadata` | ExifTool (shipped) | `setup provider exif "exec:…"` | Embedded metadata + GPS |
| `verify` | sense | `media.provenance` | c2patool (shipped) | `setup provider verify "exec:…"` | C2PA / Content Credentials |
| `view` | inspect | `view` | local HTML viewer / OS open | none | Inspect media/anchors |
| `crop` | inspect | `media.crop` | local ffmpeg | none | Materialize detection crops |
| `wall` | inspect | `wall` | local HTML wall (file:// refs) | none | Control-room monitor wall |
| `scan` | osint | `scan.hit` / local summary | source providers; local fallback | `OVERCAST_SOURCE_*_CMD` | Discovery / local scan |
| `capture` | osint | `capture` | local copy/stdin or source fetch | source provider | Acquire media/content |
| `monitor` | osint | `scan.hit` + capture/sense | scan/capture/sense chain | source + sense overrides | Repeated discovery w/ dedupe |
| `index` | osint | `index` | tinycloud library collections | pinned tinycloud | Remote typed indexes |
| `target` | state | `target` | local state | none | Line of investigation (`add --question` / `close --as answered\|dead-end` / `reopen`) |
| `source` | state | `source` | local state | source provider types | Where to look |
| `note` | state | `note` | local human record | none | Human observations |
| `finding` | state | `finding` | local record / setup automation | none | Findings lifecycle: `create\|list\|accept\|dismiss`, `--state triage` (open + suggested) |
| `prebrief` | config | `prebrief` | local state | none | Case kickoff |
| `ask` | read | `answer` | local-grep | qmd or `--index` (tinycloud) | Query memory / remote index |
| `brief` | read | `brief` | local records | none | Case report — short by default (verdict/threads/triage/coverage), `--full` for the timeline |
| `case` | state | `case` | local store/memory/setup | none | Inspect/manage case + setup |
| `setup` | config | `setup` | profile files | none | Bind providers/LLM/memory |
| `provider` | config | `provider` | provider hooks / catalog | profile descriptors | Provider setup/init/list |
| `doctor` | config | `doctor` | local probes + tinycloud `--version` | env/path | Readiness check |
| `skills` | config | `skills` | local package files | none | Generate/install skills |

## Provider override patterns

### Bind a custom sense provider

```bash
overcast setup provider listen "exec:python3 examples/providers/python/listen.py"
overcast provider init listen
overcast listen ./clip.mp4
```

Custom exec providers print one overcast record JSON object to stdout (see
[`providers.md`](providers.md) for the exec wire contract).

### Choose providers from the catalog

```bash
overcast provider setup plan  --preset fal --profile recon --json
overcast provider setup apply --preset fal --profile recon --yes --json
overcast provider setup apply --verb listen --choice elevenlabs --profile recon --yes --json
overcast provider init listen --profile recon --json
overcast doctor --profile recon --json
```

Presets: `cloudglue` · `hf` · `fal` · `elevenlabs` · `owl-local` · `deepface-local` ·
`basic-clip`. Single choices use `--verb <watch|listen|see|face|enhance> --choice <id>`.

### Pin tinycloud

```bash
export OVERCAST_TINYCLOUD_CMD="/opt/tinycloud/bin/tinycloud"
overcast doctor
```

### Override a source provider

```bash
export OVERCAST_SOURCE_YOUTUBE_CMD="bash ./my-youtube-provider.sh"
overcast scan --source youtube
```

The command is invoked as `<base> enumerate --query … --limit … --since …` and
`<base> fetch --url … --out …`.

## Implementation boundaries

- `exec` provider transport is implemented; `http` and `inproc` are stored but
  not executed.
- Provider setup has profile/global and per-case layers; the active profile
  binding is the runtime source of truth.
- `case setup edit --auto-sense "" --yes` clears the auto-sense chain;
  `--no-auto-index-new` disables auto-indexing without clearing the rest.
- `case setup edit --provider …` preserves existing indexability unless
  `--provider-indexable` is supplied in the same edit.
- A local case-search backend is always configured (`local-grep` default; qmd
  optional and must be rebuilt before semantic queries).
- `scan` is stateless except for the records it writes; `monitor` owns
  seen-set retry/dedupe.
- Indexes are remote tinycloud/Cloudglue objects with a local case mirror.
- Case records are the central integration point: most commands write records,
  resolve record ids, or read records. `note` is the first-class path for human
  observations and uses the same loose record contract as provider output.
