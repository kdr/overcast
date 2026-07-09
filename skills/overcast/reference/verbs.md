# overcast — verb reference

Generated from the verb registry (`overcast commands --json`). Drive any verb
from a shell via `overcast <verb> [args] --json` and parse the emitted record.
Every verb emits one or more loose records persisted to the case's `.overcast/`
store; cite findings by `record.id` + `media.at`.

## Senses

### `overcast watch`

Runs the bound sense provider (default: tinycloud, exec) over a video file or URL and emits a video.analysis record with markdown content, a transcript (when speech is present), and the full structured describe in `detailed`.

```
overcast watch <input> [options]

  Analyze a video into a reusable, time-anchored record (content/transcript/detailed).

Arguments:
  input            Video file path or URL

Options:
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `video.analysis` records.

### `overcast listen`

Default provider: tinycloud. Speech-only transcript by default; --describe runs the full multimodal describe to surface the AUDIO-SCENE description (sounds, music, events, ambience), not just speech. Emits transcript, speaker-tagged segments[] with media.at anchors, language.

```
overcast listen <input> [options]

  Transcribe and analyze audio (or a video's audio track) into an audio.analysis record.

Arguments:
  input            Audio/video file path or URL

Options:
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
  --describe             Audio-scene description (full describe), not just speech
  --diarize              Attribute speech to distinct speakers
  --lang <string>        Hint/force source language (e.g. en, es)
```

Emits `audio.analysis` records.

### `overcast see`

Defaults to the BRAIN LLM when it supports images: a direct 'describe this image in detail' call (turnkey with the Cloudglue brain, or any image-capable `setup llm`). Falls back to a Hugging Face captioner when HF_TOKEN is set (override with HF_SEE_MODEL), else a placeholder until a VLM is bound. Switch backends via `setup provider see builtin:hf` (classic HF) or `builtin:brain`; disable the brain default with OVERCAST_SEE_BRAIN=off. Forwards --ocr/--prompt; --detect needs a detection provider (OWLv2 for boxes, or the opt-in Cloudglue tinycloud see/extract provider for boxless facts, tinycloud >= 0.3.7). Accepts frame://rec@sec (resolved via the internal ffmpeg toolkit) and http(s) image URLs, fetched into the case media dir first (meta.source_url keeps the origin).

```
overcast see <input> [options]

  Understand an image or a single video frame (caption, OCR, detections).

Arguments:
  input            Image path, http(s) image URL, video frame, or frame://rec@sec

Options:
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
  --ocr                  Extract on-image text
  --detect <string>      Comma list of target objects to locate (bind the detect provider for bounding boxes)
  --prompt <string>      Focus the description
```

Emits `image.analysis` records.

### `overcast face`

Default provider: tinycloud. `face <video>` detects faces — one box per sampled frame, so the count is detections, NOT unique people (detect doesn't cluster). To find or count a PERSON, use `face <video> --match ref.jpg` (locates that person in the clip, ranked by similarity), or `face --match ref.jpg --index <id>` to search a registered face-analysis index (case-wide); `face <video> --index <id>` lists that video's stored detections. The video/reference may be a path, URL, or a case record id; the reference image for --match must be JPEG/PNG. Emits a face.analysis record whose `summary` is the headline, plus faces[] (at, box, similarity, thumbnail?) and the full provider data in `detailed`.

```
overcast face [input] [options]

  Detect, match, or search faces in video (and across face-analysis indexes).

Arguments:
  input            Video to analyze (path/URL/record-id); omit with --match + --index to search the index

Options:
  --match <string>       Reference face image to find (JPEG/PNG path/URL/record-id)
  --index <string>       Face-analysis index id/name to search or list within (comma-list ok; default: the case's face index)
  --max-faces <number>   match: cap returned matches (1–4000)
  --min-similarity <number> match/search: similarity floor (0–100)
  --thumbnails           detect/match: include per-face thumbnail URLs
  --fps <number>         detect/match: sampling frames per second; local face accepts --max-frames as a cap
  --max-frames <number>  local face: video frame sample count/cap
  --start <string>       detect/match: window start (SS or timecode)
  --end <string>         detect/match: window end (SS or timecode)
  --limit <number>       detect/list/search: max results (match uses --max-faces)
  --offset <number>      list/search: result offset
  --group-by <string>    search: group results by file
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `face.analysis` records.

### `overcast image`

`image add <image|record-id> --index <local-image-index>` stores a reference image in a local image-ransac index. `image match <image|video|record-id> --index <local-image-index>` searches that DB using OpenCV SIFT/ORB + RANSAC.

```
overcast image <action> [input] [options]

  Match images or video frames against a local RANSAC image index.

Arguments:
  action           add | match
  input            image/video path, URL, or record id

Options:
  --index <string>       local image-ransac index id/name
  --to <string>          alias for --index when adding
  --min-inliers <number> minimum RANSAC inliers
  --min-ratio <number>   minimum inlier ratio
  --ratio-test <number>  Lowe ratio-test threshold
  --fps <number>         video frame sampling rate; --max-frames can cap it
  --max-frames <number>  video frame sample count/cap
  --draw                 write match visualization images
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `image.match` records.

### `overcast audio`

`audio add <audio|video|record-id> --index <local-audio-fp-index>` fingerprints a recording (Wang 2003 constellation hashes) and caches it in a local audio-fp index. `audio match <query> --index <id>` finds which indexed recording contains the query and WHERE (offset-histogram alignment: 'query audio appears at 01:23 in recording Y'). `audio match <query> <reference>` compares two clips directly, no index needed. Videos are accepted — their audio track is extracted. Robust to transcode/noise/clipping; NOT robust to pitch/speed change.

```
overcast audio <action> [input] [reference] [options]

  Shazam-style exact audio matching: fingerprint clips into a local audio-fp index, or match clip-to-clip with time-offset alignment.

Arguments:
  action           add | match
  input            audio/video path, URL, or record id (the query for match)
  reference        match: a second clip for direct clip-to-clip comparison (instead of --index)

Options:
  --index <string>       local audio-fp index id/name
  --to <string>          alias for --index when adding
  --min-votes <number>   minimum time-aligned hash votes to confirm a match (default: 6)
  --min-ratio <number>   minimum aligned-votes / query-hashes ratio (0–1)
  --min-margin <number>  minimum ratio of best-offset votes over the next-best offset (≥1); a true exact match scores 100s–1000s×, a pitch/speed-shifted copy ~1.2–1.7× — raise this (e.g. 2) to reject sped-up re-uploads
  --draw                 match: render an SVG alignment visualization per match (hash-pair scatter + offset histogram) — embeds in briefs like image --draw
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `audio.match` records.

### `overcast voice`

`voice add <audio|video|record-id> --index <local-voice-print-index>` embeds a clip's voiced windows (pyannote wespeaker speaker embeddings, run locally) and caches them in a local voice-print index. `voice match <clip> <sample>` ranks where the sample's SPEAKER talks in the clip (windowed cosine scan; `--diarize` upgrades to diarize-then-match against per-speaker centroids — needs HF_TOKEN + the accepted pyannote license like `enhance --ops separate`, and falls back to windowed without it). `voice match <sample> --index <id>` ranks which enrolled members contain the speaker. Videos are accepted — their audio track is extracted. `similarity` is a 0–100 rank score (anchored cosine; 50 ≈ the accept floor, 90 ≈ strong same-speaker), not a probability, and NOT liveness — a cloned/synthetic voice can score high; cross-language or degraded speech scores lower. To list a clip's speakers without a reference, use `enhance --ops separate`.

```
overcast voice <action> [input] [sample] [options]

  Speaker verification: enroll voices into a local voice-print index, or find/rank a reference voice inside a clip or across members.

Arguments:
  action           add | match
  input            audio/video path or record id (add: the clip to enroll; match: the clip to scan, or the sample when searching --index)
  sample           match: the reference voice sample for pairwise `voice match <clip> <sample>` (instead of --index)

Options:
  --index <string>       local voice-print index id/name
  --to <string>          alias for --index when adding
  --min-similarity <number> score floor 0–100 (default 50 ≈ the accept threshold; suggested findings fire at 80)
  --min-margin <number>  minimum score-point gap between the best match and the runner-up speaker (diarized) or the clip's median window (windowed/search) — a cheap calibration gate
  --diarize              pairwise match: diarize-then-match (overlap-aware; needs HF_TOKEN + accepted pyannote license, else falls back to windowed)
  --speakers <number>    match --diarize: expected speaker count hint
  --start <string>       pairwise match: scan window start (seconds or HH:MM:SS)
  --end <string>         pairwise match: scan window end (seconds or HH:MM:SS)
  --window <number>      pairwise match: seconds per embedding window (default 3; members follow the index config)
  --limit <number>       match: max results
  --offset <number>      match --index: result offset
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `voice.match` records.

### `overcast cluster`

A persistent LOCAL face database backed by the deepface provider (clustering needs face embeddings, which the tinycloud face path doesn't expose). `cluster add <media>` detects faces, embeds them, and ASSIGN-OR-CREATEs each into a person (nearest existing person above --min-similarity, else a new one); `cluster identify <image|video>` surfaces the most similar person for a probe (or flags it as a likely new person) without writing; `cluster recluster` re-groups every stored face and carries human labels forward; `cluster list`/`show` read the DB and `cluster view` renders a self-contained HTML contact sheet. Needs a face-cluster index (`index create <name> --type face-cluster --local`); resolves the case's sole one when --index is omitted. Emits a `cluster` record.

```
overcast cluster <action> [arg] [arg2] [options]

  Build and browse a local face-cluster DB: group faces into people, identify, label, and view.

Arguments:
  action           add | ingest | identify | list | show | label | recluster | view
  arg              add/identify: media (path/URL/record-id) · show/label: person id
  arg2             label: the name to assign (cluster label <person-id> <name>)

Options:
  --index <string>       face-cluster index id/name (default: the case's sole face-cluster index)
  --min-similarity <number> add/identify: assign-or-create threshold; recluster: linkage threshold (0–100)
  --cluster <string>     show/label: the person id (alternative to the positional)
  --label <string>       label: the name to assign (alternative to the positional)
  --fps <number>         add/identify: sampling frames per second (video)
  --max-frames <number>  add/identify: video frame sample count/cap
  --start <string>       add/identify: window start (SS or timecode)
  --end <string>         add/identify: window end (SS or timecode)
  --limit <number>       list/show/identify: max results
  --source-record <string> add: the case record id the media came from
  --out <string>         view: HTML output path (default: .overcast/media/cluster-<id>.html)
  --no-open              view: write the gallery but don't launch it
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `cluster` records.

### `overcast similar`

`similar add <image|video> --index <basic-clip-index>` embeds and caches a reference in a local CLIP DB (videos are frame-sampled and pooled); a `basic-clap` index instead embeds audio (or a video's audio track) with CLAP. `similar match <image|video|audio> --index <id>` ranks members by image→image (CLIP) or audio→audio (CLAP) similarity; `similar search "<text>" --index <id>` ranks members by text→image (CLIP) or text→audio (CLAP) similarity. Runs OpenAI CLIP / LAION CLAP locally; scores are cosine×100 (0–100).

```
overcast similar <action> [input]... [options]

  Find images/video moments or audio by visual, audio, or text similarity in a local CLIP (basic-clip) or CLAP (basic-clap) index.

Arguments:
  action           add | match | search
  input            image/video/audio path, URL, record id (add/match) — or a text query (search)

Options:
  --index <string>       local basic-clip (CLIP) or basic-clap (CLAP audio) index id/name
  --to <string>          alias for --index when adding
  --min-similarity <number> match/search: similarity floor (0–100)
  --limit <number>       match/search: max results
  --offset <number>      match/search: result offset
  --pooling <string>     match: pool the query's frames/windows by max | mean (members follow the index config)
  --granularity <string> video (one vector per file) | frame (moments — video frames, or 10s audio windows for basic-clap) — set at `index create`; members always follow the index config
  --sampling <string>    basic-clip only — match query video: uniform windows | shots (tinycloud watch boundaries); members follow the index config
  --window <number>      seconds per uniform sampling window (basic-clip video) or audio chunk (basic-clap)
  --fps <number>         video: frame sampling rate; --max-frames can cap it
  --max-frames <number>  video: frame sample count/cap
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `similar.match` records.

### `overcast exif`

Runs ExifTool over an image or video and emits a media.metadata record: a searchable summary plus GPS coordinates (signed decimals), capture time, camera make/model, editing software, MIME/dimensions/duration, and a total tag count. The default backend is the shipped ExifTool provider (system `exiftool` on PATH; install with `brew install exiftool` / `apt install libimage-exiftool-perl`); bind your own with `setup provider exif <spec>`. Accepts a path, a case record/capture id, or an http(s) URL (fetched into the case media dir first). The full raw tag dump stays in-provider — only the compact summary is indexed.

```
overcast exif <input> [options]

  Extract embedded metadata — GPS, capture time, device — from an image or video (ExifTool).

Arguments:
  input            Image/video/file path, case record id, or http(s) URL

Options:
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `media.metadata` records.

### `overcast verify`

Reads the embedded C2PA / Content Credentials manifest of an image or video and emits a media.provenance record: whether a signed manifest is present, the claim generator, the signer/certificate issuer, the signature algorithm, the validation state + codes, and assertion/ingredient counts. Media with no credentials is a clean `ready` record (`has_manifest: false`), not an error. The default backend is the shipped c2patool provider (system `c2patool` on PATH; install with `brew install c2patool`); bind your own with `setup provider verify <spec>`. Accepts a path, a case record/capture id, or an http(s) URL. Distinct from source-post provenance (where a record came from) — this checks the media's own embedded credentials.

```
overcast verify <input> [options]

  Check a media file's C2PA / Content Credentials provenance manifest (c2patool).

Arguments:
  input            Image/video/file path, case record id, or http(s) URL

Options:
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `media.provenance` records.

### `overcast enhance`

Default: deterministic, modality-dispatched ops on the bundled ffmpeg (denoise/normalize/voice-isolate/upscale/stabilize/grayscale). Bind a model provider for AI restoration or the SPLIT ops via `setup provider enhance <spec>`: `--ops separate` splits an audio/video's voices into per-speaker tracks (add --summarize to transcribe each), `--ops segment --prompt "<thing>"` cuts requested objects out of an image as mask + cutout evidence. separate/segment need a bound provider (local-models = pyannote + GroundingDINO/SAM2, or fal = sam-audio + sam-3); image segmentation of a video is out of scope (segment a frame:// still). Emits a media.enhanced record per output — for the split ops, one child record per track/mask whose media.ref chains into watch/listen/see/view/crop.

```
overcast enhance <input> [options]

  Produce better media (denoise/normalize/upscale) or split it (separate voices / segment objects) via ffmpeg or a bound model provider.

Arguments:
  input            Media file path

Options:
  --ops <string>         Comma list of ops (denoise,normalize,upscale,separate,segment,...)
  --prompt <string>      What to segment (--ops segment) or the target voice to extract
  --speakers <string>    Speaker-count hint for --ops separate
  --summarize            Transcribe/summarize each separated track via the bound listen provider
  --masks-only           For --ops segment, emit binary masks instead of RGBA cutouts
  --out <string>         Output path (default .overcast/media/)
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `media.enhanced` records.

## Inspect

### `overcast view`

For video/audio, generates a self-contained HTML player (timeline + markers for a referenced record's media.at) and opens it. For other files, uses the OS open command. Given an `enhance` split-op PARENT record (--ops separate/segment), renders a GALLERY of its fanned-out children instead — per-speaker audio players + spectrograms for separate (with cross-talk regions), or cutout/mask images for segment. --no-open writes the viewer and emits a view record with its path.

```
overcast view <ref> [options]

  Open media in a lightweight local viewer (scrubbable player) or hand off to the OS.

Arguments:
  ref              Media path, capture-id, or record-id

Options:
  --at <string>          Start at SS or seek a START-END span
  --spectrogram          (audio) also render a spectrogram
  --no-open              Write the viewer but don't launch it
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `view` records.

### `overcast crop`

Takes a face or see detection record and writes cropped still images under .overcast/media/crops/. For detections with frame thumbnails, crop uses the supplied frame image as the crop source. Each crop record preserves the source record, source media, crop source media, timestamp/frame, class/id, confidence, and box. Use --all, --id, --class, or --kind to select detections; crops are memory-friendly evidence artifacts.

```
overcast crop <input> [options]

  Materialize face/object detections as cropped image records with provenance.

Arguments:
  input            Detection record id (face/see)

Options:
  --all                  Crop every matching detection
  --id <string>          Crop one detection/face/track id
  --class <string>       Filter by class/label, e.g. face, person, car
  --kind <string>        Filter detection kind: face | object
  --pad <number>         Expand the crop box by a fraction, e.g. 0.15
  --square               Make the crop square around the detection box
  --limit <number>       Maximum crops to write
  --out <string>         Output directory (default .overcast/media/crops)
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `media.crop` records.

### `overcast grid`

Samples frames from a video — uniformly across a --start/--end window (default the whole clip, --count frames) or at an explicit --at timestamp list — and tiles them into ONE contact-sheet image via the internal ffmpeg toolkit, burning each cell's number + timestamp when the ffmpeg build has drawtext (else the sheet is unlabeled and cells are numbered left-to-right, top-to-bottom). Emits a media.grid record whose media.ref is the montage and whose payload.cells maps cell number → exact timestamp. Chain it: `overcast see <montage-path> --prompt "which numbered cell best shows X? give the cell number"` then read payload.cells to recover the source time — one VLM call triages a long clip before a frame-precise zoom-in (see frame://<record>@<sec>). Add --view for a clickable HTML contact sheet (cells labeled with their timestamp even when ffmpeg can't burn labels, each seeking the source video on click); --no-open writes it without launching.

```
overcast grid <input> [options]

  Tile timestamped video frames into a labeled contact sheet for one-shot VLM triage.

Arguments:
  input            Video file path or case record id

Options:
  --count <number>       Number of frames to sample across the window (default 16)
  --at <string>          Explicit comma list of timestamps (SS or MM:SS), overrides --count/window
  --start <string>       Window start (SS or MM:SS)
  --end <string>         Window end (SS or MM:SS)
  --cols <number>        Grid columns (default ceil(sqrt(count)), max 12)
  --width <number>       Cell width in px (default 320)
  --out <string>         Output image path (default .overcast/media/)
  --view                 Also render a clickable HTML contact sheet (numbered cells seek the source video)
  --no-open              With --view, write the HTML board but don't launch it
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `media.grid` records.

### `overcast wall`

Generates a self-contained HTML wall of muted, looping video tiles — each anchored to its best evidence moment (open finding > face hit > record anchor) — overlaid with case state: sense-coverage badges, findings, per-source scan / monitor / brief freshness. Local media is referenced by file:// URL (not embedded); missing or browser-hostile media renders a NO SIGNAL / STILL tile (with an ffmpeg poster frame when extractable). Click a tile to open the media at its anchor; hover for the intel card. --infinite repeats the real feeds to fill the screen and keeps extending the grid as it scrolls — an endless monitor bank even from a handful of feeds. --no-open writes the wall and emits a record with its path instead of launching.

```
overcast wall  [options]

  Open a control-room monitor wall: case videos looping at their evidence moments.

Options:
  --limit <number>       Max tiles, most evidentiary/recent first (~25 is a practical decode ceiling) (default: 12)
  --source <string>      Only media from this source type (youtube | tiktok | x | web | lens | local)
  --since <string>       Only media with records since (e.g. 24h, 7d, 2026-06-01)
  --export <string>      Wall HTML path (default: .overcast/media/wall.html)
  --refresh <number>     Auto-reload the wall every N seconds (restarts the feeds)
  --infinite             Endless wall: repeat feeds to fill the screen and keep extending on scroll
  --no-open              Write the wall but don't launch it
  --theme <string>       HTML theme: plain | csi (default: plain)
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `wall` records.

## OSINT

### `overcast scan`

Enumerates each enabled source by its bound ref (channel/handle/hashtag/keyword); an explicit --query overrides, and the active target is the fallback when a source has no ref. With --pull, each hit uses the same media.ref/payload.url, capture, sense, and failure semantics as monitor. If the case has no enabled external sources, scan falls back to local case media/indexes and can run a face-index search when an image target and face-analysis index are available.

```
overcast scan  [options]

  Sweep sources, or local case media/indexes when no sources exist; emit scan.hit records (--pull to capture+sense).

Options:
  --query <string>       Ad-hoc keyword search across sources
  --source <string>      Restrict to source ids/types (comma list)
  --since <string>       Only items newer than e.g. 24h, 2026-06-01
  --limit <number>       Max hits per source; with --local, max local visual DB candidates
  --local                Scan local case media/indexes instead of external sources
  --pull                 Auto-capture + sense each hit
  --pipe <string>        Sense to run on pulled hits (watch|listen|face)
  --describe             With --pipe listen: full audio-scene describe (not speech-only)
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `scan.hit` records.

### `overcast capture`

Acquires media/content into .overcast/media/: a local path is copied in; a URL is downloaded via the matching source provider. Emits a capture record with a capture_id usable by the senses.

```
overcast capture <ref> [options]

  Fetch a resource (URL / scan.hit / local path) into the case as a capture record.

Arguments:
  ref              URL, scan.hit id, local path, or - for stdin

Options:
  --index                Embed into the case index after capture
  --out <string>         Output location override
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `capture` records.

### `overcast monitor`

Enumerates sources, diffs against .overcast/seen.json, and for each NEW item uses the shared scan --pull processor: resolve media.ref/payload.url, capture when needed, then run explicit --pipe or setup automation/default watch. Hard processing failures are surfaced and marked seen; pending/credential gaps remain retryable. --once = single diff pass (scheduler-friendly). --every <15m|6h|…> = continuous blocking loop (run under tmux; Ctrl-C to stop); each pass streams its records. --brief summarizes the new batch; --alert <stdout|file> mirrors new records to a sink.

```
overcast monitor  [options]

  scan on a loop; diff against the seen-set; pipe new items into a sense. --once or --every <interval>.

Options:
  --source <string>      Restrict to source ids/types
  --query <string>       Ad-hoc keyword search across sources
  --since <string>       Only items newer than e.g. 24h, 2026-06-01
  --limit <number>       Max hits per source
  --pipe <string>        Sense to run on new items (watch|listen|face)
  --describe             With --pipe listen: full audio-scene describe (not speech-only)
  --once                 Single diff pass then exit
  --every <string>       Continuous loop cadence (e.g. 15m, 6h)
  --brief                Summarize the new batch into a brief record
  --alert <string>       Mirror new records to a file sink (they already stream to stdout)
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `scan.hit` records.

### `overcast index`

An index is a Cloudglue-backed searchable corpus of videos, searched one way per TYPE: media-descriptions (ask/probe), entities (same-schema extraction), face-analysis (detect + find a person). `create <name> --type <media|entities|face>` (entities needs --prompt/--schema); `attach <remote-id-or-name>` mirrors an existing remote index into this case; `add <video> --to <id>` registers a video (a path, URL, or a case record id) — `--all` registers every video the case has captured or sensed (watch/listen/face) for the target; `list`/`show <id>` inspect; `delete <id>`/`remove <video> --from <id>` prune; `entities <id> <video>` fetches a video's extracted entities. Then read with `ask --index <id>`, `face --match … --index <id>`, or `index entities`. Backed by tinycloud (≥ 0.3.4).

```
overcast index <action> [arg] [arg2] [options]

  Manage tinycloud indexes that index a target's videos (create/attach/add/list/show/delete/remove/entities).

Arguments:
  action           create | attach | add | list | show | delete | remove | entities
  arg              name (create) · remote id/name (attach) · video/record-id (add/remove) · index id (show/delete/entities)
  arg2             entities: the video/record-id (index entities <id> <video>)

Options:
  --type <string>        create/attach: media-descriptions | entities | face-analysis | rich-transcripts | deepface-local | image-ransac | face-cluster | basic-clip | audio-fp | basic-clap | voice-print
  --local                create a local index instead of a tinycloud-backed index
  --description <string> create: human description
  --prompt <string>      create entities: free-text extraction prompt
  --schema <string>      create entities: path to a JSON schema file
  --to <string>          add: target index id/name
  --from <string>        remove: index id/name to remove the video from
  --all                  add: register every video the case has captured or sensed (watch/listen/face)
  --remote               list: also query tinycloud for all account indexes
  --no-upload            add: don't upload (use an already-uploaded source)
  --no-download          add: don't materialize the source locally
  --limit <number>       entities: max entities
  --offset <number>      entities: entity offset
  --pooling <string>     create basic-clip/basic-clap: pool video frames / audio windows by max | mean
  --granularity <string> create basic-clip/basic-clap: video (one vector/file) | frame (moment-level / audio windows)
  --sampling <string>    create basic-clip: uniform | shots (watch boundaries)
  --window <number>      create basic-clip/basic-clap: seconds per uniform sampling window / audio chunk
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `index` records.

## Read

### `overcast ask`

Retrieves over bound case-search memory providers (local-grep always on; optional qmd) and answers with citations to record.id and media.at. Plain ask uses local-grep; use --deep or --memory qmd after `setup memory qmd` for qmd-backed local semantic search.

```
overcast ask <question> [options]

  Natural-language query over the case memory; answers with record.id + media.at citations.

Arguments:
  question         The question to answer

Options:
  --deep                 Use a provider's semantic/deep search path when available (e.g. qmd)
  --index <string>       Answer over a media-descriptions index (id/name) via tinycloud, not local memory
  --probe                With --index: semantic moment search (probe) instead of Q&A (ask)
  --scope <string>       With --index --probe: file | segment
  --memory <string>      Restrict to memory provider/backend ids (local-grep/local, qmd)
  --since <string>       Time filter (e.g. 24h, 2026-06-01)
  --verb <string>        Restrict to record kinds (comma list)
  --limit <number>       Max local passages; with --index --probe, max probe results
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `answer` records.

### `overcast brief`

Produces a structured report from accumulated records. --export writes a shareable md/html artifact (format inferred from the file extension).

```
overcast brief  [options]

  Synthesize the case records into a report (timeline + findings); --export to md/html.

Options:
  --scope <string>       Filter, e.g. since:24h or verb:watch
  --full                 Include the full verbatim record timeline (audit dump) instead of the compact appendix
  --export <string>      Write a report file (.md or .html)
  --theme <string>       HTML export theme: plain | csi (default: plain)
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `brief` records.

## State

### `overcast target`

A target is a line of investigation. `add --question` records what would resolve it; `close <id> --as answered|dead-end --note` marks the line done (closed lines stop seeding scan/monitor); `reopen <id>` reactivates it. Status feeds the brief/status thread cards.

```
overcast target <action> [value] [options]

  Define/refine the standing scope, a.k.a. a line of investigation (add|list|rm|show|close|reopen). Persisted to .overcast/target.json.

Arguments:
  action           add | list | rm | show | close | reopen
  value            target value (for add) or id (for rm/close/reopen)

Options:
  --image                Treat the value as a reference image path
  --question <string>    add: what would resolve this line of investigation
  --as <string>          close: answered | dead-end
  --note <string>        close: why (answered how / why it's a dead end)
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `target` records.

### `overcast source`

Register where to look (add <type>:<ref> | list | enable|disable <id> | rm <id>).

```
overcast source <action> [value] [options]

  Register where to look (add <type>:<ref> | list | enable|disable <id> | rm <id>).

Arguments:
  action           add | list | enable | disable | rm
  value            <type>:<ref> (add) or source id

Options:
  --name <string>        Friendly name for the source
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `source` records.

### `overcast note`

Creates a primary human-authored `note` record. Notes are searchable by `ask`, included in `brief`, visible in `case records`, and can cite media via `--ref <record-id|capture-id|path|url>` plus `--at <seconds|start-end|timecode>`. Use `--tag` for comma-separated labels and `--confidence` for the analyst's confidence marker.

```
overcast note <text> [options]

  Add a human observation/finding to the case, optionally anchored to evidence.

Arguments:
  text             Observation/finding text

Options:
  --ref <string>         Evidence record id, capture id, media path, or URL to anchor this note
  --at <string>          Anchor time: seconds, hh:mm:ss, or start-end span
  --tag <string>         Comma-separated labels (e.g. vehicle,contradiction)
  --confidence <string>  Analyst confidence marker (e.g. low|medium|high)
  --title <string>       Short note title
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `note` records.

### `overcast finding`

Creates manual findings and lists/reviews automated findings. Score/text triggers emit `suggested` findings (leads) that stay OUT of memory/brief evidence until reviewed — `finding list --state triage` queues them newest-first, `accept` promotes a lead into evidence, `dismiss` rejects it (a dismissed suggestion never re-fires for the same match). Review records reference the original finding; dismissed findings remain auditable.

```
overcast finding [action] [id] [options]

  Create and review findings (create|list|accept|dismiss).

Arguments:
  action           create | list | accept | dismiss (default: list)
  id               finding id for accept/dismiss, or text for create

Options:
  --state <string>       list: open | suggested | accepted | dismissed | all | triage (open+suggested), or a comma-list
  --target <string>      create: target/scope this finding supports
  --ref <string>         create: source record id, capture id, media path, or URL
  --at <string>          create: evidence timestamp seconds, hh:mm:ss, or start-end
  --confidence <string>  create: confidence marker or score
  --json                 Shorthand for --format json
  --format <string>      json | md | txt
```

Emits `finding` records.

### `overcast case`

A case is the cwd folder + its .overcast/ store. `case init [dir] --name` stands it up; `case setup` runs/saves first-run setup and `case setup status|show|edit|plan` manages it; `case status` reports setup/store/memory health; `case info` shows state; `case records [--verb] [--since]` lists records; `case memory <list|get|search|index> [q]` routes to the bound memory providers. `case clear` previews what would be lost; add `--yes` to clear records/media/state and configured materialized memory indexes while preserving the case id. `case memory get <id>` returns a field manifest (sizes); add `--field <name> [--offset N] [--limit M]` to page a large field (e.g. a watch `content`) in full — never head/tail the raw jsonl.

```
overcast case <action> [sub] [arg] [options]

  Inspect/manage the current case: init | setup | status | info | records | memory | clear.

Arguments:
  action           init | setup | status | info | records | memory | clear
  sub              setup/memory subcommand, or dir for init
  arg              record id (memory get), query (memory search), or index action

Options:
  --name <string>        Case name (init/setup/edit)
  --target <string>      setup/edit: comma-separated target values to add
  --image-target <string> setup/edit: comma-separated reference image targets to add
  --face-ref <string>    setup/edit: alias for --image-target for face matching references
  --remove-target <string> setup/edit: comma-separated target ids/values to remove
  --note <string>        setup/edit: note text to add as local evidence; pass JSON array or newline-separated text for multiple notes
  --source <string>      setup/edit: comma-separated source specs (<type>:<ref>) to add
  --remove-source <string> setup/edit: comma-separated source ids/specs to remove
  --index <string>       setup/edit: comma-separated indexes (name:type or id:type:name)
  --remove-index <string> setup/edit: comma-separated index ids/names to remove
  --signals <string>     setup/edit: comma-separated signals for new indexes/videos
  --provider <string>    setup/edit: comma-separated provider choices (<verb>:<choice>) for this case
  --provider-indexable <string> setup/edit: comma-separated provider output verbs eligible for memory/indexing
  --auto-sense <string>  setup/edit: comma-separated senses to run on newly captured media
  --auto-index-new       setup/edit: automatically add newly analyzed media to configured indexes
  --no-auto-index-new    setup/edit: disable automatic indexing for newly analyzed media
  --findings <string>    setup/edit: automated finding workflow (suggest | review | off; default suggest)
  --findings-threshold <string> setup/edit: comma-separated score-trigger floors (face=75,similar=85,cluster=70,voice=80,image_inliers=1,audio_margin=1)
  --video <string>       setup/edit: comma-separated local videos/URLs to route
  --folder <string>      setup/edit: comma-separated local media folders to remember
  --no-index             setup/edit: save setup routes without starting remote collection ingestion
  --dry-run              setup/edit: preview without saving or applying
  --verb <string>        Filter records by kind
  --since <string>       Time filter (e.g. 24h, 2026-06-01)
  --export <string>      Write a case status/log report (.md or .html)
  --full                 status: append the raw payload JSON for auditing
  --theme <string>       HTML export theme: plain | csi (default: plain)
  --field <string>       Payload field to read in full (memory get)
  --offset <number>      Start char offset when paging a field (memory get)
  --limit <number>       Max records/passages, or max chars when paging a field
  --memory <string>      Memory provider/backend for case memory index (e.g. local-grep, qmd)
  --yes                  Confirm destructive case clear or non-interactive setup apply
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `case` records.

## Config

### `overcast prebrief`

A lightweight case kickoff. Initializes the .overcast/ store, sets the case name, and optionally seeds a target (--target) and a source (--source <type>:<ref>).

```
overcast prebrief [name] [options]

  Stand up a case: name + target + source in one shot (non-interactive via flags).

Arguments:
  name             Case name

Options:
  --target <string>      Seed target (name/prompt)
  --source <string>      Seed source <type>:<ref>
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `prebrief` records.

### `overcast setup`

Configure and persist profiles under ~/.overcast/profiles/. `setup provider <verb> <spec>` binds a verb to a provider (exec:<cmd> | http(s)://… | inproc:<module>). `setup llm <provider> <model>` sets the brain. `setup memory <local-grep|qmd>` configures case search. `setup show` prints the active profile.

```
overcast setup [action] [a] [b] [options]

  Bind the brain LLM + per-verb providers and manage profiles (setup provider|llm|memory|show).

Arguments:
  action           provider | llm | memory | show (default: show)
  a                verb (provider), provider id (llm), or backend (memory)
  b                spec (provider), model (llm), or command (memory)

Options:
  --profile <string>     Profile name to write (default: default)
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `setup` records.

### `overcast provider`

`provider setup plan|apply|show` configures catalog-backed provider choices for a profile. `provider init <verb>` runs the bound provider's init step — a command, or guidance for a skill-based init (not wired yet). `provider list` shows the active bindings.

```
overcast provider [action] [verb] [options]

  Run provider setup/init hooks, or list/describe bound providers (provider setup|init|list|describe).

Arguments:
  action           setup | init | list | describe (default: list)
  verb             setup subcommand, or verb whose provider to init/describe

Options:
  --profile <string>     Profile name to write/read (default: active/default)
  --verb <string>        provider setup: verb to configure
  --choice <string>      provider setup: catalog choice id
  --preset <string>      provider setup: preset id (cloudglue|hf|fal|elevenlabs|owl-local|local-models|deepface-local|basic-clip|audio-fp|basic-clap|voice-print)
  --yes                  provider setup apply: confirm profile changes
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `provider` records.

### `overcast doctor`

Preflight: check pi version, ffmpeg/ffprobe, Cloudglue creds, tinycloud, provider bindings.

```
overcast doctor  [options]

  Preflight: check pi version, ffmpeg/ffprobe, Cloudglue creds, tinycloud, provider bindings.

Options:
  --sources              Also check configured source-provider credentials
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `doctor` records.

### `overcast skills`

`skills generate` (re)writes shipped skills including skills/overcast/{SKILL.md,reference/verbs.md}, skills/overcast-init, and focused workflow examples from the verb registry. `skills install [--harness claude-code]` copies them into the Claude Code skills dir by default; `skills install --dest <dir>` is the explicit path for Codex, Cursor, and other agents.

```
overcast skills <action> [options]

  Generate shipped overcast skills + reference from the registry, or install into a harness/directory.

Arguments:
  action           generate | install

Options:
  --harness <string>     Target harness for install (claude-code)
  --dest <string>        Install shipped skills into this directory (recommended for Codex/Cursor/other agents)
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `skills` records.
