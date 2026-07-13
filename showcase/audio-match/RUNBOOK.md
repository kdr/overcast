# RUNBOOK — audio-match ("Shazam for evidence")

A low-bitrate 11-second clip shows up somewhere it shouldn't. Is it a re-upload of
a recording we already hold — or something new? This case fingerprints three
reference recordings into a local `audio-fp` index (Wang-2003 constellation
hashes, numpy/scipy, fully offline), then throws four clips at it: a disguised
re-upload (sliced at +6s, re-encoded to 32 kbps mp3, volume dropped), an unrelated
control, and two speed-tampered copies. The true re-upload lands at offset
**+5.99s** (ground truth +6.00s) with **723 aligned votes** and a **361.5× margin**
over the runner-up offset; the control returns "no confident match"; a 6% sped-up
copy degrades to an 11.8× margin with the aligned span collapsing 9.57s → 2.18s;
a 12% sped-up copy falls to 1.39× and is rejected outright by `--min-margin 2` —
the honest caveat: fingerprinting survives transcode and noise, NOT pitch/speed
change.

All commands run from the repo root (creds auto-load from `.env`).

## 1. Case + media prep

```bash
overcast case init --case showcase/audio-match --json
mkdir -p showcase/audio-match/media

# three distinct reference recordings
ffmpeg -y -ss 30 -t 40 -i "$OC_VIDEO_SPEECH" -vn -c:a aac -b:a 128k showcase/audio-match/media/ref-speech.m4a
ffmpeg -y -ss 10 -t 40 -i "$OC_VIDEO_SMALL"  -vn -c:a aac -b:a 128k showcase/audio-match/media/ref-bbq.m4a
cp "$OC_AUDIO" showcase/audio-match/media/ref-sample-audio.m4a

# QUERY: disguised re-upload — 11s slice at +6s, 32kbps mp3, volume 0.85
ffmpeg -y -ss 6 -t 11 -i "$OC_AUDIO" -vn -af "volume=0.85" -c:a libmp3lame -b:a 32k showcase/audio-match/media/query-reupload.mp3

# NEGATIVE control: unrelated audio, never indexed
ffmpeg -y -ss 20 -t 15 -i "$OC_VOICE_OTHER_VIDEO" -vn -c:a aac -b:a 128k showcase/audio-match/media/control-unrelated.m4a

# speed-tampered re-uploads (same slice, atempo)
ffmpeg -y -ss 6 -t 11 -i "$OC_AUDIO" -vn -af "atempo=1.06,volume=0.85" -c:a libmp3lame -b:a 32k showcase/audio-match/media/query-spedup.mp3
ffmpeg -y -ss 6 -t 11 -i "$OC_AUDIO" -vn -af "atempo=1.12,volume=0.85" -c:a libmp3lame -b:a 32k showcase/audio-match/media/query-spedup12.mp3
```

## 2. Target + fingerprint index

```bash
overcast target add "re-upload provenance: query-reupload.mp3" \
  --question "Is the low-bitrate clip query-reupload.mp3 the SAME underlying recording as one of the three reference tracks — and if so, at what time offset?" \
  --case showcase/audio-match --json                      # → tgt_5c64e4

overcast index create fingerprints --type audio-fp --local \
  --description "Wang-2003 acoustic fingerprints of the three reference recordings" \
  --case showcase/audio-match --json

overcast audio add showcase/audio-match/media/ref-sample-audio.m4a --to fingerprints --case showcase/audio-match --json  # 12490 hashes / 20.0s
overcast audio add showcase/audio-match/media/ref-speech.m4a       --to fingerprints --case showcase/audio-match --json  # 26114 hashes / 40.0s
overcast audio add showcase/audio-match/media/ref-bbq.m4a          --to fingerprints --case showcase/audio-match --json  # 19553 hashes / 40.0s
```

## 3. Match: positive, control, speed-tampered

