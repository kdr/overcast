# Wiretap — source media provenance

The "tape" is a short (~2 min) analysis excerpt from a publicly published podcast,
used here for a technical demonstration of speaker separation, audio cleanup, and
voice-print speaker verification.

## interview-tape.wav — the multi-speaker "tape"

- Episode: **Lightcone: Consumer is back, What's getting funded now, The vibes
  immaculate** — the Lightcone Podcast.
- Channel: **Y Combinator** (hosts: Garry Tan, Harj Taggar, Jared Friedman, Diana Hu).
- URL: https://www.youtube.com/watch?v=e1Yhs9BEOSw
- Segment used: **01:30–03:30** (120 s), fetched audio-only with `yt-dlp`, downmixed
  to mono / 16 kHz. Chosen for clear multi-speaker back-and-forth with distinct turns
  (four speakers, one dominant, minimal cross-talk).
- Public figures, used as a short analysis excerpt. Speakers are referred to by the
  diarizer's neutral labels (Speaker A/B/…) — the voice print verifies a VOICE, it
  does not assert a named identity.

## Degraded-intercept demonstration (synthetic noise, labeled)

Lightcone is clean studio audio, so to showcase the audio-cleanup step as a visible
before/after, ONE separated speaker track is deliberately degraded into a
"degraded intercept": a telephone-band band-pass (300–3400 Hz) plus added hiss /
room tone. The enhance pass (ElevenLabs voice isolation) then cleans it back. The
degradation is synthetic and is labeled as such everywhere it appears — it is a
demonstration of the cleanup on a real speaker, not a real intercepted recording.
