#!/usr/bin/env bash
# Local CLAP audio-embedding DB (`basic-clap`) — audio->audio similarity +
# text->audio search over a local vector index. Self-contained: synthesizes a
# tonal clip A and a noise clip B, embeds both, then queries with a different
# segment of A (top match must be A, not B) and a free-text query. HARD-GATED on
# OC_CLAP_E2E=1 because the first run downloads ~776MB of model weights — never
# implicitly in CI. Assertions are RANK/shape based (synthetic audio has no
# meaningful absolute CLAP scores).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=clap_db

have_cmd ffmpeg || { skip "$C" "no ffmpeg on PATH"; exit 0; }
case "${OC_CLAP_E2E:-}" in
  1|true|yes|on) : ;;
  *) skip "$C" "set OC_CLAP_E2E=1 to run (first run downloads ~776MB CLAP weights)"; exit 0 ;;
esac
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import numpy, torch, transformers  # noqa
PY
then
  skip "$C.deps" "CLAP deps missing in $PY (need transformers torch — run scripts/visual-db-uv.sh --clap)"
  exit 0
fi

CASE=$(case_dir clap_db)
WORK="$SMOKE_DIR/clap_db"; mkdir -p "$WORK"

cond "embed a tonal clip and a noise clip into a local basic-clap index"
"$FFMPEG" -y -v error -f lavfi -i "aevalsrc=0.5*sin(2*PI*440*t)+0.3*sin(2*PI*660*t):s=48000:d=20" -c:a pcm_s16le "$WORK/tone.wav" 2>/dev/null
"$FFMPEG" -y -v error -f lavfi -i "anoisesrc=color=pink:seed=11:amplitude=0.5:d=20:s=48000" -c:a pcm_s16le "$WORK/noise.wav" 2>/dev/null
"$FFMPEG" -y -v error -ss 10 -t 8 -i "$WORK/tone.wav" -c:a aac "$WORK/tone_q.m4a" 2>/dev/null
if [ ! -s "$WORK/tone.wav" ] || [ ! -s "$WORK/noise.wav" ]; then fail "$C.build" "ffmpeg could not synthesize audio fixtures"; exit 0; fi
created="$(oc "$CASE" index create sounds --type basic-clap --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index" "$IDX" "local basic-clap index created"
a="$(OC_TIMEOUT=600 oc "$CASE" similar add "$WORK/tone.wav" --index "$IDX" --json)"
save_json "29_add_tone" "$a" >/dev/null
assert_eq "$C.add_tone" "ready" "$(echo "$a" | jq -r '.state')" "embedded the tonal clip"
b="$(OC_TIMEOUT=600 oc "$CASE" similar add "$WORK/noise.wav" --index "$IDX" --json)"
assert_eq "$C.add_noise" "ready" "$(echo "$b" | jq -r '.state')" "embedded the noise clip"

cond "audio->audio: a segment of the tonal clip ranks the tonal member above the noise member"
m="$(OC_TIMEOUT=600 oc "$CASE" similar match "$WORK/tone_q.m4a" --index "$IDX" --json)"
save_json "29_match" "$m" >/dev/null
assert_eq "$C.match_state" "ready" "$(echo "$m" | jq -r '.state')" "audio match ran"
top="$(echo "$m" | jq -r '.payload.matches[0].ref // empty')"
case "$top" in *tone.wav) ok "$C.match_rank" "tonal query ranked the tonal member first";; "") fail "$C.match_rank" "no matches returned";; *) fail "$C.match_rank" "top match was $top (expected tone.wav)";; esac

cond "text->audio search returns a well-formed ranked result set"
s="$(OC_TIMEOUT=600 oc "$CASE" similar search "a steady musical tone" --index "$IDX" --json)"
save_json "29_search" "$s" >/dev/null
assert_eq "$C.search_state" "ready" "$(echo "$s" | jq -r '.state')" "text search ran"
n="$(echo "$s" | jq -r '.payload.matches | length')"
[ "${n:-0}" -ge 1 ] && ok "$C.search_shape" "search returned $n ranked match(es)" || fail "$C.search_shape" "search returned no matches"
