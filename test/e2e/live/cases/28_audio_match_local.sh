#!/usr/bin/env bash
# Local Shazam-style audio fingerprint matching — the CORE with no external
# source and no API creds. Synthesize a spectrally-rich FM-chirp "original",
# fingerprint it into a local audio-fp index (as a VIDEO, proving audio-track
# extraction), then a transcoded+noised+clipped COPY of an 8s segment and an
# UNRELATED chirp. Assert the matcher CONFIRMS the copy at the right time offset
# and REJECTS the unrelated clip — indexed AND clip-to-clip (pairwise) — then
# showcases it as a finding + note + brief. Needs only ffmpeg + numpy/scipy;
# skips otherwise. Deterministic (no pure sine tones, seeded noise).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=audio_match_local

have_cmd ffmpeg || { skip "$C" "no ffmpeg on PATH"; exit 0; }
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import numpy, scipy.signal, scipy.ndimage  # noqa
PY
then
  skip "$C.deps" "audio fingerprint deps missing in $PY (need numpy scipy — run scripts/visual-db-uv.sh --audio)"
  exit 0
fi

CASE=$(case_dir audio_match_local)
WORK="$SMOKE_DIR/audio_match_local"; mkdir -p "$WORK"

# spectrally-rich, non-stationary signals (3 FM tones) — a pure sine would smear
# the offset histogram; these give a dense, unambiguous constellation.
ORIG_EXPR='0.5*sin(2*PI*(300+120*sin(2*PI*0.31*t))*t)+0.3*sin(2*PI*(800+250*sin(2*PI*0.13*t))*t)+0.2*sin(2*PI*(1500+400*sin(2*PI*0.07*t))*t)'
UNREL_EXPR='0.5*sin(2*PI*(520+200*sin(2*PI*0.5*t))*t)+0.3*sin(2*PI*(2200+300*sin(2*PI*0.23*t))*t)'

# --- synthesize the original (30s) and mux it under video → original.mp4 -------
cond "fingerprint a synthesized original (as a VIDEO member) into a local audio-fp index"
"$FFMPEG" -y -v error -f lavfi -i "aevalsrc=${ORIG_EXPR}:s=44100:d=30" -c:a pcm_s16le "$WORK/original.wav" 2>/dev/null
"$FFMPEG" -y -v error -f lavfi -i "testsrc=size=320x240:rate=10:d=30" -i "$WORK/original.wav" \
  -c:v libx264 -preset veryfast -c:a aac -shortest "$WORK/original.mp4" 2>/dev/null
if [ ! -s "$WORK/original.mp4" ]; then fail "$C.build" "ffmpeg could not synthesize the original clip"; exit 0; fi
created="$(oc "$CASE" index create jingles --type audio-fp --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index" "$IDX" "local audio-fp index created"
add="$(oc "$CASE" audio add "$WORK/original.mp4" --to "$IDX" --json)"
save_json "28_add" "$add" >/dev/null
assert_eq "$C.add_state" "ready" "$(echo "$add" | jq -r '.state')" "fingerprinted the original video's audio track"
hashes="$(echo "$add" | jq -r '.payload.hashes // 0')"
[ "${hashes:-0}" -ge 50 ] && ok "$C.add_hashes" "constellation built ($hashes hashes)" || fail "$C.add_hashes" "too few hashes ($hashes) — weak fingerprint"

# --- a transcoded + noised + clipped COPY of the 12s..20s segment → CONFIRM ----
cond "a transcoded/noised/volume-shifted copy of the 12s segment is CONFIRMED at offset ~12s"
"$FFMPEG" -y -v error -ss 12 -t 8 -i "$WORK/original.wav" \
  -f lavfi -i "anoisesrc=color=pink:seed=7:amplitude=0.08:d=8:s=48000" \
  -filter_complex "[0]aresample=48000,volume=0.8[a];[a][1]amix=inputs=2:duration=shortest" \
  -c:a aac "$WORK/copy.m4a" 2>/dev/null
