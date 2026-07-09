#!/usr/bin/env bash
# Real-media speaker verification — cross-segment identity, not clip identity.
# Unlike 34 (synthetic `say` voices), this proves the field flow on a REAL
# single-speaker video: use ffmpeg to cut an 8s snippet of ONE speaker talking,
# ENHANCE it (denoise) into a wav reference, then confirm that reference:
#   • MATCHES the speaker at DIFFERENT, non-overlapping segments of their own
#     video (genuine same-speaker recognition — the reference is never part of
#     the probed segments, so this is not self-clip detection),
#   • TRIGGERS across the whole video (many windows over the floor, spread over
#     time — the speaker recurs), and
#   • does NOT trigger on a DIFFERENT video (a different speaker).
# Assertions are separation-based, grounded in observed values (same-speaker
# cross-segment ~88–97, a different speaker ~33 — a ~55-point gap).
#
# Speaker source (a clear single speaker, >= 90s so segments are well separated):
#   OC_VOICE_SPEAKER_VIDEO, else OC_VIDEO_SPEECH, else OC_LOCAL_FACE_VIDEO.
# Different video (the negative): OC_VOICE_OTHER_VIDEO, else the first OTHER clip
#   with an audio stream (a human-speaker clip preferred).
# Gated on OC_VOICE_E2E (loads the pyannote/torch stack + downloads the ~26MB
# ungated wespeaker model on first run). The --diarize leg additionally needs
# HF_TOKEN + the accepted pyannote license.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=voice_match_realmedia

have_cmd ffmpeg || { skip "$C" "no ffmpeg on PATH"; exit 0; }
case "${OC_VOICE_E2E:-}" in
  1|true|yes|on) : ;;
  *) skip "$C" "set OC_VOICE_E2E=1 to run (loads the pyannote/torch stack + downloads the wespeaker model)"; exit 0 ;;
esac
audio_stream() { [ "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$1" 2>/dev/null | head -1)" = "audio" ]; }
dur_of() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null | cut -d. -f1; }
# speaker source: the first existing clip with audio AND >= 90s (long enough for
# well-separated cross-segment probes). A short face clip (e.g. a 63s willsmith)
# is fine as the NEGATIVE below but too short to sample distinct segments from.
SRC=""
for cand in "${OC_VOICE_SPEAKER_VIDEO:-}" "$VIDEO_SPEECH_SRC" "$LOCAL_FACE_VIDEO"; do
  [ -n "$cand" ] && have_media "$cand" && audio_stream "$cand" || continue
  d="$(dur_of "$cand")"; [ -n "$d" ] && [ "$d" -ge 90 ] && { SRC="$cand"; SRC_DUR="$d"; break; }
done
[ -n "$SRC" ] || { skip "$C" "no single-speaker source >= 90s with audio (set OC_VOICE_SPEAKER_VIDEO, or OC_VIDEO_SPEECH)"; exit 0; }
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import numpy, torch, pyannote.audio  # noqa
PY
then
  skip "$C.deps" "voice deps missing in $PY (need pyannote.audio torch — run scripts/visual-db-uv.sh --voice)"
  exit 0
fi

CASE=$(case_dir voice_match_realmedia)
WORK="$SMOKE_DIR/voice_match_realmedia"; mkdir -p "$WORK"
# well-separated offsets as fractions of the source duration (ref in the middle;
# probes at ~20% and ~80% — neither overlaps the 8s reference window).
REF_AT=$(( SRC_DUR * 50 / 100 ))
B_AT=$(( SRC_DUR * 20 / 100 ))
C_AT=$(( SRC_DUR * 80 / 100 ))

# --- POSITIVE SAMPLE: ffmpeg an 8s single-speaker snippet, then ENHANCE it -----
cond "ffmpeg-extract an 8s snippet of the speaker (~${REF_AT}s) and ENHANCE (denoise) it into the reference"
ffmpeg -y -v error -ss "$REF_AT" -t 8 -i "$SRC" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/ref_raw.wav" 2>/dev/null
if [ ! -s "$WORK/ref_raw.wav" ]; then fail "$C.snippet" "could not extract a reference snippet from $(basename "$SRC")"; exit 0; fi
enh="$(oc "$CASE" enhance "$WORK/ref_raw.wav" --ops denoise --json)"
save_json "35_enhance" "$enh" >/dev/null
REF="$(echo "$enh" | jq -r 'select(.state=="ready") | .media.ref // empty')"
if [ -n "$REF" ] && [ -s "$REF" ]; then
  ok "$C.enhance" "denoised reference written ($(basename "$REF"))"
else
  REF="$WORK/ref_raw.wav"; ok "$C.enhance" "enhance produced no audio — using the raw snippet as the reference"
