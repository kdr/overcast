---
name: overcast-enhance-and-resolve
description: >-
  Make unreadable footage legible — denoise/upscale a marked moment, re-run OCR
  and detection on the enhanced output, and record what was recovered with honest
  provenance (interpolation is a lead, not proof).
---

# overcast-enhance-and-resolve

Use this skill for the "zoom in… enhance" task: a plate, a face, or on-screen text
is too small or noisy to read, and you need to recover it and cite it honestly. Use
the broad `overcast` skill and `overcast/reference/verbs.md` for exact flags.

## Workflow

1. Ingest the raw clip and pin the moment worth resolving:

```bash
overcast doctor --json
overcast case init --json
overcast watch ./raw.mp4 --json
overcast note "plate unreadable, want to resolve" --ref <watch-record-id> --at 41-44 --json
```

2. Enhance that segment. The bundled ffmpeg ops are
   `denoise, normalize, voice-isolate, upscale, stabilize, grayscale`; the enhanced
   file comes back as a `media.enhanced` record you chain forward:

```bash
overcast enhance ./raw.mp4 --ops denoise,upscale,stabilize --json
```

3. Re-read the enhanced output. `--ocr` recovers text (a caption/OCR record, no
   boxes); `--detect` locates a region and needs a **bound detector** (bind OWLv2
   as the `see` provider first) — it produces the record with boxes that `crop`
   cuts from:

```bash
overcast see frame://<enhanced-record-id>@<seconds> --ocr --json                 # -> <ocr-record-id> (text, no boxes)
scripts/visual-db-uv.sh --detect     # once: uv-installs torch+transformers+scipy, prints DETECT_PY
export DETECT_PY="$DETECT_PY"; overcast provider setup apply --preset owl-local --yes --json  # owl-local persists a portable shipped: ref for detect.py + uses $DETECT_PY (the venv python; system python3 lacks the deps)
overcast see frame://<enhanced-record-id>@<seconds> --detect "license plate, text" --json  # -> <detect-record-id> (boxes)
```

4. Materialize the resolved region as durable cropped evidence — crop the
   `--detect` record (the `--ocr` record has no boxes to crop):

```bash
overcast crop <detect-record-id> --all --class "license plate" --pad 0.15 --square --json
```

5. Record what was recovered with its provenance. State the ops applied and the
   source record in the finding, keep a before/after note pair, and cite both the
   raw and enhanced `record.id`:

```bash
overcast note "before: plate illegible at 41-44 on <watch-record-id>" --ref <watch-record-id> --at 41-44 --json
overcast note "after denoise+upscale+stabilize: reads '7ABC123' (2 chars uncertain)" --ref <enhanced-record-id> --json
overcast finding create "plate resolved to '7ABC123' via enhance denoise,upscale,stabilize on <watch-record-id> — 2 chars low-confidence" --ref <detect-record-id> --confidence low --json
overcast brief --export ./enhance-resolve.html --json
```

## Output

The recovered text/object with an explicit confidence, the exact enhancement ops
applied, the before/after `record.id` pair, and the cropped evidence path. Frame
whatever you recover as a lead to corroborate, not a settled fact.

## Caveats

**ffmpeg upscale is interpolation — it cannot invent detail that was never
captured.** Recovered characters are a lead, not proof; mark them low-confidence and
corroborate (a second angle, a second frame, context). For genuine AI restoration
bind a model provider (`overcast provider setup apply --preset fal --yes`, ESRGAN /
DeepFilterNet) and re-run `see` on the restored output — then still corroborate.
`stabilize` and `upscale` change geometry, so re-derive any box/measurement on the
enhanced record, not the raw one.
