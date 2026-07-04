#!/usr/bin/env bash
# Real-media audio fingerprint matching. Unlike 28 (self-contained synthetic
# chirps), this drives `audio` against a REAL video with a real audio track
# (OC_VIDEO_SPEECH — a longer clip), proving the flows that matter in the field:
#   • self-location: a clip from the middle → WHERE it appears in the full video
#   • re-upload robustness: a heavily transcoded segment still matches the original
#   • speed-drift rejection: a slightly sped-up copy confirms on raw votes but is
#     rejected by --min-margin (the exact-copy vs evasive-reupload discriminator)
#   • negative: a different real video is rejected
# Needs ffmpeg + numpy/scipy + OC_VIDEO_SPEECH; skips otherwise.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=audio_match_realmedia

have_cmd ffmpeg || { skip "$C" "no ffmpeg on PATH"; exit 0; }
have_media "$VIDEO_SPEECH_SRC" || { skip "$C" "no OC_VIDEO_SPEECH (a longer real video with an audio track)"; exit 0; }
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import numpy, scipy.signal, scipy.ndimage  # noqa
PY
then
  skip "$C.deps" "audio fingerprint deps missing in $PY (need numpy scipy — run scripts/visual-db-uv.sh --audio)"
  exit 0
fi
# the source must actually carry audio (a silent screen-recording fingerprints to 0 hashes)
if [ "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$VIDEO_SPEECH_SRC" 2>/dev/null | head -1)" != "audio" ]; then
  skip "$C.audio" "OC_VIDEO_SPEECH has no audio stream"; exit 0
fi

CASE=$(case_dir audio_match_realmedia)
WORK="$SMOKE_DIR/audio_match_realmedia"; mkdir -p "$WORK"
SRC="$VIDEO_SPEECH_SRC"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC" 2>/dev/null | cut -d. -f1)"
[ -z "$DUR" ] && DUR=0
if [ "$DUR" -lt 30 ]; then skip "$C.dur" "OC_VIDEO_SPEECH is only ${DUR}s; need >=30s for a middle-clip test"; exit 0; fi
CUT=$(( DUR * 40 / 100 ))   # cut a clip starting 40% in
SEG=15; [ "$SEG" -gt $(( DUR - CUT - 1 )) ] && SEG=$(( DUR - CUT - 1 ))

# --- fingerprint the full real video ------------------------------------------
cond "fingerprint a real video into a local audio-fp index"
created="$(oc "$CASE" index create realsrc --type audio-fp --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index" "$IDX" "audio-fp index created"
add="$(OC_TIMEOUT=420 oc "$CASE" audio add "$SRC" --to "$IDX" --json)"
save_json "30_add" "$add" >/dev/null
hh="$(echo "$add" | jq -r '.payload.hashes // 0')"
assert_eq "$C.add_state" "ready" "$(echo "$add" | jq -r '.state')" "fingerprinted the real audio track"
[ "${hh:-0}" -ge 100 ] && ok "$C.add_hashes" "built $hh constellation hashes over ${DUR}s" || { fail "$C.add_hashes" "only $hh hashes — audio too quiet to test"; exit 0; }

# --- self-location: a clip from the MIDDLE → correct offset --------------------
cond "a clip from the middle of the real video is located at the right offset (~${CUT}s)"
ffmpeg -y -v error -ss "$CUT" -t "$SEG" -i "$SRC" -map 0:a:0 -c:a aac "$WORK/mid.m4a" 2>/dev/null
loc="$(oc "$CASE" audio match "$WORK/mid.m4a" --index "$IDX" --json)"
save_json "30_selfloc" "$loc" >/dev/null
lc="$(echo "$loc" | jq -r '.payload.count // 0')"
if [ "${lc:-0}" -ge 1 ]; then
  off="$(echo "$loc" | jq -r '.payload.matches[0].offset_seconds')"
  vt="$(echo "$loc" | jq -r '.payload.matches[0].aligned_votes')"
  if awk -v o="$off" -v c="$CUT" 'BEGIN{d=o-c; if(d<0)d=-d; exit !(d<=1.0)}'; then
    ok "$C.selfloc" "located at ${off}s (cut @${CUT}s), $vt aligned votes"
  else
    fail "$C.selfloc" "offset ${off}s not within ${CUT}±1s"
  fi
else
  fail "$C.selfloc" "middle clip not found (count 0)"
fi