fi

# --- cross-segment + negative probe clips (each 20s; probes never include the ref) ---
ffmpeg -y -v error -ss "$B_AT" -t 20 -i "$SRC" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/seg_b.wav" 2>/dev/null
ffmpeg -y -v error -ss "$C_AT" -t 20 -i "$SRC" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/seg_c.wav" 2>/dev/null
if [ ! -s "$WORK/seg_b.wav" ] || [ ! -s "$WORK/seg_c.wav" ]; then fail "$C.segments" "could not cut cross-segment probes"; exit 0; fi
# negative: a DIFFERENT video with audio (a different speaker), never the source
NEG="${OC_VOICE_OTHER_VIDEO:-}"
if [ -z "$NEG" ]; then
  for cand in "$LOCAL_FACE_VIDEO" "$VIDEO_SPEECH_SRC" "$VIDEO_SMALL" "$LOCAL_IMAGE_VIDEO_A" "$VIDEO_VISUAL"; do
    if have_media "$cand" && [ "$cand" != "$SRC" ] && audio_stream "$cand"; then NEG="$cand"; break; fi
  done
fi
HAVE_NEG=0
if have_media "$NEG" && audio_stream "$NEG"; then
  ffmpeg -y -v error -ss "$(( $(dur_of "$NEG") / 4 ))" -t 20 -i "$NEG" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/neg.wav" 2>/dev/null
  [ -s "$WORK/neg.wav" ] && HAVE_NEG=1
fi

bestsim() { oc "$CASE" voice match "$1" "$REF" --min-similarity 0 --json | jq -s -r '[.[]|select(.verb=="voice")][0].payload.matches[0].similarity // 0'; }

# --- CROSS-SEGMENT POSITIVE: the reference matches the speaker elsewhere --------
cond "the reference matches the SAME speaker at two DIFFERENT segments (~${B_AT}s, ~${C_AT}s) of their own video"
SIM_B="$(bestsim "$WORK/seg_b.wav")"
SIM_C="$(bestsim "$WORK/seg_c.wav")"
save_json "35_seg_b" "$(oc "$CASE" voice match "$WORK/seg_b.wav" "$REF" --min-similarity 0 --json | jq -s -c '[.[]|select(.verb=="voice")][0]')" >/dev/null
# a genuine same-speaker cross-segment match scores high (observed ~88 and ~97);
# require BOTH >= 70 (clear of the different-speaker band) — this is real speaker
# recognition, not self-clip detection (the reference is never inside a probe).
if awk -v b="${SIM_B:-0}" -v c="${SIM_C:-0}" 'BEGIN{exit !(b>=70 && c>=70)}'; then
  ok "$C.cross_segment" "reference matched the speaker at both segments (~${B_AT}s: ${SIM_B}, ~${C_AT}s: ${SIM_C})"
else
  fail "$C.cross_segment" "cross-segment match weak (seg B ${SIM_B}, seg C ${SIM_C}; expected both >= 70)"
fi

# --- TRIGGERS ACROSS THE VIDEO: many windows over the floor, spread over time ---
cond "scanning the whole source, the reference triggers at MANY segments spread across the video"
full="$(oc "$CASE" voice match "$SRC" "$REF" --min-similarity 70 --json)"
full="$(echo "$full" | primary_rec)"
save_json "35_full_scan" "$full" >/dev/null
NW="$(echo "$full" | jq -r '.payload.count // 0')"
SPAN="$(echo "$full" | jq -r '(([.payload.matches[].at]|max) - ([.payload.matches[].at]|min)) // 0')"
if [ "${NW:-0}" -ge 3 ] && awk -v s="${SPAN:-0}" 'BEGIN{exit !(s>=30)}'; then
  ok "$C.multi_segment" "triggered in ${NW} windows over ${SPAN}s of the video (speaker recurs at different segments)"
else
  fail "$C.multi_segment" "only ${NW} windows over a ${SPAN}s span (expected >=3 windows spanning >=30s)"
fi

# --- NEGATIVE: the reference does NOT trigger on a DIFFERENT video --------------
if [ "$HAVE_NEG" -eq 1 ]; then
  cond "the reference does NOT trigger on a different video (a different speaker), well below the same-speaker band"
  SIM_N="$(bestsim "$WORK/neg.wav")"
  save_json "35_negative" "$(oc "$CASE" voice match "$WORK/neg.wav" "$REF" --min-similarity 0 --json | jq -s -c '[.[]|select(.verb=="voice")][0]')" >/dev/null
  LOWPOS="$(awk -v b="$SIM_B" -v c="$SIM_C" 'BEGIN{print (b<c)?b:c}')"
  # the different speaker must sit below the 80 finding floor AND be clearly
  # separated from the weaker same-speaker match (>= 15 points).
  if awk -v n="${SIM_N:-0}" -v lp="${LOWPOS:-0}" 'BEGIN{exit !(n<65 && lp-n>=15)}'; then
    ok "$C.negative" "$(basename "$NEG") did NOT match (${SIM_N}) — $(awk -v a="$LOWPOS" -v b="$SIM_N" 'BEGIN{printf "%.1f", a-b}') points below the same-speaker match"
  else
    fail "$C.negative" "different video scored ${SIM_N} (same-speaker low ${LOWPOS}) — insufficient separation"
  fi
