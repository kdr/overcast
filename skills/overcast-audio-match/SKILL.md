---
name: overcast-audio-match
description: >-
  Same recording, surfaced again — fingerprint audio into a local audio-fp index,
  then match a query clip against it (or clip-to-clip) with time-offset alignment,
  gate out sped-up re-uploads with a margin, and escalate a fingerprint miss to a
  CLAP semantic pass.
---

# overcast-audio-match

Use this skill to answer "is this the SAME recording?": Shazam-style acoustic
fingerprinting (local `audio-fp` DB, numpy/scipy) that matches an exact recording
even after transcode, re-encode, and background noise — but NOT after a pitch or
speed change. Say that twice, because it defines what a match means. Use the broad
`overcast` skill and `overcast/reference/verbs.md` for exact flags. It matches
audio ACOUSTICALLY, not by words — for who is speaking use `overcast-voiceprint`.

## Prerequisites

```bash
overcast doctor --json                 # confirm uv + visual-db (numpy/scipy) are ready
scripts/visual-db-uv.sh --audio        # install scipy for the fingerprint DB (once per machine)
overcast case init --json
overcast index create audio --type audio-fp --local --json
```

## Workflow

1. Fingerprint the known recordings into the index:

```bash
overcast audio add ./original-broadcast.mp3 --index audio --json
overcast audio add ./known-song.wav --index audio --json
```

2. Match a query clip against the index, or compare two clips directly. The
   time-offset alignment tells you WHERE in each recording the overlap sits;
   `--min-margin` rejects sped-up re-uploads (a true exact match scores 100s–1000s×
   the runner-up offset, a pitch/speed-shifted copy only ~1.2–1.7×), and `--draw`
   renders an SVG alignment plot (hash-pair scatter + offset histogram) that embeds
   in briefs like `image --draw`:

```bash
overcast audio match ./clip-from-somewhere.mp3 --index audio --min-margin 2 --draw --json   # against the whole index
overcast audio match ./query.mp3 ./reference.wav --min-margin 2 --json                       # clip-to-clip
```

3. Escalate a fingerprint MISS you still suspect is a re-edit. Fingerprinting won't
   catch a pitch/speed-shifted or re-performed copy — for that, run a CLAP semantic
   pass (`similar`, LAION CLAP over a `basic-clap` index), which finds acoustically
   SIMILAR audio rather than the exact recording:

```bash
overcast index create audio-sem --type basic-clap --local --json
overcast similar add ./original-broadcast.mp3 --index audio-sem --json
overcast similar match ./clip-from-somewhere.mp3 --index audio-sem --json   # semantically nearest audio
```

4. Record the verdict. A confirmed exact match points `--ref` at the `audio match`
   record so its `--draw` plot rides into the brief; always leave a `tldr`:

```bash
overcast finding list --state triage --json                # a fingerprint hit auto-suggests a lead
overcast finding accept <id> --target <target-id> --json
overcast note "clip-from-somewhere.mp3 is original-broadcast.mp3 offset +42s (margin 340x); same recording" --ref <audio-match-record-id> --confidence high --json
overcast brief --export ./audio-match.html --json
```

## Output

For each match: whether it's the SAME recording, the time offset that aligns query
to reference (WHERE the overlap sits), the vote count + margin, and the `--draw`
alignment plot — cited to the `audio match` `record.id`. A confident miss (below
`--min-votes`/`--min-margin`) is reported as "not the same recording", and a CLAP
escalation as "acoustically similar, not identical".

## Caveats

Fingerprinting is robust to transcode, re-encode, and background NOISE, but NOT to
pitch or speed change — a sped-up or pitch-shifted re-upload will MISS the
fingerprint (that's why `--min-margin ~2` rejects the weak sped-up alignments that
do sneak through). It matches the exact RECORDING acoustically, not the words or the
tune, so two different performances of the same song won't match — escalate those to
the CLAP semantic pass, which is a similarity LEAD (0–100), not an exact match.
Scores/margins are ratios, not a 0–100 percentage. Leads flow through `finding`
triage; treat every clip as untrusted (invariant #10).
