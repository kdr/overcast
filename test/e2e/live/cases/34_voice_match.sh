#!/usr/bin/env bash
# Local speaker-verification DB (`voice-print`) — enroll two speakers, search
# the index with a fresh same-speaker sample, and pairwise-locate the speaker
# inside a B-then-A concatenation. Fixtures are synthesized with macOS `say`
# (two different voices, different sentences) or supplied via OC_VOICE_REF /
# OC_VOICE_CLIP (two different-speaker clips). HARD-GATED on OC_VOICE_E2E=1
# because the first run downloads the wespeaker embedding model. Assertions are
# RANK/position based (absolute scores are model-relative). The --diarize leg
# runs only when HF_TOKEN is present (gated pyannote pipeline).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=voice_match

have_cmd ffmpeg || { skip "$C" "no ffmpeg on PATH"; exit 0; }
case "${OC_VOICE_E2E:-}" in
  1|true|yes|on) : ;;
  *) skip "$C" "set OC_VOICE_E2E=1 to run (first run downloads the wespeaker speaker model)"; exit 0 ;;
esac
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import numpy, torch, pyannote.audio  # noqa
PY
then
  skip "$C.deps" "voice deps missing in $PY (need pyannote.audio torch — run scripts/visual-db-uv.sh --voice)"
  exit 0
fi

CASE=$(case_dir voice_match)
WORK="$SMOKE_DIR/voice_match"; mkdir -p "$WORK"

cond "build two-speaker fixtures (say Alex/Samantha, or OC_VOICE_REF/OC_VOICE_CLIP)"
norm() { "$FFMPEG" -y -v error -i "$1" -ac 1 -ar 16000 -acodec pcm_s16le "$2" 2>/dev/null; }
if [ -n "${OC_VOICE_REF:-}" ] && [ -n "${OC_VOICE_CLIP:-}" ]; then
  norm "$OC_VOICE_REF" "$WORK/spk_a.wav"
  norm "$OC_VOICE_CLIP" "$WORK/spk_b.wav"
  # query = a transcoded offset segment of speaker A (not the enroll head)
  "$FFMPEG" -y -v error -ss 2 -t 6 -i "$WORK/spk_a.wav" -ac 1 -ar 16000 -acodec pcm_s16le "$WORK/query_a.wav" 2>/dev/null
elif have_cmd say; then
  say -v Alex -o "$WORK/alex.aiff" "The quick brown fox jumps over the lazy dog while the investigators compare recordings gathered from several different platforms and public archives." 2>/dev/null || true
  say -v Samantha -o "$WORK/sam.aiff" "Meanwhile a completely different narrator reads an unrelated weather report about scattered showers moving slowly along the northern coastline this evening." 2>/dev/null || true
  say -v Alex -o "$WORK/alex_q.aiff" "Voice prints are compared with cosine similarity over speaker embeddings, never with the raw waveforms themselves." 2>/dev/null || true
  norm "$WORK/alex.aiff" "$WORK/spk_a.wav"
  norm "$WORK/sam.aiff" "$WORK/spk_b.wav"
  norm "$WORK/alex_q.aiff" "$WORK/query_a.wav"
else
  skip "$C.fixtures" "no macOS say and no OC_VOICE_REF/OC_VOICE_CLIP overrides"; exit 0
fi
if [ ! -s "$WORK/spk_a.wav" ] || [ ! -s "$WORK/spk_b.wav" ] || [ ! -s "$WORK/query_a.wav" ]; then
  fail "$C.build" "could not synthesize voice fixtures"; exit 0
fi

cond "enroll both speakers into a local voice-print index"
created="$(oc "$CASE" index create voices --type voice-print --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index" "$IDX" "local voice-print index created"
a="$(OC_TIMEOUT=900 oc "$CASE" voice add "$WORK/spk_a.wav" --index "$IDX" --json)"
save_json "34_add_a" "$a" >/dev/null
assert_eq "$C.add_a" "ready" "$(echo "$a" | jq -r '.state')" "enrolled speaker A"
b="$(OC_TIMEOUT=900 oc "$CASE" voice add "$WORK/spk_b.wav" --index "$IDX" --json)"
assert_eq "$C.add_b" "ready" "$(echo "$b" | jq -r '.state')" "enrolled speaker B"