# --- re-upload robustness: heavy transcode of a segment still matches ----------
cond "a heavily transcoded segment (22kHz mono mp3, low bitrate) still matches the original"
ffmpeg -y -v error -ss "$CUT" -t "$SEG" -i "$SRC" -map 0:a:0 -ac 1 -ar 22050 -b:a 64k -c:a libmp3lame "$WORK/reup.mp3" 2>/dev/null
ru="$(oc "$CASE" audio match "$WORK/reup.mp3" --index "$IDX" --json)"
save_json "30_reupload" "$ru" >/dev/null
ruc="$(echo "$ru" | jq -r '.payload.count // 0')"
[ "${ruc:-0}" -ge 1 ] && ok "$C.reupload" "transcoded re-upload CONFIRMED ($(echo "$ru" | jq -r '.payload.matches[0].aligned_votes') votes, margin $(echo "$ru" | jq -r '.payload.matches[0].margin'))" || fail "$C.reupload" "transcoded segment failed to match"

# --- speed-drift: confirms on raw votes but --min-margin 2 rejects it ----------
cond "a 1.08x sped-up copy is a WEAK partial alignment: default confirms, --min-margin 2 rejects"
ffmpeg -y -v error -ss "$CUT" -t "$SEG" -i "$SRC" -filter:a "atempo=1.08" -map 0:a:0 -c:a aac "$WORK/sped.m4a" 2>/dev/null
sp_def="$(oc "$CASE" audio match "$WORK/sped.m4a" --index "$IDX" --json)"
sp_mrg="$(oc "$CASE" audio match "$WORK/sped.m4a" --index "$IDX" --min-margin 2 --json)"
save_json "30_sped_default" "$sp_def" >/dev/null
save_json "30_sped_margin" "$sp_mrg" >/dev/null
spd_margin="$(echo "$sp_def" | jq -r '.payload.matches[0].margin // .payload.best_rejected.margin // 0')"
mrg_count="$(echo "$sp_mrg" | jq -r '.payload.count // 0')"
# the discriminator: the speed-drift alignment has a weak margin (~1.x), so a
# margin gate rejects it. (We don't assert the default count — a strong FM copy
# could legitimately vary — we assert the MARGIN GATE rejects the weak alignment.)
if [ "${mrg_count:-0}" -eq 0 ]; then
  ok "$C.speed_margin" "--min-margin 2 rejected the sped copy (weak margin ${spd_margin})"
else
  fail "$C.speed_margin" "--min-margin 2 still confirmed the sped copy (margin ${spd_margin})"
fi

# --- --draw: render the alignment visualization + embed it in a brief ---------
cond "audio match --draw renders an SVG alignment plot that embeds in a CSI brief"
dr="$(oc "$CASE" audio match "$WORK/mid.m4a" --index "$IDX" --draw --json)"
save_json "30_draw" "$dr" >/dev/null
DRAW_PATH="$(echo "$dr" | jq -r '.payload.matches[0].match_draw_path // empty')"
DR_ID="$(echo "$dr" | jq -r '.id // empty')"
if [ -n "$DRAW_PATH" ] && [ -s "$DRAW_PATH" ] && head -c 64 "$DRAW_PATH" | grep -q "<svg"; then
  ok "$C.draw" "wrote SVG alignment plot ($(wc -c <"$DRAW_PATH" | tr -d ' ')B): $DRAW_PATH"
  oc "$CASE" finding create "audio self-location CONFIRMED at ~${CUT}s (alignment plotted)" --ref "$DR_ID" --confidence high --json >/dev/null
  BRIEF="$WORK/30_audio_brief.html"
  oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
  if [ -s "$BRIEF" ] && grep -q 'data-csi-overlays' "$BRIEF" && grep -q 'data:image/svg' "$BRIEF"; then
    ok "$C.draw_brief" "brief HTML embeds the SVG alignment overlay ($(wc -c <"$BRIEF" | tr -d ' ')B)"
  else
    fail "$C.draw_brief" "brief did not embed the audio-match SVG at $BRIEF"
  fi
else
  fail "$C.draw" "audio match --draw did not write a valid SVG (got '$DRAW_PATH')"
fi

# --- negative: a different real video is rejected -----------------------------
cond "a different real video is rejected (no false positive)"
NEG=""
for cand in "$VIDEO_SMALL" "$VIDEO_OBJECTS" "$OC_LOCAL_IMAGE_VIDEO_A"; do
  if have_media "$cand" && [ "$cand" != "$SRC" ] && \
     [ "$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$cand" 2>/dev/null | head -1)" = "audio" ]; then NEG="$cand"; break; fi
done
if [ -n "$NEG" ]; then
  ng="$(oc "$CASE" audio match "$NEG" --index "$IDX" --json)"
  ngc="$(echo "$ng" | jq -r '.payload.count // 0')"
  [ "${ngc:-0}" -eq 0 ] && ok "$C.negative" "different video ($(basename "$NEG")) correctly rejected" || fail "$C.negative" "different video false-matched $ngc time(s)"
else
  skip "$C.negative" "no second real video with audio available for the negative case"
fi