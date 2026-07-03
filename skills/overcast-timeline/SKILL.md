---
name: overcast-timeline
description: >-
  Reconstruct a single event from multiple clips — sense each one, cross-anchor
  shared moments, surface corroborations and contradictions, and produce one cited
  chronological brief.
---

# overcast-timeline

Use this skill to "walk through what happened" across several recordings of one
event (bystander videos, multiple cameras, a sequence of clips): build one ordered,
cited timeline and flag where accounts disagree. Use the broad `overcast` skill and
`overcast/reference/verbs.md` for exact flags.

## Workflow

1. Sense every clip — `watch` for the visual timeline, `listen` where audio carries
   the account:

```bash
overcast doctor --json
overcast case init --json
overcast watch ./cam1.mp4 --json
overcast watch ./phone-clip.mp4 --json
overcast listen ./phone-clip.mp4 --json
```

2. Cross-anchor shared moments with span notes — a visible clock, a shared sound, a
   lighting change lets you line clips up on one timeline:

```bash
overcast note "wall clock reads 21:14 as the door opens" --ref <cam1-record-id> --at 12-15 --tag anchor --json
overcast note "same doorbell chime as cam1@13 — clips overlap here" --ref <phone-record-id> --at 3-6 --tag anchor --json
```

3. Corroborate and contradict across clips, then turn disagreements into
   low-confidence findings for review:

```bash
overcast ask "order the events across all clips with timestamps; where do accounts agree or conflict? cite record.id + media.at" --json
overcast finding create "conflict: cam1 shows the car arriving BEFORE the shout; phone-clip audio has the shout first" --ref <cam1-record-id> --at 12-15 --confidence low --json
```

4. Produce the chronological deliverable, and always leave a `tldr` note first:

```bash
overcast note "reconstructed <n> clips into one timeline; <k> firm anchors; <c> unresolved conflicts" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./timeline.html --json
```

## Output

One ordered chronology of the event, each entry cited to a `record.id` + `media.at`,
the anchor moments that let clips be aligned, and an explicit list of unresolved
contradictions. Where clips can't be ordered relative to each other, say so rather
than guessing.

## Caveats

Device clocks and upload times drift — prefer content anchors (a shared sound, a
visible clock, a synchronized event) over file timestamps when aligning clips.
Absence of a moment in one clip is not evidence it didn't happen — it may be
off-frame. Keep observed facts (in `note`) separate from inferred ordering; a
contradiction is a finding to review, not a settled conclusion.
