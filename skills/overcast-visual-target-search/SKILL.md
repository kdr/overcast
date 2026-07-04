---
name: overcast-visual-target-search
description: >-
  Find a person, logo, object, landmark, or visual reference across local clips
  or captured media with timestamped Overcast evidence.
---

# overcast-visual-target-search

Use this skill when the task is to locate a visual target across videos, images,
or captured case media. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Workflow

For a person with a reference image:

```bash
overcast doctor --json
overcast case init --json
overcast face ./clip.mp4 --match ./person.jpg --json   # a match ≥75% auto-suggests a finding
overcast finding list --state triage --json            # triage the auto-suggested lead(s)…
overcast finding accept <id> --json                    # …accept a real match (or `dismiss <id>`)
overcast crop <face-record-id> --all --class face --json
overcast ask "where does the reference person appear, with timestamps and confidence?" --json
overcast brief --export ./visual-search.md --json      # short by default; --full for the per-match timeline
```

For an object or open-vocabulary target (`--detect` needs a bound OWLv2 detector —
build it once with `scripts/visual-db-uv.sh --detect`, then bind the venv python it
prints: `overcast setup provider see "exec:$DETECT_PY examples/providers/detect/detect.py"`,
NOT system `python3` which lacks torch/transformers):

```bash
overcast see ./clip.mp4 --detect "red backpack" --json
overcast crop <see-record-id> --all --class "red backpack" --json
overcast ask "list target detections with timestamps, confidence, and crop paths" --json
```

For logos, landmarks, or near-duplicate visual references:

```bash
overcast index create refs --type image-ransac --local --json
overcast index add ./reference-logo.png --to <index-id> --json
overcast image match ./clip.mp4 --index <index-id> --json   # a RANSAC hit auto-suggests a finding
overcast finding list --state triage --json                  # then accept/dismiss the lead
```

## Output

Return timestamped matches, similarity or confidence where available, source
`record.id`, `media.at`, and cropped evidence paths created by `crop`.
`face --match` / `image match` auto-suggest findings — resolve them with
`finding list --state triage` → `accept`/`dismiss` so a run doesn't leave an
un-triaged queue; the default `brief` is short, `--full` for the per-match timeline.
State whether the match came from `face --match`, `see --detect`, or local
`image-ransac` matching.

## Caveats

Face detections are sampled-frame detections, not unique-person counts. Use
`face --match <image>` for a specific person and include confidence caveats.
For exact evidence, use `crop` to materialize local image records, then
synthesize with `ask` and `brief`.
