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

  Runs the bound sense provider (default: tinycloud, exec) over a video file or URL and emits a video.analysis record with markdown content, a transcript (when speech is present), and the full structured describe in `detailed`.

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

  Default provider: tinycloud. Speech-only transcript by default; --describe runs the full multimodal describe to surface the AUDIO-SCENE description (sounds, music, events, ambience), not just speech. Emits transcript, speaker-tagged segments[] with media.at anchors, language.

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

Defaults to a Hugging Face image captioner when HF_TOKEN is set (override with HF_SEE_MODEL); otherwise a placeholder (needs_credentials) until a VLM is bound via `setup provider see`. Accepts frame://rec@sec, resolved to a frame via the internal ffmpeg toolkit.

```
overcast see <input> [options]

  Understand an image or a single video frame (caption, OCR, detections).

  Defaults to a Hugging Face image captioner when HF_TOKEN is set (override with HF_SEE_MODEL); otherwise a placeholder (needs_credentials) until a VLM is bound via `setup provider see`. Accepts frame://rec@sec, resolved to a frame via the internal ffmpeg toolkit.

Arguments:
  input            Image path, video frame, or frame://rec@sec

Options:
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
  --ocr                  Extract on-image text
  --detect <string>      Comma list of target objects to locate (bind the detect provider for bounding boxes)
  --prompt <string>      Focus the description
  --embed                Persist a visual embedding (query seed)
```

Emits `image.analysis` records.

### `overcast enhance`

Default: deterministic, modality-dispatched ops on the bundled ffmpeg (denoise/normalize/voice-isolate/upscale/stabilize/grayscale). Bind a model provider for AI upscaling/restoration via `setup provider enhance <spec>` (samples: fal esrgan/deepfilternet3, HF, ElevenLabs voice isolation). Emits a media.enhanced record whose media.ref is the output path — chain it into watch/listen/see.

```
overcast enhance <input> [options]

  Produce better media (denoise/normalize/upscale/...) via ffmpeg or a bound model provider.

  Default: deterministic, modality-dispatched ops on the bundled ffmpeg (denoise/normalize/voice-isolate/upscale/stabilize/grayscale). Bind a model provider for AI upscaling/restoration via `setup provider enhance <spec>` (samples: fal esrgan/deepfilternet3, HF, ElevenLabs voice isolation). Emits a media.enhanced record whose media.ref is the output path — chain it into watch/listen/see.

Arguments:
  input            Media file path

Options:
  --ops <string>         Comma list of ops (denoise,normalize,upscale,...)
  --out <string>         Output path (default .overcast/media/)
  --format <string>      Output surface: json | md | txt
  --json                 Shorthand for --format json
```

Emits `media.enhanced` records.

## Inspect

### `overcast view`

