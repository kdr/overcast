# Case: Wiretap — "Who Is On This Tape?"

**What it proves:** overcast works a recorded multi-speaker conversation
end-to-end. A 2-minute panel excerpt goes in; `enhance --ops separate` (local
pyannote, no media leaves the machine) splits it into one clean track per voice —
**four speakers, only four cross-talk regions** — each with its own spectrogram.
Then it cleans a noisy track: one speaker is degraded into a telephone-band
"intercept" (band-limit + hiss), and `enhance` voice-isolation (ElevenLabs) drops
the noise floor from a full-spectrum haze to black. Finally the local `voice-print`
DB verifies WHO: the **cleaned** dominant speaker is enrolled as a reference, and
`voice match` re-identifies him on the tape at **100/100** while a different
panelist scores **58/100** — a clean positive-vs-negative on the same recording.
Every voice record carries the honest caveat: similarity is a 0–100 rank score,
NOT liveness — a cloned voice can score high, so a match is a corroborated lead,
never an identification.

**Source tape:** a ~2-min analysis excerpt (01:30–03:30) of *Lightcone: Consumer is
back, What's getting funded now* — the **Lightcone Podcast**, channel **Y
Combinator** (hosts Garry Tan, Harj Taggar, Jared Friedman, Diana Hu),
https://www.youtube.com/watch?v=e1Yhs9BEOSw . Fetched audio-only with `yt-dlp`,
downmixed to mono/16 kHz. Speakers are referred to by the diarizer's neutral labels
(Speaker A–D), not named. The "degraded intercept" noise is synthetic and labeled
as such. Full provenance in `showcase/_media/wiretap/SOURCES.md`.

## Run