if [ ! -s "$WORK/copy.m4a" ]; then fail "$C.copy_build" "ffmpeg could not build the copy clip"; exit 0; fi
mr="$(oc "$CASE" audio match "$WORK/copy.m4a" --index "$IDX" --json)"
mr="$(echo "$mr" | primary_rec)"  # drop any auto-suggested finding the persist hook appended
save_json "28_match_copy" "$mr" >/dev/null
assert_eq "$C.copy_state" "ready" "$(echo "$mr" | jq -r '.state')" "copy match ran"
rc="$(echo "$mr" | jq -r '.payload.count // 0')"
if [ "${rc:-0}" -ge 1 ]; then
  ref="$(echo "$mr" | jq -r '.payload.matches[0].ref')"
  votes="$(echo "$mr" | jq -r '.payload.matches[0].aligned_votes')"
  offset="$(echo "$mr" | jq -r '.payload.matches[0].offset_seconds')"
  case "$ref" in *original.mp4) ok "$C.copy_ref" "matched the original ($votes aligned votes)";; *) fail "$C.copy_ref" "matched the wrong member: $ref";; esac
  if awk -v o="$offset" 'BEGIN{d=o-12; if(d<0)d=-d; exit !(d<=0.6)}'; then
    ok "$C.copy_offset" "aligned at offset ${offset}s (expected ~12s)"
  else
    fail "$C.copy_offset" "offset ${offset}s not within 12±0.6s"
  fi
else
  fail "$C.copy_confirmed" "copy produced 0 confident matches (expected >=1)"
fi

# --- an UNRELATED chirp must be REJECTED (0 matches) ---------------------------
cond "an unrelated chirp is REJECTED (0 confident matches — no false positive)"
"$FFMPEG" -y -v error -f lavfi -i "aevalsrc=${UNREL_EXPR}:s=44100:d=10" -c:a aac "$WORK/unrelated.m4a" 2>/dev/null
mu="$(oc "$CASE" audio match "$WORK/unrelated.m4a" --index "$IDX" --json)"
mu="$(echo "$mu" | primary_rec)"  # drop any auto-suggested finding the persist hook appended
save_json "28_match_unrelated" "$mu" >/dev/null
uc="$(echo "$mu" | jq -r '.payload.count // 0')"
[ "${uc:-0}" -eq 0 ] && ok "$C.unrelated_rejected" "unrelated clip correctly rejected (0 matches)" || fail "$C.unrelated_rejected" "unrelated clip false-matched $uc time(s)"

# --- clip-to-clip (pairwise) — confirm the copy, reject the unrelated ----------
cond "clip-to-clip (pairwise) confirms the copy and rejects the unrelated clip (no index)"
pw="$(oc "$CASE" audio match "$WORK/copy.m4a" "$WORK/original.mp4" --json)"
pw="$(echo "$pw" | primary_rec)"  # drop any auto-suggested finding the persist hook appended
save_json "28_pairwise_copy" "$pw" >/dev/null
pwc="$(echo "$pw" | jq -r '.payload.count // 0')"
[ "${pwc:-0}" -ge 1 ] && ok "$C.pairwise_confirm" "pairwise CONFIRMED the copy vs the original" || fail "$C.pairwise_confirm" "pairwise found 0 matches (expected >=1)"
pu="$(oc "$CASE" audio match "$WORK/unrelated.m4a" "$WORK/original.mp4" --json)"
pu="$(echo "$pu" | primary_rec)"  # drop any auto-suggested finding the persist hook appended
puc="$(echo "$pu" | jq -r '.payload.count // 0')"
[ "${puc:-0}" -eq 0 ] && ok "$C.pairwise_reject" "pairwise correctly rejected the unrelated clip" || fail "$C.pairwise_reject" "pairwise false-matched $puc time(s)"

# --- showcase: finding + note + brief -----------------------------------------
cond "the confirmed match becomes a finding and lands in the brief"
MR_ID="$(echo "$mr" | jq -r '.id // empty')"
if [ -n "$MR_ID" ] && [ "${rc:-0}" -ge 1 ]; then
  oc "$CASE" finding create "audio copy CONFIRMED: a transcoded/noised copy of the original appears at offset ${offset}s (${votes} aligned hash votes)" --ref "$MR_ID" --confidence high --json >/dev/null
  oc "$CASE" note "local audio fingerprint test — fingerprinted the original, CONFIRMED a transcoded/noised/clipped copy at ~12s (${votes} votes), and REJECTED an unrelated chirp. No external source or API used." --tag tldr,audio --confidence high --json >/dev/null
  BRIEF="$WORK/28_audio_match_brief.html"
  oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
  [ -s "$BRIEF" ] && ok "$C.showcase" "brief HTML written: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)" || fail "$C.showcase" "brief HTML missing at $BRIEF"
else
  skip "$C.showcase" "no confirmed match to showcase"
fi
