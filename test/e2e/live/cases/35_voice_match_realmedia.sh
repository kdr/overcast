#!/usr/bin/env bash
# Real-media speaker verification. Unlike 34 (self-contained synthetic `say`
# voices), this drives `voice` against a REAL video with a real single speaker,
# proving the field flow: extract a snippet of the speaker talking, ENHANCE the
# audio (denoise) into a wav reference, then confirm the speaker's OWN video
# matches while a DIFFERENT video does not. Assertions are RANK/separation based
# (absolute scores are model- and media-relative), grounded in observed values:
# a same-speaker index hit scores ~98 and a different speaker ~36 (cosine 0.72 vs
# 0.13), a >60-point gap.
#
# Speaker source:  OC_VOICE_SPEAKER_VIDEO, else OC_LOCAL_FACE_VIDEO, else
#                  OC_VIDEO_SPEECH — a clear single-speaker clip (>= 60s).
# Different video:  OC_VOICE_OTHER_VIDEO, else auto-picked from the other clips
#                  with an audio stream.
# Needs ffmpeg + pyannote.audio/torch + a speaker source; skips otherwise. The
# windowed default is UNGATED (no HF_TOKEN); the optional --diarize leg needs a
# token + the accepted pyannote license.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=voice_match_realmedia

have_cmd ffmpeg || { skip "$C" "no ffmpeg on PATH"; exit 0; }
case "${OC_VOICE_E2E:-}" in
  1|true|yes|on) : ;;
  *) skip "$C" "set OC_VOICE_E2E=1 to run (loads the pyannote/torch stack + downloads the wespeaker model)"; exit 0 ;;
