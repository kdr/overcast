---
name: overcast
description: >-
  Give any agent senses (video/audio/image understanding) and OSINT reach
  (search/capture/monitor) organized around an investigation case. Use when the
  user wants to analyze a video/audio/image, scan or monitor sources for a
  target, or ask/brief over accumulated findings. Drives the `overcast` CLI
  (built on pi + the tinycloud/Cloudglue perception backend); see
  reference/verbs.md for the full verb surface.
---

# overcast

overcast turns a vanilla agent into a video-understanding OSINT investigator.
A **case** is just the current directory (its `.overcast/` store holds the
records). Every verb emits a loose, indexable **record**; cite findings by
`record.id` + `media.at`.

## Verbs

- `watch` — Analyze a video into a reusable, time-anchored record (content/transcript/detailed).
- `listen` — Transcribe and analyze audio (or a video's audio track) into an audio.analysis record.
- `see` — Understand an image or a single video frame (caption, OCR, detections).
- `enhance` — Produce better media (denoise/normalize/upscale/...) via ffmpeg or a bound model provider.
- `view` — Open media in a lightweight local viewer (scrubbable player) or hand off to the OS.
- `scan` — Sweep registered sources for the target(s); emit scan.hit records (--pull to capture+sense).
- `capture` — Fetch a resource (URL / scan.hit / local path) into the case as a capture record.
- `monitor` — scan on a loop; diff against the seen-set; pipe new items into a sense. --once or --every <interval>.
- `target` — Define/refine the standing scope (add|list|rm|show). Persisted to .overcast/target.json.
- `source` — Register where to look (add <type>:<ref> | list | enable|disable <id> | rm <id>).
- `prebrief` — Stand up a case: name + target + source in one shot (non-interactive via flags).
- `ask` — Natural-language query over the case memory; answers with record.id + media.at citations.
- `brief` — Synthesize the case records into a report (timeline + findings); --export to md/html.
- `case` — Inspect/manage the current case: init | info | records | memory.
- `setup` — Bind the brain LLM + per-verb providers and manage profiles (setup provider|llm|show).
- `provider` — Run a provider's init hook, or list/describe bound providers (provider init|list|describe).
- `doctor` — Preflight: check pi version, ffmpeg/ffprobe, Cloudglue creds, tinycloud, provider bindings.
- `skills` — Generate the flagship overcast skill + reference from the registry, or install into a harness.

## How to drive it

Run any verb from bash and parse the JSON record:

```bash
overcast watch ./clip.mp4 --json          # video.analysis record
overcast scan --pull --json               # enumerate sources, capture + sense
overcast ask "every white van, with timestamps" --json
overcast brief --export ./brief.html
```

`overcast commands --json` dumps the authoritative verb registry. Full man
pages are in [reference/verbs.md](reference/verbs.md) (progressive disclosure —
read it when you need a verb's exact flags).

### Reading large records

A verb's JSON record can carry a large field (a `watch` `content` timeline, a
long `listen` transcript). Don't reconstruct it by `head`/`tail`-ing the raw
`.overcast/records/*.jsonl` — that truncates and silently drops the middle.
Page it deterministically instead:

```bash
overcast case memory get <record-id>                              # manifest: field names + sizes (chars)
overcast case memory get <record-id> --field content --offset 0 --limit 16000 --json
# repeat with the returned next_offset until has_more is false; offsets are in chars
```

## Setup

`overcast doctor` checks readiness (pi, system ffmpeg, Cloudglue creds, the
tinycloud CLI). `overcast setup provider <verb> <spec>` rebinds a verb to your
own provider with no code changes.
