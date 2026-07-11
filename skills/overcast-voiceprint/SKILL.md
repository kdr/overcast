---
name: overcast-voiceprint
description: >-
  Voice lineup — enroll a reference speaker into a local voice-print index, then
  rank WHERE that speaker talks inside a clip and WHICH recordings contain them,
  reading the anchored 0–100 rank score and its margin, and corroborating before
  naming anyone.
---

# overcast-voiceprint

Use this skill to answer "is this the same speaker, and where do they talk?" with
the local `voice-print` DB (pyannote/wespeaker speaker embeddings — no media
leaves the case, ungated windowed default). It verifies a VOICE, not a phrase. Use
the broad `overcast` skill and `overcast/reference/verbs.md` for exact flags.

## Prerequisites

```bash
overcast doctor --json                 # confirm uv + visual-db (pyannote) are ready
scripts/visual-db-uv.sh --voice        # install pyannote.audio (once per machine)
overcast case init --json
overcast index create voices --type voice-print --local --json
```

## Workflow

1. Enroll the reference speaker (and any known recordings). `voice add` embeds the
   clip's voiced windows into the index:

```bash
overcast voice add ./known-speaker.wav --index voices --json     # the reference person
overcast voice add ./interview.m4a --index voices --json          # other recordings to search
```

2. Rank WHERE the reference speaker talks inside a clip (pairwise, windowed scan).
   `voice match <clip> <sample>` scans `<clip>` for the `<sample>` speaker;
   `--diarize` upgrades to overlap-aware diarize-then-match (HF_TOKEN + accepted
   pyannote license, windowed fallback if ungated):

```bash
overcast voice match ./call.wav ./known-speaker.wav --json                 # where in call.wav does the sample speaker talk?
overcast voice match ./call.wav ./known-speaker.wav --diarize --min-margin 10 --json  # overlap-aware; gate on margin
```

3. Rank WHICH enrolled recordings contain the reference speaker (index search):

```bash
overcast voice match ./known-speaker.wav --index voices --json   # members ranked by the speaker's presence
```

4. Read the score honestly and corroborate before concluding. `similarity` is an
   anchored-cosine **0–100 RANK score** (never 0–1) plus a raw `cosine`;
   `--min-margin` gates best-vs-runner-up. Corroborate with content (a `listen`
   transcript) before naming anyone, then promote through triage:

```bash
overcast listen ./call.wav --json                                # what was said, to corroborate WHO
overcast finding list --state triage --json                      # a >=80 voice match auto-suggests a lead
overcast finding accept <id> --target <target-id> --json
overcast note "call.wav 00:38-01:12 ranks 87/100 for the known speaker (margin 22); transcript corroborates" --ref <voice-match-record-id> --at 38-72 --confidence medium --json
overcast brief --export ./voiceprint.html --json
```

## Output

For each match: the reference sample, WHERE (time windows) or WHICH (member
recordings) the speaker appears, the 0–100 rank score + raw cosine + margin, and the
corroborating transcript content — every claim cited to a `record.id` + `media.at`.
Report a time WINDOW, not a single frame.

## Caveats

**Not liveness.** A cloned / TTS / impersonated voice can score high, so a voice
match is a lead to corroborate, never an identification — every record carries
`payload.caveat`; surface it verbatim. The same speaker scores LOWER across
languages, heavy compression, or noise, so a miss isn't proof of a different person.
`--diarize` LABELS overlapping speakers, it does not name them. Scores are 0–100
(percent), not 0–1 — set `--min-similarity`/`--min-margin` on that scale. Leads
flow through `finding` triage; they stay out of ask/brief until accepted.
