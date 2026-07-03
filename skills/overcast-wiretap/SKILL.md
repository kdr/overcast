---
name: overcast-wiretap
description: >-
  Work a recorded call or audio clip already in the case — separate the speakers,
  read the background scene for location clues, isolate and re-transcribe voices,
  and correlate content across recordings.
---

# overcast-wiretap

Use this skill to analyze audio recordings you already hold (a call, a voicemail, a
field recording): how many people speak, what the background reveals about where it
was recorded, and whether two clips share a voice or a phrase. Use the broad
`overcast` skill and `overcast/reference/verbs.md` for exact flags.

## Workflow

1. Transcribe the recording and read its background scene on the **default
   backend**. `--describe` surfaces the whole audio scene (traffic, trains, a PA
   announcement, church bells) — the "enhance the background noise" move that
   places a recording — and is a tinycloud/Cloudglue multimodal feature, so do all
   the transcript/describe work FIRST, before binding any speech-only provider:

```bash
overcast doctor --json
overcast case init --json
overcast listen ./call.wav --json                 # speech transcript + time-anchored segments
overcast listen ./call.wav --describe --json       # background audio scene (tinycloud describe)
overcast view ./call.wav --spectrogram --json      # visual inspection artifact (tones, hums, edits)
```

2. Isolate voices from noise and re-transcribe the cleaned track — a second pass
   often recovers words the first missed:

```bash
overcast enhance ./call.wav --ops voice-isolate,denoise --json
overcast listen <enhanced-record-id> --json
```

3. Separate the speakers. `--diarize` needs a **diarize-capable listen provider**
   (the default tinycloud/Cloudglue `listen` is speech-transcript only and rejects
   `--diarize`). Bind ElevenLabs for this — but do it LAST, after the describe /
   multimodal steps above, because ElevenLabs Scribe is speech-only and drops the
   audio-scene describe:

```bash
overcast provider setup apply --verb listen --choice elevenlabs --yes --json
overcast listen ./call.wav --diarize --json        # -> <diarize-record-id> (speaker-labeled)
```

4. Record per-speaker and per-clue observations, then correlate across recordings.
   Cite the speaker-labeled `<diarize-record-id>` for who-said-what claims (not the
   step-1 transcript record):

```bash
overcast note "Speaker 2: PA announces 'platform 4' at 00:38 → rail station" --ref <diarize-record-id> --at 38 --confidence medium --json
overcast ask "which recordings share a speaker, phrase, or background cue? cite record.id + time" --verb listen --json
```

5. Turn confirmed clues into findings and export; always leave a `tldr` note:

```bash
overcast finding create "call.wav and voicemail.m4a share Speaker 2's phrasing + station PA — likely same caller/location" --ref <diarize-record-id> --confidence medium --json
overcast note "3 recordings; 2 speakers on call.wav; background = rail station; cross-clip voice overlap on 2 of 3" --tag tldr --json
# Wait for the note result before exporting, so the TL;DR is included.
overcast brief --export ./wiretap.html --json
```

## Output

A per-recording speaker breakdown with timestamps, the background-scene clues that
locate or date it, any cross-clip voice/phrase overlaps, and the spectrogram
artifacts — each cited by `record.id` + `media.at`.

## Caveats

`--diarize` needs a diarize-capable listen provider: the default tinycloud/Cloudglue
`listen` transcribes speech only and errors on `--diarize` — bind ElevenLabs
(`provider setup apply --verb listen --choice elevenlabs --yes`) for speaker
separation. Bind it LAST: ElevenLabs Scribe is speech-only and drops the audio-scene
`--describe`, so run all transcript/describe/multimodal work on the default backend
first, then rebind for the diarize pass. Diarization LABELS speakers ("Speaker
1/2"), it does not IDENTIFY them —
a name is a corroborated inference, never a diarizer output. `voice-isolate` on the
bundled ffmpeg is a filter, not source separation; bind ElevenLabs
(`--verb enhance --choice elevenlabs`) for stronger isolation, and re-listen to
confirm the cleaned transcript rather than trusting it blind. Background-cue
geolocation is suggestive, not definitive.