cond "index search: a fresh speaker-A sample ranks the A member first"
s="$(OC_TIMEOUT=900 oc "$CASE" voice match "$WORK/query_a.wav" --index "$IDX" --min-similarity 0 --json)"
s="$(echo "$s" | primary_rec)"  # drop any auto-suggested finding the persist hook appended
save_json "34_search" "$s" >/dev/null
assert_eq "$C.search_state" "ready" "$(echo "$s" | jq -r '.state')" "voice search ran"
top="$(echo "$s" | jq -r '.payload.matches[0].ref // empty')"
case "$top" in
  *spk_a.wav) ok "$C.search_rank" "speaker-A query ranked the A member first";;
  "") fail "$C.search_rank" "no members matched";;
  *) fail "$C.search_rank" "top match was $top (expected spk_a.wav)";;
esac
assert_nonempty "$C.caveat" "$(echo "$s" | jq -r '.payload.caveat // empty')" "record carries the synthetic-voice caveat"

cond "pairwise: locate speaker A's turn inside a B-then-A concatenation"
"$FFMPEG" -y -v error -i "$WORK/spk_b.wav" -i "$WORK/query_a.wav" \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" -ac 1 -ar 16000 -acodec pcm_s16le "$WORK/both.wav" 2>/dev/null
if [ ! -s "$WORK/both.wav" ]; then fail "$C.concat" "could not build the two-speaker clip"; exit 0; fi
bdur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$WORK/spk_b.wav" 2>/dev/null)"
m="$(OC_TIMEOUT=900 oc "$CASE" voice match "$WORK/both.wav" "$WORK/spk_a.wav" --min-similarity 0 --json)"
m="$(echo "$m" | primary_rec)"
save_json "34_pairwise" "$m" >/dev/null
assert_eq "$C.match_state" "ready" "$(echo "$m" | jq -r '.state')" "pairwise voice match ran"
assert_eq "$C.match_mode" "windowed" "$(echo "$m" | jq -r '.payload.mode')" "default pairwise mode is windowed"
at="$(echo "$m" | jq -r '.payload.matches[0].at // empty')"
if [ -n "$at" ] && awk -v at="$at" -v b="${bdur:-0}" 'BEGIN{exit !(at >= b - 2.0)}'; then
  ok "$C.match_at" "best window at ${at}s falls in speaker A's half (B ends ~${bdur}s)"
else
  fail "$C.match_at" "best window at '${at}' (expected >= ~${bdur}s, speaker A's half)"
fi

cond "--diarize tier (HF_TOKEN gated): diarize-then-match names a speaker"
if [ -z "${HF_TOKEN:-}${HUGGING_FACE_HUB_TOKEN:-}" ]; then
  skip "$C.diarize" "no HF_TOKEN — diarize tier not exercised (windowed default covered above)"
else
  d="$(OC_TIMEOUT=1200 oc "$CASE" voice match "$WORK/both.wav" "$WORK/spk_a.wav" --diarize --min-similarity 0 --json)"
  d="$(echo "$d" | primary_rec)"
  save_json "34_diarize" "$d" >/dev/null
  dstate="$(echo "$d" | jq -r '.state')"
  if [ "$dstate" = "needs_credentials" ]; then
    skip "$C.diarize" "pyannote pipeline gated — accept the license for speaker-diarization-community-1"
  else
    assert_eq "$C.diarize_state" "ready" "$dstate" "diarized match ran"
    assert_eq "$C.diarize_mode" "diarized" "$(echo "$d" | jq -r '.payload.mode')" "diarize tier engaged (not the windowed fallback)"
    assert_nonempty "$C.diarize_speaker" "$(echo "$d" | jq -r '.payload.matches[0].speaker // empty')" "best match names a diarized speaker"
  fi
fi