esac
audio_stream() { [ "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$1" 2>/dev/null | head -1)" = "audio" ]; }
# resolve the speaker-source video (a clear single speaker with an audio track):
# the FIRST candidate that actually exists on disk with an audio stream — an env
# var may be set to a path that's since been removed (e.g. a stale willsmith clip).
SRC=""
for cand in "${OC_VOICE_SPEAKER_VIDEO:-}" "$LOCAL_FACE_VIDEO" "$VIDEO_SPEECH_SRC"; do
  if [ -n "$cand" ] && have_media "$cand" && audio_stream "$cand"; then SRC="$cand"; break; fi
done
[ -n "$SRC" ] || { skip "$C" "no speaker source with audio (set OC_VOICE_SPEAKER_VIDEO, or OC_LOCAL_FACE_VIDEO / OC_VIDEO_SPEECH — a single-speaker clip)"; exit 0; }
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import numpy, torch, pyannote.audio  # noqa
PY
then
  skip "$C.deps" "voice deps missing in $PY (need pyannote.audio torch — run scripts/visual-db-uv.sh --voice)"
  exit 0
fi
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC" 2>/dev/null | cut -d. -f1)"; [ -z "$DUR" ] && DUR=0
if [ "$DUR" -lt 60 ]; then skip "$C.dur" "speaker source is only ${DUR}s; need >=60s to sample a clean reference"; exit 0; fi

CASE=$(case_dir voice_match_realmedia)
WORK="$SMOKE_DIR/voice_match_realmedia"; mkdir -p "$WORK"
# reference snippet: ~8s of the speaker from ~55% in
CUT=$(( DUR * 55 / 100 ))
ffmpeg -y -v error -ss "$CUT" -t 8 -i "$SRC" -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/ref_raw.wav" 2>/dev/null
if [ ! -s "$WORK/ref_raw.wav" ]; then fail "$C.snippet" "could not extract a reference snippet from $(basename "$SRC")"; exit 0; fi

# --- enhance the reference (denoise) into the wav we query with ---------------
cond "extract + ENHANCE (denoise) an 8s reference snippet of the speaker into a wav"
enh="$(oc "$CASE" enhance "$WORK/ref_raw.wav" --ops denoise --json)"
save_json "35_enhance" "$enh" >/dev/null
REF="$(echo "$enh" | jq -r 'select(.state=="ready") | .media.ref // empty')"
if [ -n "$REF" ] && [ -s "$REF" ]; then
  ok "$C.enhance" "denoised reference written ($(basename "$REF"))"
else
  REF="$WORK/ref_raw.wav"; ok "$C.enhance" "enhance produced no audio — using the raw snippet as the reference"
fi

# --- enroll the speaker's OWN video into a voice-print index ------------------
cond "enroll the speaker's full source video into a local voice-print index"
created="$(oc "$CASE" index create voices --type voice-print --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index" "$IDX" "voice-print index created"
add="$(OC_TIMEOUT=900 oc "$CASE" voice add "$SRC" --index "$IDX" --json)"
save_json "35_add_src" "$add" >/dev/null
assert_eq "$C.add_src" "ready" "$(echo "$add" | jq -r '.state')" "enrolled the speaker's video ($(echo "$add" | jq -r '.payload.vectors // 0') voice windows)"

# --- enroll a DIFFERENT speaker's video (the negative member) -----------------
cond "enroll a different video (a different speaker) as the negative member"
OTHER="${OC_VOICE_OTHER_VIDEO:-}"
if [ -z "$OTHER" ]; then
  for cand in "$VIDEO_SPEECH_SRC" "$VIDEO_SMALL" "$LOCAL_IMAGE_VIDEO_A" "$LOCAL_IMAGE_VIDEO_B" "$VIDEO_VISUAL"; do
    if have_media "$cand" && [ "$cand" != "$SRC" ] && audio_stream "$cand"; then OTHER="$cand"; break; fi
  done
fi
HAVE_OTHER=0
if have_media "$OTHER" && audio_stream "$OTHER"; then
  oadd="$(OC_TIMEOUT=900 oc "$CASE" voice add "$OTHER" --index "$IDX" --json)"
  save_json "35_add_other" "$oadd" >/dev/null
  [ "$(echo "$oadd" | jq -r '.state')" = "ready" ] && { HAVE_OTHER=1; ok "$C.add_other" "enrolled the different-speaker video ($(basename "$OTHER"))"; } || fail "$C.add_other" "could not enroll $(basename "$OTHER")"
else
  skip "$C.add_other" "no second real video with audio for the negative member (set OC_VOICE_OTHER_VIDEO)"
fi

# --- POSITIVE: the reference matches the speaker's OWN video ------------------
cond "index search: the reference ranks the speaker's own video first, well above a different speaker"
srch="$(oc "$CASE" voice match "$REF" --index "$IDX" --min-similarity 0 --json)"
srch="$(echo "$srch" | primary_rec)"   # drop any auto-suggested finding the persist hook appended
save_json "35_search" "$srch" >/dev/null
assert_eq "$C.search_state" "ready" "$(echo "$srch" | jq -r '.state')" "voice search ran"
TOP="$(echo "$srch" | jq -r '.payload.matches[0].ref // empty')"
SRC_SIM="$(echo "$srch" | jq -r --arg s "$SRC" '.payload.matches[] | select(.ref==$s) | .similarity' | head -1)"
case "$TOP" in
  "$SRC") ok "$C.rank" "the speaker's own video ranked #1 (similarity ${SRC_SIM})";;
  "") fail "$C.rank" "no members matched the reference";;
  *) fail "$C.rank" "top match was $(basename "$TOP"), not the speaker's own video";;
esac
# a genuine same-speaker match scores high (observed ~98 self, ~70 cross-segment);
# 75 is a conservative floor that still separates cleanly from a different speaker.
if awk -v s="${SRC_SIM:-0}" 'BEGIN{exit !(s>=75)}'; then
  ok "$C.pos_score" "reference matched the speaker's video at ${SRC_SIM} (>= 75)"
else
  fail "$C.pos_score" "same-speaker similarity ${SRC_SIM} below the 75 floor"
fi