```bash
# POSITIVE — rec_8952e809fa5cc231:
#   matches ref-sample-audio.m4a at +5.99s (ground truth +6.00s),
#   723 aligned votes / 5879 query hashes (ratio 0.123), margin 361.5x, span 9.57s
#   → auto-suggested finding rec_d2dcb4ced758bd9b (signal:audio-match)
overcast audio match showcase/audio-match/media/query-reupload.mp3 \
  --index fingerprints --min-margin 2 --draw --case showcase/audio-match --json

# NEGATIVE control — rec_3953e8dff2560dc1: "no confident audio match"
#   (best rejected alignment: 2 votes, margin 2.0, span 1.02s)
overcast audio match showcase/audio-match/media/control-unrelated.m4a \
  --index fingerprints --min-margin 2 --draw --case showcase/audio-match --json

# 6% SPED-UP — rec_d21dd46bfb6ba7b8: still aligns (+6.18s) but degraded:
#   400 votes, margin 11.8x, span collapsed 9.57s → 2.18s (time-stretch drift)
overcast audio match showcase/audio-match/media/query-spedup.mp3 \
  --index fingerprints --min-margin 2 --draw --case showcase/audio-match --json

# 12% SPED-UP — rec_c27b0f3d01745bd4: REJECTED by --min-margin 2
#   (best rejected: 71 votes, margin 1.39, span 1.16s)
overcast audio match showcase/audio-match/media/query-spedup12.mp3 \
  --index fingerprints --min-margin 2 --draw --case showcase/audio-match --json
```

## 4. Triage + narrate

```bash
overcast finding list --state triage --case showcase/audio-match --json
overcast finding accept  rec_d2dcb4ced758bd9b --target tgt_5c64e4 --case showcase/audio-match --json   # true match → evidence
overcast finding dismiss rec_9d1055e2f2074519 --target tgt_5c64e4 --case showcase/audio-match --json   # 6% sped-up impostor lead

overcast finding create "Speed-tamper signature: a 6% sped-up re-encode of the same recording still aligns at +6.18s but the margin collapses 361.5x -> 11.8x and the aligned span shrinks 9.57s -> 2.18s (time-stretch drift breaks Wang-2003 alignment); at 12% speedup the margin falls to 1.39x and --min-margin 2 rejects it outright." \
  --ref rec_d21dd46bfb6ba7b8 --target tgt_5c64e4 --confidence high --case showcase/audio-match --json

overcast note "query-reupload.mp3 IS ref-sample-audio.m4a: 723 hash votes align at offset +5.99s (ground truth: the slice was cut at +6.00s), margin 361.5x over the runner-up offset, aligned span 9.57s of an 11s query — an exact-recording match that survived 32kbps re-encode and a volume change." \
  --ref rec_8952e809fa5cc231 --tag "thread:tgt_5c64e4,provenance" --confidence high --case showcase/audio-match --json
overcast note "Discrimination checks: unrelated control clip -> no confident match (best rejected alignment: 2 votes, margin 2.0, span 1.0s). A 6% sped-up copy degraded to margin 11.8x with the aligned span collapsing 9.57s -> 2.18s (time-stretch drift); a 12% sped-up copy fell to margin 1.39x and was REJECTED by --min-margin 2. Wang-2003 fingerprints are robust to transcode/noise, NOT to pitch/speed change." \
  --ref rec_c27b0f3d01745bd4 --tag "thread:tgt_5c64e4,caveat" --confidence high --case showcase/audio-match --json
overcast note "Verdict: the low-bitrate 'query-reupload.mp3' is the SAME underlying recording as reference ref-sample-audio.m4a, aligned at +5.99s with 723 votes and a 361.5x margin — confirmed exact copy despite 32kbps transcode + volume change. Unrelated audio returns no match; speed-tampered copies collapse in margin/span and a 12% speedup is rejected outright by --min-margin 2." \
  --tag tldr --confidence high --case showcase/audio-match --json

overcast target close tgt_5c64e4 --as answered \
  --note "Yes — query-reupload.mp3 is ref-sample-audio.m4a at offset +5.99s (723 aligned votes, 361.5x margin); finding rec_d2dcb4ced758bd9b accepted." \
  --case showcase/audio-match --json
```

## 5. Artifacts + publish

```bash
overcast brief --theme csi --export showcase/audio-match/brief.html --case showcase/audio-match --json
overcast graph --theme csi --export showcase/audio-match/graph.html --no-open --case showcase/audio-match --json

node ~/dev/github/overcast.video/scripts/publish-case.mjs \
  --slug audio-match \
  --src ~/.supacode/repos/overcast/case-studies/showcase/audio-match \
  --scrub ~/.supacode/repos/overcast/case-studies \
  --thumb brief.html
# scrub check: grep -rEc "file://|/Users/" public/cases/audio-match/*.html → all 0
```

The brief inlines two `--draw` SVG alignment plots (base64 data URIs, fully
self-contained): the confirmed match (tight diagonal hash-pair band + one sharp
offset-vote spike) and the speed-tampered contrast (short scattered cluster).
