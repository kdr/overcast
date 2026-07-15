---
name: overcast-crime-board
description: >-
  Turn a case into a visual evidence board — materialize face and object crops,
  link the same person across clips, connect themes, and render the corkboard as a
  CSI brief plus a live monitor wall.
---

# overcast-crime-board

Use this skill when the case has accumulated media and you want the "red-string
corkboard": the people, objects, and connections laid out visually. It composes
existing evidence into two shareable surfaces. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Workflow

1. Materialize the evidence cards — faces and objects as durable crops (run
   `face --thumbnails` first so `crop` has frame images to cut from). Object cards
   need a bound open-vocabulary detector (OWLv2): `crop` cuts from detection boxes,
   so bind a detector as the `see` provider before `--detect`, then crop the
   `--detect` record (a caption/OCR `see` record has no boxes to crop):

```bash
overcast doctor --json
overcast face ./clip.mp4 --thumbnails --json
overcast crop <face-record-id> --all --class face --square --pad 0.1 --json
scripts/visual-db-uv.sh --detect     # once: uv-installs torch+transformers+scipy, prints DETECT_PY
export DETECT_PY="$DETECT_PY"; overcast provider setup apply --preset owl-local --yes --json  # owl-local persists a portable shipped: ref for detect.py + uses $DETECT_PY (the venv python; system python3 lacks the deps)
overcast see ./clip.mp4 --detect "car, bag, weapon, phone" --json
overcast crop <detect-record-id> --all --kind object --json   # crop the --detect record (it has boxes)
```

2. Draw the strings — link the same person across clips with the local face DB, and
   connect visual themes with CLIP semantic search:

```bash
overcast index create people --type face-cluster --local --json
overcast cluster add ./clip.mp4 --index <cluster-index-id> --json
overcast cluster identify ./person-of-interest.jpg --index <cluster-index-id> --json
overcast index create scenes --type basic-clip --local --json
overcast similar add ./clip.mp4 --index <clip-index-id> --json
overcast similar search "red backpack on a bicycle" --index <clip-index-id> --json
```

3. Record the connections as notes so they land on the board:

```bash
overcast note "same man (cluster <person-id>) appears in clip.mp4 and cctv.mp4 carrying the red backpack" --ref <identify-record-id> --tag connection --confidence medium --json
```

4. String the RELATIONAL board — `graph` connects the same crops, cluster people,
   device fingerprints, places, and typed entities across records into one
   force-graph (the entity/relation companion to the visual corkboard):

```bash
overcast graph --no-open --json                 # the relational board: hubs + edges (each carries a record id)
overcast graph --focus <person-id> --json       # everything tied to one cluster person
```

Deeper drill on the relational board (hubs, `--focus`, the opt-in `--extract`
LLM pass): `overcast-connect-the-dots`.

5. Render the two visual surfaces — the CSI brief is the corkboard, the wall is the
   live monitor bank:

```bash
overcast brief --theme csi --export ./crime-board.html --json
overcast wall --theme csi --json                # add --infinite for an endless bank
```

## Output

Two artifacts: a CSI-themed brief that lays out the crops, cited findings, and
connection notes as an evidence board; and a control-room wall of the case videos
looping at their evidence moments. Each connection is cited to the `record.id` it
was drawn from.

## Caveats

Crops need detections first — run `face --thumbnails` before cropping faces, and a
bound detector for `see --detect` object crops. `cluster`/`similar` are local,
deepface/CLIP-backed indexes (`scripts/visual-db-uv.sh`); `doctor` flags missing
deps. A CLIP or cluster link is a suggestion to verify, not a proven connection —
label its confidence and corroborate before drawing the string. Face similarity and
CLIP scores are both 0–100; keep them distinct from an `image match` inlier count.