```bash
cd <case-studies repo root>            # creds auto-load from .env
set -a; source .env; set +a

# 0. Two dedicated profiles so both enhance bindings coexist (shared default untouched)
overcast provider setup apply --verb enhance --choice local-models --profile showcase-wiretap     --yes --json   # pyannote separate
overcast provider setup apply --verb enhance --choice elevenlabs   --profile showcase-wiretap-iso --yes --json   # voice isolation

# 1. Fetch the tape (audio-only) and cut a 2-min multi-speaker window (mono/16k)
yt-dlp -f bestaudio -o /tmp/lightcone.webm "https://www.youtube.com/watch?v=e1Yhs9BEOSw"
mkdir -p showcase/_media/wiretap
ffmpeg -y -ss 90 -t 120 -i /tmp/lightcone.webm -vn -ac 1 -ar 16000 -acodec pcm_s16le showcase/_media/wiretap/interview-tape.wav

# 2. Case + line of investigation + transcript (default tinycloud backend)
overcast case init --case showcase/wiretap --json
overcast target add "voice-on-the-tape" --question "How many people speak, and once a degraded track is cleaned up, does the reference voice print re-identify the subject and reject the others?" --case showcase/wiretap --json
overcast listen showcase/_media/wiretap/interview-tape.wav --case showcase/wiretap --json   # names it a Lightcone panel

# 3. Separate the speakers (local pyannote; HF_TOKEN + accepted license)
overcast enhance showcase/_media/wiretap/interview-tape.wav --ops separate --summarize \
  --case showcase/wiretap --profile showcase-wiretap --json
# -> parent + 4 tracks: SPEAKER_03 (A, 64.0s, dominant) / SPEAKER_02 (B, 30.3s) / SPEAKER_01 (C, 18.0s) / SPEAKER_00 (D, 5.9s), 4 cross-talk regions

# 4. Cleanup step: degrade Speaker A's track into a noisy "intercept", then voice-isolate it back
MED=showcase/wiretap/.overcast/media
ffmpeg -y -i $MED/separate/interview-tape_SPEAKER_03.wav \
  -filter_complex "[0:a]highpass=f=300,lowpass=f=3400,acompressor=threshold=-18dB:ratio=4,volume=1.6[v]; \
                   anoisesrc=color=pink:amplitude=0.05:sample_rate=16000[hiss]; \
                   sine=frequency=60:sample_rate=16000,volume=0.015[hum]; \
                   [v][hiss][hum]amix=inputs=3:duration=first:normalize=0,alimiter=limit=0.95[out]" \
  -map "[out]" -ac 1 -ar 16000 -acodec pcm_s16le $MED/interview-tape_SPEAKER_03_degraded.wav
overcast enhance $MED/interview-tape_SPEAKER_03_degraded.wav \
  --case showcase/wiretap --profile showcase-wiretap-iso --json   # -> *_degraded_voiceiso.mp3 (noise floor -> black)

# 5. Voice print: enroll the CLEANED Speaker A + two other panelists, then match
overcast index create voices --type voice-print --local --case showcase/wiretap --json
overcast voice add $MED/interview-tape_SPEAKER_03_degraded_voiceiso.mp3 --index voices --case showcase/wiretap --json  # Speaker A (cleaned reference)
overcast voice add $MED/separate/interview-tape_SPEAKER_02.wav --index voices --case showcase/wiretap --json           # Speaker B
overcast voice add $MED/separate/interview-tape_SPEAKER_01.wav --index voices --case showcase/wiretap --json           # Speaker C

overcast voice match showcase/_media/wiretap/interview-tape.wav $MED/interview-tape_SPEAKER_03_degraded_voiceiso.mp3 --case showcase/wiretap --json
# POSITIVE: cleaned Speaker A found on the tape — best 100.0 at 15.8s, 20/159 windows >= floor, margin 30 -> auto-suggested finding
overcast voice match $MED/separate/interview-tape_SPEAKER_02.wav $MED/interview-tape_SPEAKER_03_degraded_voiceiso.mp3 --case showcase/wiretap --json
# NEGATIVE: Speaker B vs cleaned Speaker A -> best 58.4 (cosine 0.32) — rejected
overcast voice match $MED/separate/interview-tape_SPEAKER_03.wav --index voices --case showcase/wiretap --json
# LINEUP: probe Speaker A against the enrolled panel -> A member 100 vs next-best 61

# 6. Analyst loop: accept the lead, record findings + notes, close, brief
overcast finding accept <positive-finding-id> --target <tgt> --case showcase/wiretap --json
overcast finding create "Four speakers on the tape ... 4 cross-talk regions" --ref <separate-parent> --target <tgt> --confidence high --case showcase/wiretap --json
overcast finding create "Audio cleanup recovers a degraded intercept ... cleaned track re-IDs at 100/100" --ref <enhance-clean> --target <tgt> --confidence high --case showcase/wiretap --json
overcast finding create "Voice print discriminates: 100/100 vs 58/100 ... NOT liveness" --ref <negative-match> --target <tgt> --confidence high --case showcase/wiretap --json
overcast note "... 100/100 vs 58/100 ... Not liveness; the degradation is a labeled demonstration." --tag tldr --case showcase/wiretap --json
overcast target close <tgt> --as answered --note "..." --case showcase/wiretap --json
overcast brief --theme csi --export showcase/wiretap/brief.html --case showcase/wiretap --json
```

The before/after gallery (`gallery.html`) is a hand-built self-contained page:
per-speaker separated tracks + spectrograms, then the degraded-vs-cleaned pair with
matched 16 kHz spectrograms (data-URI) and compact mp3 players.

## Publish

```bash
node <overcast.video>/scripts/publish-case.mjs --slug wiretap \
  --src <case-studies>/showcase/wiretap --scrub <case-studies> --thumb gallery.html
node <overcast.video>/scripts/publish-runbook.mjs --slug wiretap \
  --md <case-studies>/showcase/wiretap/RUNBOOK.md --scrub <case-studies>
# ~5.8MB media copied (6 x 64k-mono mp3), scrub grep all-0
```

## Notes / caveats

- `enhance --ops separate` ran on the **local** pyannote binding
  (`speaker-diarization-community-1`, HF_TOKEN + accepted license); the voice-
  isolation cleanup ran on the **ElevenLabs** binding. They live in two dedicated
  profiles (`showcase-wiretap`, `showcase-wiretap-iso`) so the shared default
  profile is never touched.
- The "degraded intercept" is a **synthetic** degradation (telephone band-pass +
  pink hiss + faint mains hum) applied to a real speaker's separated track, so the
  audio-cleanup before/after is an obvious noisy→clean. It is labeled as synthetic
  in the gallery, brief, and provenance.
- Voice-print scores are 0–100 rank scores (never 0–1). Every `voice` record carries
  `payload.caveat`: similarity is NOT liveness — a cloned/synthetic voice can score
  high; corroborate before treating a match as identification. Speakers are labeled
  A–D by the diarizer, never named.
