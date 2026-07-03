---
name: overcast-lineup
description: >-
  Build a persistent local face database out of case media — the mugshot book —
  then run a suspect photo through it to identify who they are and where else
  they appear, with cited similarity scores.
---

# overcast-lineup

Use this skill when the task is "run this person through the database": accumulate
every face across the case's clips and images into a local, browsable lineup, then
identify a probe photo against it. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags. The whole DB is local — no media
leaves the case.

## Prerequisites

The lineup is deepface-only (clustering needs face embeddings the tinycloud face
path doesn't expose). Prepare the local visual-DB Python once, bind DeepFace, and
stand up a `face-cluster` index:

```bash
overcast doctor --json                 # confirm uv + visual-db are ready
scripts/visual-db-uv.sh --face         # install OpenCV/DeepFace (once per machine)
overcast provider setup apply --verb face --choice deepface-local --profile default --yes --json
overcast case init --json
overcast index create people --type face-cluster --local --json
```

## Workflow

1. Book every case video/image into the lineup — `cluster add` detects, embeds,
   and assign-or-creates each face into a person (nearest existing person above
   `--min-similarity`, else a new one):

```bash
overcast cluster add ./interview.mp4 --index <index-id> --json
overcast cluster add ./cctv-lobby.mp4 --index <index-id> --json
overcast cluster add ./mugshot.jpg --index <index-id> --json
```

2. Open the lineup — a self-contained HTML contact sheet, one row per person:

```bash
overcast cluster view --index <index-id> --json     # add --no-open to only write the gallery
overcast cluster list --index <index-id> --json      # people + member counts
```

3. Run a suspect photo through the database. `cluster identify` reports the most
   similar person (similarity 0–100) or flags the probe as a likely NEW person,
   and never writes to the DB:

```bash
overcast cluster identify ./suspect.jpg --index <index-id> --json
overcast cluster show <person-id> --index <index-id> --json   # inspect that person's member faces
```

4. Name known people and record the identification. Labels survive a
   `recluster`; point the finding's `--ref` at the `cluster identify` record so
   its match rides into the brief, and ALWAYS leave a `tldr` note — even a
   no-match sweep — so the brief can say so:

```bash
overcast cluster label <person-id> "Jane Doe" --index <index-id> --json
overcast finding create "identified suspect.jpg as person <person-id> (Jane Doe) — 91/100, appears in 3 clips" --ref <identify-record-id> --confidence high --json
overcast note "booked <n> clips into the lineup; <p> distinct people; suspect.jpg matched <person-id> at 91/100" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./lineup.html --json
```

After a large batch of `cluster add`s, run `overcast cluster recluster --index
<index-id> --json` to re-group every stored face; human labels carry forward.

## Output

For each identification return: the probe photo, the matched `person-id` (and
label if named), the similarity score (0–100), the member clips/images the person
appears in with their `record.id` + `media.at`, and the exported lineup path. A
probe with no confident match is reported as a likely new person, not forced onto
the nearest face.

## Caveats

Similarity is 0–100 (percent), not 0–1 — set `--min-similarity` on that scale.
The assign-or-create threshold controls how eagerly faces merge: too low over-merges
distinct people, too high splits one person across rows — tune it, then
`recluster`. Detection is per sampled frame, so one person yields many member
faces; that is expected, not duplicate people. Poor lighting, small faces, and
heavy angles lower embedding quality — treat a single borderline match as a lead
and corroborate with `face --match` or a second clip before calling it.