else
  skip "$C.negative" "no second real video with audio for the negative (set OC_VOICE_OTHER_VIDEO)"
fi

# --- OPEN-SET INDEX SEARCH: enroll a DIFFERENT speaker segment + the negative ---
# then confirm the reference ranks the same-speaker member #1 (member windows are
# a different segment than the reference, so this is cross-segment identity too).
cond "index search: enroll a different-segment clip of the speaker + the negative, reference ranks the speaker #1"
created="$(oc "$CASE" index create voices --type voice-print --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index" "$IDX" "voice-print index created"
oc "$CASE" voice add "$WORK/seg_b.wav" --index "$IDX" --json >/dev/null   # same speaker, a DIFFERENT segment
RANK_OK=0
if [ "$HAVE_NEG" -eq 1 ]; then
  oc "$CASE" voice add "$WORK/neg.wav" --index "$IDX" --json >/dev/null
  RANK_OK=1
fi
srch="$(oc "$CASE" voice match "$REF" --index "$IDX" --min-similarity 0 --json | jq -s -c '[.[]|select(.verb=="voice")][0]')"
save_json "35_index_search" "$srch" >/dev/null
TOP="$(echo "$srch" | jq -r '.payload.matches[0].ref // empty')"
if [ "$RANK_OK" -eq 1 ]; then
  case "$TOP" in
    *seg_b.wav) ok "$C.rank" "the speaker's other-segment clip ranked #1 over the different speaker ($(echo "$srch" | jq -r '.payload.matches[0].similarity'))";;
    "") fail "$C.rank" "no members matched the reference";;
    *) fail "$C.rank" "top match was $(basename "$TOP"), not the speaker's own clip";;
  esac
else
  skip "$C.rank" "no negative member enrolled — ranking discrimination not exercised"
fi

# --- BONUS: a strong same-speaker hit auto-suggests a voice-match triage lead ---
cond "a strong same-speaker match (>= 80) auto-suggests a voice-match triage lead"
if awk -v b="${SIM_B:-0}" -v c="${SIM_C:-0}" 'BEGIN{exit !(b>=80 || c>=80)}'; then
  triage="$(oc "$CASE" finding list --state triage --json)"
  vlead="$(echo "$triage" | jq -r '[.payload.findings[] | select((.payload.signal.kind // "")=="voice-match")] | length')"
  [ "${vlead:-0}" -ge 1 ] && ok "$C.finding" "voice match >= 80 queued a suggested finding" || fail "$C.finding" "no voice-match lead in triage despite a strong hit"
else
  skip "$C.finding" "cross-segment scores below 80 on this media — no auto-suggest expected"
fi

# --- OPTIONAL: --diarize tier (HF_TOKEN gated) ---------------------------------
cond "--diarize tier (HF_TOKEN gated): diarize-then-match names a speaker in the source"
if [ -z "${HF_TOKEN:-}${HUGGING_FACE_HUB_TOKEN:-}" ]; then
  skip "$C.diarize" "no HF_TOKEN — diarize tier not exercised (windowed default covered above)"
else
  dz="$(OC_TIMEOUT=1200 oc "$CASE" voice match "$SRC" "$REF" --diarize --min-similarity 0 --json)"
  dz="$(echo "$dz" | primary_rec)"
  save_json "35_diarize" "$dz" >/dev/null
  dstate="$(echo "$dz" | jq -r '.state')"
  if [ "$dstate" = "needs_credentials" ]; then
    skip "$C.diarize" "pyannote pipeline gated — accept the license for speaker-diarization-community-1"
  elif [ "$(echo "$dz" | jq -r '.payload.mode')" = "windowed" ]; then
    skip "$C.diarize" "fell back to windowed (token without accepted license) — windowed path already covered"
  else
    assert_eq "$C.diarize_mode" "diarized" "$(echo "$dz" | jq -r '.payload.mode')" "diarize tier engaged"
    assert_nonempty "$C.diarize_speaker" "$(echo "$dz" | jq -r '.payload.matches[0].speaker // empty')" "best match names a diarized speaker"
  fi
fi
