#!/usr/bin/env bash
# Real enhance --ops separate: split a multi-speaker clip into per-speaker tracks
# via fal sam-audio (FAL_KEY) and/or local pyannote (venv + HF_TOKEN). Verifies the
# multi-output fan-out (one track record per output) and --summarize.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=separate

# a clip with speech: prefer the small clip, else a speech source, else audio.
CLIP="$SMOKE_DIR/sep_clip.mp4"
SRC="$VIDEO_SPEECH_SRC"; have_media "$SRC" || SRC="$VIDEO_SMALL"
if have_media "$SRC"; then
  clip_av 15 "$SRC" "$CLIP" || CLIP="$SRC"
elif have_media "$AUDIO_FILE"; then
  CLIP="$AUDIO_FILE"
fi
[ -f "$CLIP" ] || { skip "$C" "no speech/audio media (OC_VIDEO_SPEECH/OC_VIDEO_SMALL/OC_AUDIO)"; exit 0; }

# ---- fal sam-audio (text-prompted) -----------------------------------------
if require_cred "$C.fal" FAL_KEY "skipping fal separate"; then
  CASE=$(case_dir separate_fal)
  FE="$PWD/examples/providers/fal/enhance.sh"
  ocrun "$CASE" setup provider enhance "exec:bash $FE {{input}}" --json >/dev/null 2>&1
  cond "fal sam-audio splits a prompted voice into target + residual tracks"
  out="$(OC_TIMEOUT=420 oc "$CASE" enhance "$CLIP" --ops separate --prompt "the main speaker" --json)"
  save_json "18_separate_fal" "$out" >/dev/null
  pst="$(echo "$out" | jq -s -r '.[0].state')"
  ntrack="$(echo "$out" | jq -s '[.[] | select(.payload.kind=="track")] | length')"
  if [ "$pst" = "ready" ] && [ "${ntrack:-0}" -ge 1 ]; then
    ok "$C.fal.tracks" "$ntrack track record(s) from sam-audio"
    miss=0; while IFS= read -r ref; do [ -f "$ref" ] || miss=1; done < <(echo "$out" | jq -s -r '.[] | select(.payload.kind=="track") | .media.ref')
    [ "$miss" = 0 ] && ok "$C.fal.files" "track files written" || fail "$C.fal.files" "a track media file is missing"
  else
    fail "$C.fal.tracks" "state=$pst tracks=$ntrack err=$(echo "$out"|jq -s -r '.[0].error // empty'|head -c 100)"
  fi
fi

# ---- local pyannote (diarization) ------------------------------------------
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import pyannote.audio, torch  # noqa
PY
then
  skip "$C.local" "pyannote deps missing in $PY (scripts/visual-db-uv.sh --voice)"
  exit 0
fi
if ! require_cred "$C.local" HF_TOKEN "pyannote is gated — accept the license + set HF_TOKEN"; then exit 0; fi

CASE=$(case_dir separate_local)
LE="$PWD/examples/providers/local/enhance.sh"
ocrun "$CASE" setup provider enhance "exec:bash $LE {{input}}" --json >/dev/null 2>&1
cond "local pyannote diarization renders one timeline-preserving track per speaker (+ --summarize)"
out="$(OC_TIMEOUT=600 oc "$CASE" enhance "$CLIP" --ops separate --summarize --json)"
save_json "18_separate_local" "$out" >/dev/null
pst="$(echo "$out" | jq -s -r '.[0].state')"
ntrack="$(echo "$out" | jq -s '[.[] | select(.payload.kind=="track")] | length')"
if [ "$pst" = "ready" ] && [ "${ntrack:-0}" -ge 1 ]; then
  ok "$C.local.tracks" "$ntrack per-speaker track(s) from pyannote"
  hasseg="$(echo "$out" | jq -s '[.[] | select(.payload.kind=="track") | select(.payload.segments|length>0)] | length')"
  [ "${hasseg:-0}" -ge 1 ] && ok "$C.local.segments" "tracks carry speaker segments" || fail "$C.local.segments" "no segments on any track"
else
  fail "$C.local.tracks" "state=$pst tracks=$ntrack err=$(echo "$out"|jq -s -r '.[0].error // empty'|head -c 120)"
fi
