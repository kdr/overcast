---
name: overcast-where
description: >-
  Locate WHERE in a frame a target is — open-vocab detect, crop the box, then
  VLM-verify the crop so hallucinated boxes don't survive.
---

# overcast-where

Use this skill to turn a moment into spatial evidence: a bounding box on the
target plus a verified crop. It follows the detector-proposes / VLM-verifies
pattern (open-vocab detection like OWLv2, then confirm the crop) — because chat
VLMs are unreliable at emitting raw coordinates, so a real detector draws the box
and the VLM only judges the crop. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Setup

`see --detect` needs a detection provider bound (boxes come from OWLv2, not the
brain LLM):

```bash
scripts/visual-db-uv.sh --detect     # once: prints DETECT_PY (the venv python)
export DETECT_PY="$DETECT_PY"; overcast provider setup apply --preset owl-local --yes --json  # persists a portable shipped: ref for detect.py + the venv python
```

## Workflow

1. Have the moment (use `overcast-pinpoint` / `overcast-frame-grid`): timestamp
   T on record REC.

2. Detect the target in that frame, then materialize + verify the box:

```bash
overcast see frame://REC@T --detect "<target phrase>" --json      # -> see record with detections[]
overcast crop <see-record-id> --all --class "<target phrase>" --pad 0.15 --json
overcast see <crop-path> --prompt "Does this crop show <target>? yes/no + describe" --json
```

   The re-`see` of each crop is what kills false positives — open-vocab detectors
   emit confident boxes for almost any phrase at low thresholds.

3. Optionally sharpen the exhibit and record the finding:

```bash
overcast enhance <crop-path> --ops upscale,denoise --json
overcast finding create "<target> located at T" --ref <see-record-id> --confidence medium --json
overcast brief --export ./where.md --json
```

## Output

Per confirmed target: the timestamp, the box (from the `see --detect` record),
the crop path, and the verification verdict. Cite the `see` detection
`record.id` + `media.at`; note the crop is the durable, memory-friendly evidence
artifact.

## Caveats

Never ask the brain LLM for coordinates directly — bind a detector and verify
crops. Detector confidence is not calibrated across free-form phrases: a high
score on a rare phrase can still be wrong, so the crop re-check decides. For a
specific PERSON, use `face --match` instead of `--detect`. Boxes are per sampled
frame, not tracks.