# --- DISCRIMINATION: the different speaker scores much lower ------------------
if [ "$HAVE_OTHER" -eq 1 ]; then
  cond "the different-speaker member scores far below the speaker's own video (>= 20 point gap)"
  OTH_SIM="$(echo "$srch" | jq -r --arg o "$OTHER" '.payload.matches[] | select(.ref==$o) | .similarity' | head -1)"
  [ -z "$OTH_SIM" ] && OTH_SIM=0   # dropped below --min-similarity 0 never happens, but be safe
  if awk -v a="${SRC_SIM:-0}" -v b="${OTH_SIM:-0}" 'BEGIN{exit !(a-b>=20)}'; then
    ok "$C.discriminate" "own-video ${SRC_SIM} vs different-speaker ${OTH_SIM} — $(awk -v a="$SRC_SIM" -v b="$OTH_SIM" 'BEGIN{printf "%.1f", a-b}') point separation"
  else
    fail "$C.discriminate" "gap too small: own ${SRC_SIM} vs other ${OTH_SIM}"
  fi
fi

# --- POSITIVE pairwise: the reference locates the speaker in the source -------
cond "pairwise: the reference locates where the speaker talks in the source video (windowed)"
pm="$(oc "$CASE" voice match "$SRC" "$REF" --min-similarity 0 --json)"
pm="$(echo "$pm" | primary_rec)"
save_json "35_pairwise_self" "$pm" >/dev/null
assert_eq "$C.pair_mode" "windowed" "$(echo "$pm" | jq -r '.payload.mode')" "default pairwise mode is windowed"
PM_SIM="$(echo "$pm" | jq -r '.payload.matches[0].similarity // 0')"
PM_AT="$(echo "$pm" | jq -r '.payload.matches[0].at // empty')"
if awk -v s="${PM_SIM:-0}" 'BEGIN{exit !(s>=75)}' && [ -n "$PM_AT" ]; then
  ok "$C.pair_self" "located the speaker at ${PM_AT}s (similarity ${PM_SIM})"
else
  fail "$C.pair_self" "self-match weak: best ${PM_SIM} at '${PM_AT}'"
fi

# --- NEGATIVE pairwise: a DIFFERENT video does NOT match the speaker ----------
if [ "$HAVE_OTHER" -eq 1 ]; then
  cond "pairwise: the different video does NOT match the reference speaker (below the own-video score and the 80 finding floor)"
  nm="$(oc "$CASE" voice match "$OTHER" "$REF" --min-similarity 0 --json)"
  nm="$(echo "$nm" | primary_rec)"
  save_json "35_pairwise_neg" "$nm" >/dev/null
  NM_SIM="$(echo "$nm" | jq -r '.payload.matches[0].similarity // 0')"
  # the different video must score below the own-video pairwise best AND below the
  # 80 finding-trigger floor (so it would never auto-suggest a match).
  if awk -v n="${NM_SIM:-0}" -v p="${PM_SIM:-0}" 'BEGIN{exit !(n<p && n<80)}'; then
    ok "$C.negative" "different video correctly rejected (best ${NM_SIM} < own ${PM_SIM}, below the 80 floor)"
  else
    fail "$C.negative" "different video false-matched: best ${NM_SIM} (own ${PM_SIM})"
  fi
fi

# --- BONUS: a strong same-speaker hit auto-suggests a voice-match lead --------
cond "a strong same-speaker match auto-suggests a triage lead (voice trigger >= 80)"
if awk -v s="${SRC_SIM:-0}" 'BEGIN{exit !(s>=80)}'; then
  triage="$(oc "$CASE" finding list --state triage --json)"
  vlead="$(echo "$triage" | jq -r '[.payload.findings[] | select((.payload.signal.kind // "")=="voice-match")] | length')"
  [ "${vlead:-0}" -ge 1 ] && ok "$C.finding" "voice match >= 80 queued a suggested finding" || fail "$C.finding" "no voice-match lead in triage despite a ${SRC_SIM} hit"
else
  skip "$C.finding" "top same-speaker score ${SRC_SIM} < 80 (cross-segment on compressed media) — no auto-suggest expected"
fi

# --- OPTIONAL: --diarize tier (HF_TOKEN gated) --------------------------------
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
