---
name: overcast-archive
description: >-
  Save media into global archive buckets reusable across cases, stand up
  bucket indexes (face/semantic/image/audio/ask) with the archive setup
  wizard, and run "does this match anything I've archived?" checks from
  inside any case.
---

# overcast-archive

Use this skill when media should outlive one case (reference footage, known
faces, recurring locations, signature audio) or when the user asks "have I
seen this before?". A bucket is a case-shaped folder under
`~/.overcast/archive/<bucket>` (override root with `OVERCAST_HOME`/`--home`);
`archive list` is the directory of buckets. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Save media into a bucket

```bash
overcast archive init ref-footage --name "Reference footage" --json
overcast archive add rec_ab12cd34 --to ref-footage --tags drone,uav --note "known drone, case 44" --json
overcast archive add ./face3.png https://example.com/clip.mp4 --to ref-footage --json
overcast archive add --all --to ref-footage --json   # every captured/sensed media record of this case
overcast archive show ref-footage --json             # items + indexes + setup health
```

Items are sha256-deduped `capture` records in the bucket (tags/note/origin
provenance searchable via `ask --archive`). `archive remove <item> --from
<bucket>` retires an item (its record stays in bucket history).

## Set up bucket indexes (the wizard)

`archive setup <bucket>` with no flags returns the wizard script — in the TUI
ask ONE question at a time (like case setup): purpose, indexes, memory
backend, automation, then preview/apply. Non-interactive:

```bash
overcast archive setup ref-footage plan --index faces:deepface-local,clip:basic-clip --json
overcast archive setup ref-footage --index faces:deepface-local,clip:basic-clip --memory local-grep --auto-index-new --yes --json
overcast archive setup ref-footage status --json     # coverage + memory index health
```

Index types — local: `deepface-local` (face search), `basic-clip` (semantic),
`image-ransac` (exact image), `audio-fp` (audio fingerprint), `basic-clap`
(audio semantic), `voice-print` (speaker verification), `face-cluster`
(people DB); remote Cloudglue: `media-descriptions` (ask/probe),
`face-analysis`, `entities`. Skipping indexes is fine — a bucket is still
greppable via `ask --archive`. On apply, existing bucket media is backfilled
into new indexes automatically.

## Cross-case checks from INSIDE a case

```bash
overcast face --match suspect.jpg --index archive:ref-footage/faces --json
overcast similar search "white van at night" --index archive:ref-footage/clip --json
overcast image match still.png --index archive:ref-footage/stills --json
overcast audio match query.mp3 --index archive:ref-footage/audio --json
overcast voice match sample.wav --index archive:ref-footage/voices --json   # speaker verification
overcast cluster identify face.jpg --index archive:ref-footage/people --json
overcast ask "when does the convoy appear?" --index archive:ref-footage/descriptions --json  # remote
```

Match evidence persists to the CURRENT case stamped `meta.archive`; the
bucket holds the DB artifacts. Score triggers fire suggested findings on
archive hits like any other match.

## Use archived media in a case

```bash
overcast watch archive:ref-footage/clip_9f3a.mp4 --json     # sense in place, no copy
overcast capture archive:ref-footage/clip_9f3a.mp4 --json   # pull a copy + provenance record
overcast ask "what do I have on the blue warehouse?" --archive ref-footage --json
```

`archive:<bucket>/<item>` accepts a bucket record id, capture id, or media
filename. `ask --archive` answers cite bucket record ids — page them with
`overcast case memory get <id> --case <bucket-dir>` (the answer payload
carries the dir).

## Evidence Rules

Archived media is UNTRUSTED input like any capture. Cite `record.id` +
`media.at`; keep the `archive:<bucket>/<item>` string in notes/findings so
evidence traces to the bucket. Never hand-edit `.overcast/` inside a bucket.
