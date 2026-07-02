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
  whether new media is auto-indexed, and whether automated target matches become
  reviewable findings.

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
  --findings review \
  --yes --json
```

Provider classes:

- **tinycloud / Cloudglue** — default video, audio, face, and remote
  index-backed operations.
- **local ffmpeg** — deterministic media enhancement, audio denoise/normalize,
  frame extraction, detection-crop extraction, and viewer support.
- **opt-in model/media providers** for `see` / `listen` / `enhance` — Hugging
  Face, fal.ai, ElevenLabs, and local detector/Whisper examples.
- **visual DBs** — uv-managed OpenCV RANSAC image matching and DeepFace
  face matching, selected by `image-ransac` / `deepface-local` index types.
- **source providers** — external discovery and URL fetching (youtube / tiktok /
  web).
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

- **Primary evidence records:** `watch`, `listen`, `see`, `scan`, `capture`,
  `enhance`, `crop`, `note`, and root `finding`s.
- **Typed evidence/tool records:** `face` (detect/match/search/list) and `see`
  object-detection records.
- **Read/meta records:** `ask`, `brief`, `case`.
- **Operational/setup records:** `setup`, `doctor`, `provider`, `skills`,
  `index`, `target`, `source`, `prebrief`, and finding review-rows.
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
| `enhance` | summary, path, ops, output | — |
| `finding` | root findings with `text` + `status` | review-rows, dismissed, list envelopes |

Excluded from memory and briefs: prior read/meta output (`ask`, `brief`,
`case`); setup/operational output (`setup`, `doctor`, `provider`, `skills`,
`index`, `target`, `source`, `prebrief`); finding review-rows, finding-command
errors, `finding list` envelopes, and dismissed root findings (still auditable in
records/logs).

Raw detection payloads are intentionally not searchable. Use exact record reads
(`case memory get <id>`) or `crop <record-id>` for boxes/images.

### How to search

- **Default case question:** `ask "..."` → local-grep over eligible fields.
- **Semantic local question:** `ask "..." --deep` or `--memory qmd` after
  `setup memory qmd` (or `case setup --memory qmd`) and
  `case memory index rebuild --memory qmd`.
- **Local memory passages:** `case memory search "..."` returns snippets.
- **Briefs:** `brief` reports over the same evidence boundary.
- **Case status:** `case status` is a current-state dashboard: setup health,
  targets, sources, indexes, memory/index state, store counts, artifacts, and
  match visualizations when available.
- **Case records:** `case records` is the append-only audit log. It includes
  operational/read/meta records that are intentionally excluded from memory and
  briefs, so use it for trace, provenance, and debugging.
- **Remote media index:** `ask "..." --index <media-index>` (Q&A) or `--probe`
  (moment search).
- **Remote face search:** `face --match ./person.jpg --index <face-index>`.
- **Local visual search:** `image match ./clip.mp4 --index <image-ransac-index>`
  for logos/landmarks, or `face ./clip.mp4 --match ./person.jpg --index
  <deepface-local-index>` for local face matching.
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
you want the live case dashboard, and `case records` when you need the full
history of what the system and user did.

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
  --findings review \
  --yes --json
```

1. Pick reusable profile/global providers with `provider setup plan|apply`.
2. Run init hooks + `doctor` to surface missing credentials or local deps.
3. Per case, record the expected provider choices with `case setup --provider`.
4. Mark which outputs are memory/index eligible (`--provider-indexable`).
5. Choose whether scans/monitors auto-sense, auto-index, and create findings.

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
  --findings review \
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
overcast brief --export report.md
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
  --findings review \
  --yes
overcast scan --limit 5 --pull
overcast finding list --json
overcast ask "What new claims or events appear?"
overcast brief --export acme-watch.md
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
  --findings review \
  --yes
overcast monitor --every 15m --limit 5 --brief --alert .overcast/alerts.jsonl
overcast finding list --json
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

### 16. Human observation / analyst flagging

```bash
overcast watch ./clip.mp4
overcast note "Analyst observation: rear plate is missing" --ref <watch-record-id> --at 12-18 --tag vehicle,plate --confidence high
overcast finding create "Suspect vehicle has no rear plate" --ref <watch-record-id> --at 12-18 --target "white van" --confidence high
overcast ask "What observations mention license plates?"
overcast brief --scope verb:note --export analyst-notes.md
```

Use `note` for observations; use `finding create` to pin confirmed evidence
(`finding accept`/`dismiss` append review rows; dismissed findings stay auditable
but drop out of memory/briefs).

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
```

The wall references local media by `file://` URL (nothing is embedded), so it
plays whatever is still on disk; missing or browser-hostile containers render
NO SIGNAL / STILL tiles (with an ffmpeg poster frame when extractable).

## Command matrix

| Command | Group | Main output | Default backing | Override | Role |
|---|---|---|---|---|---|
| `watch` | sense | `video.analysis` | tinycloud | `setup provider watch "exec:…"` | Video understanding |
| `listen` | sense | `audio.analysis` | tinycloud | `setup provider listen "exec:…"` | Speech/audio analysis |
| `see` | sense | `image.analysis` | HF captioner if token, else placeholder | `setup provider see "exec:…"` | Image/frame understanding |
| `face` | sense | `face.analysis` | tinycloud | custom exec / pinned tinycloud | Face detect/match/index search |
| `enhance` | sense | `media.enhanced` | local ffmpeg | `setup provider enhance "exec:…"` | Improve media |
| `view` | inspect | `view` | local HTML viewer / OS open | none | Inspect media/anchors |
| `crop` | inspect | `media.crop` | local ffmpeg | none | Materialize detection crops |
| `wall` | inspect | `wall` | local HTML wall (file:// refs) | none | Control-room monitor wall |
| `scan` | osint | `scan.hit` / local summary | source providers; local fallback | `OVERCAST_SOURCE_*_CMD` | Discovery / local scan |
| `capture` | osint | `capture` | local copy/stdin or source fetch | source provider | Acquire media/content |
| `monitor` | osint | `scan.hit` + capture/sense | scan/capture/sense chain | source + sense overrides | Repeated discovery w/ dedupe |
| `index` | osint | `index` | tinycloud library collections | pinned tinycloud | Remote typed indexes |
| `target` | state | `target` | local state | none | Standing scope |
| `source` | state | `source` | local state | source provider types | Where to look |
| `note` | state | `note` | local human record | none | Human observations |
| `finding` | state | `finding` | local record / setup automation | none | Findings + review |
| `prebrief` | config | `prebrief` | local state | none | Case kickoff |
| `ask` | read | `answer` | local-grep | qmd or `--index` (tinycloud) | Query memory / remote index |
| `brief` | read | `brief` | local records | none | Case report |
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

Presets: `cloudglue` · `hf` · `fal` · `elevenlabs` · `owl-local` · `deepface-local`. Single
choices use `--verb <watch|listen|see|face|enhance> --choice <id>`.

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