For video/audio, generates a self-contained HTML player (timeline + markers for a referenced record's media.at) and opens it. For other files, uses the OS open command. --no-open writes the viewer and emits a view record with its path instead of launching.

```
overcast view <ref> [options]

  Open media in a lightweight local viewer (scrubbable player) or hand off to the OS.

  For video/audio, generates a self-contained HTML player (timeline + markers for a referenced record's media.at) and opens it. For other files, uses the OS open command. --no-open writes the viewer and emits a view record with its path instead of launching.

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

## OSINT

### `overcast scan`

Enumerates each enabled source by its bound ref (channel/handle/hashtag/keyword); an explicit --query overrides, and the active target is the fallback when a source has no ref. With --pull, each AV hit is immediately captured and routed to a sense (one-shot recon).

```
overcast scan  [options]

  Sweep registered sources for the target(s); emit scan.hit records (--pull to capture+sense).

  Enumerates each enabled source by its bound ref (channel/handle/hashtag/keyword); an explicit --query overrides, and the active target is the fallback when a source has no ref. With --pull, each AV hit is immediately captured and routed to a sense (one-shot recon).

Options:
  --query <string>       Ad-hoc keyword search across sources
  --source <string>      Restrict to source ids/types (comma list)
  --since <string>       Only items newer than e.g. 24h, 2026-06-01
  --limit <number>       Max hits per source
  --pull                 Auto-capture + sense each hit
  --pipe <string>        Sense to run on pulled hits (watch|listen)
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

  Acquires media/content into .overcast/media/: a local path is copied in; a URL is downloaded via the matching source provider. Emits a capture record with a capture_id usable by the senses.

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

Enumerates sources, diffs against .overcast/seen.json, and for each NEW item runs capture → --pipe sense. --once = single diff pass (scheduler-friendly). --every <15m|6h|…> = continuous blocking loop (run under tmux; Ctrl-C to stop); each pass streams its records. --brief summarizes the new batch; --alert <stdout|file> mirrors new records to a sink.

```
overcast monitor  [options]

  scan on a loop; diff against the seen-set; pipe new items into a sense. --once or --every <interval>.

  Enumerates sources, diffs against .overcast/seen.json, and for each NEW item runs capture → --pipe sense. --once = single diff pass (scheduler-friendly). --every <15m|6h|…> = continuous blocking loop (run under tmux; Ctrl-C to stop); each pass streams its records. --brief summarizes the new batch; --alert <stdout|file> mirrors new records to a sink.

Options:
  --source <string>      Restrict to source ids/types
  --query <string>       Ad-hoc keyword search across sources
  --since <string>       Only items newer than e.g. 24h, 2026-06-01
  --limit <number>       Max hits per source
  --pipe <string>        Sense to run on new items (watch|listen)
  --describe             With --pipe listen: full audio-scene describe (not speech-only)
  --once                 Single diff pass then exit
  --every <string>       Continuous loop cadence (e.g. 15m, 6h)
  --brief                Summarize the new batch into a brief record
  --alert <string>       Mirror new records to a sink (stdout | <file>)
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `scan.hit` records.

## Read

### `overcast ask`

Retrieves over the bound memory providers (fan-out; local always on) and answers with citations to record.id and media.at. --deep forces agentic deepsearch (cloudglue, Phase 5).

```
overcast ask <question> [options]

  Natural-language query over the case memory; answers with record.id + media.at citations.

  Retrieves over the bound memory providers (fan-out; local always on) and answers with citations to record.id and media.at. --deep forces agentic deepsearch (cloudglue, Phase 5).

Arguments:
  question         The question to answer

Options:
  --deep                 Agentic semantic search (cloudglue)
  --memory <string>      Restrict to specific memory provider ids
  --since <string>       Time filter (e.g. 24h, 2026-06-01)
  --verb <string>        Restrict to record kinds (comma list)
  --limit <number>       Max passages
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `answer` records.

### `overcast brief`

Produces a structured report from accumulated records. --export writes a shareable md/html artifact (format inferred from the file extension).

```
overcast brief  [options]

  Synthesize the case records into a report (timeline + findings); --export to md/html.

  Produces a structured report from accumulated records. --export writes a shareable md/html artifact (format inferred from the file extension).

Options:
  --scope <string>       Filter, e.g. since:24h or verb:watch
  --export <string>      Write a report file (.md or .html)
  --format <string>      json | md | txt
  --json                 Shorthand for --format json
```

Emits `brief` records.

## State

### `overcast target`

Define/refine the standing scope (add|list|rm|show). Persisted to .overcast/target.json.

```
overcast target <action> [value] [options]

  Define/refine the standing scope (add|list|rm|show). Persisted to .overcast/target.json.

Arguments:
  action           add | list | rm | show
  value            target value (for add) or id (for rm)

Options:
  --image                Treat the value as a reference image path
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

### `overcast case`

A case is the cwd folder + its .overcast/ store. `case init [dir] --name` stands it up; `case info` shows state; `case records [--verb] [--since]` lists records; `case memory <list|get|search> [q]` routes to the bound memory providers.

```
overcast case <action> [arg] [options]

  Inspect/manage the current case: init | info | records | memory.

  A case is the cwd folder + its .overcast/ store. `case init [dir] --name` stands it up; `case info` shows state; `case records [--verb] [--since]` lists records; `case memory <list|get|search> [q]` routes to the bound memory providers.

Arguments:
  action           init | info | records | memory
  arg              dir (init), record id (memory get), or query (memory search)

Options:
  --name <string>        Case name (init)
  --verb <string>        Filter records by kind
  --since <string>       Time filter (e.g. 24h, 2026-06-01)
  --limit <number>       Max records/passages
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

  A lightweight case kickoff. Initializes the .overcast/ store, sets the case name, and optionally seeds a target (--target) and a source (--source <type>:<ref>).

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

Configure and persist profiles under ~/.overcast/profiles/. `setup provider <verb> <spec>` binds a verb to a provider (exec:<cmd> | http(s)://… | inproc:<module>). `setup llm <provider> <model>` sets the brain. `setup show` prints the active profile.

```
overcast setup <action> [a] [b] [options]

  Bind the brain LLM + per-verb providers and manage profiles (setup provider|llm|show).

  Configure and persist profiles under ~/.overcast/profiles/. `setup provider <verb> <spec>` binds a verb to a provider (exec:<cmd> | http(s)://… | inproc:<module>). `setup llm <provider> <model>` sets the brain. `setup show` prints the active profile.

Arguments:
  action           provider | llm | show
  a                verb (for provider) or provider id (for llm)
  b                spec (for provider) or model (for llm)

Options:
  --profile <string>     Profile name to write (default: default)
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `setup` records.

### `overcast provider`

`provider init <verb>` runs the bound provider's init step — a command, or guidance for a skill-based init (skill loading lands in Phase 7). `provider list` shows the active bindings.

```
overcast provider <action> [verb] [options]

  Run a provider's init hook, or list/describe bound providers (provider init|list|describe).

  `provider init <verb>` runs the bound provider's init step — a command, or guidance for a skill-based init (skill loading lands in Phase 7). `provider list` shows the active bindings.

Arguments:
  action           init | list | describe
  verb             verb whose provider to init/describe

Options:
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
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `doctor` records.

### `overcast skills`

`skills generate` (re)writes skills/overcast/{SKILL.md,reference/verbs.md} and skills/overcast-init from the verb registry. `skills install [--harness claude-code]` copies them into the harness skills dir.

```
overcast skills <action> [options]

  Generate the flagship overcast skill + reference from the registry, or install into a harness.

  `skills generate` (re)writes skills/overcast/{SKILL.md,reference/verbs.md} and skills/overcast-init from the verb registry. `skills install [--harness claude-code]` copies them into the harness skills dir.

Arguments:
  action           generate | install

Options:
  --harness <string>     Target harness for install (claude-code)
  --json                 JSON output
  --format <string>      json | md | txt
```

Emits `skills` records.
