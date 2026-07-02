#!/usr/bin/env bash
# Local copycat detection — the frame-match CORE with no external source and no
# API creds. Fingerprint a local original, synthesize a reskinned copy (speed
# change + crop + rescale + letterbox/subtitle bar) and an UNRELATED clip, then
# assert the matcher CONFIRMS the copy (survives the geometry gate) and REJECTS
# the unrelated one — the whole copycat pipeline proven on local media, then
# showcased as a brief HTML with the embedded match overlay + video players.
# Needs only ffmpeg + the local visual-DB python (cv2/numpy); skips otherwise.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=copycat_local

have_media "$VIDEO_VISUAL" || { skip "$C" "no OC_VIDEO_VISUAL (a texture-rich clip to fingerprint)"; exit 0; }
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import cv2, numpy  # noqa
PY
then
  skip "$C.deps" "local image matcher deps missing in $PY (need opencv-python numpy — run scripts/visual-db-uv.sh)"
  exit 0
fi

CASE=$(case_dir copycat_local)
WORK="$SMOKE_DIR/copycat_local"; mkdir -p "$WORK"
ORIG="$VIDEO_VISUAL"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$ORIG" 2>/dev/null | cut -d. -f1)"
[ -z "$DUR" ] || [ "$DUR" -lt 8 ] && DUR=20

# --- fingerprint the original: a few frames → local image-ransac index --------
cond "fingerprint the original into a local image-ransac index (no external source)"
for pct in 20 40 60 80; do
  sec=$(( DUR * pct / 100 ))
  frame_jpg "$ORIG" "$sec" "$WORK/orig_${pct}.jpg"
done
frames=$(ls "$WORK"/orig_*.jpg 2>/dev/null | wc -l | tr -d ' ')
[ "$frames" -ge 2 ] || { fail "$C.frames" "could not extract fingerprint frames"; exit 0; }
created="$(oc "$CASE" index create original --type image-ransac --local --json)"
IDX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.index" "$IDX" "local image-ransac index created"
for f in "$WORK"/orig_*.jpg; do oc "$CASE" index add "$f" --to "$IDX" --json >/dev/null; done
ok "$C.fingerprint" "indexed $frames original frames into $IDX"

# --- synthesize a reskinned COPY (speed change + crop + rescale + letterbox) ---
cond "a reskinned copy (1.25x speed, cropped, rescaled, letterboxed) is CONFIRMED through the geometry gate"
mid=$(( DUR * 40 / 100 ))
seg=$(( DUR > 70 ? 60 : DUR - mid - 1 )); [ "$seg" -lt 6 ] && seg=6
"$FFMPEG" -y -v error -ss "$mid" -t "$seg" -i "$ORIG" \
  -vf "setpts=PTS/1.25,crop=in_w*0.9:in_h*0.9,scale=854:480,drawbox=y=ih-46:w=iw:h=46:color=black@0.85:t=fill" \
  -an -c:v libx264 -preset veryfast "$WORK/reskin.mp4" 2>/dev/null
if [ ! -s "$WORK/reskin.mp4" ]; then fail "$C.reskin_build" "ffmpeg could not build the reskin clip"; exit 0; fi
mr="$(OC_TIMEOUT=420 oc "$CASE" image match "$WORK/reskin.mp4" --index "$IDX" --max-frames 40 --draw --json)"
save_json "27_match_reskin" "$mr" >/dev/null
assert_eq "$C.reskin_state" "ready" "$(echo "$mr" | jq -r '.state')" "reskin match ran"
rc="$(echo "$mr" | jq -r '.payload.count // 0')"
if [ "${rc:-0}" -ge 1 ]; then
  ok "$C.copy_confirmed" "reskinned copy CONFIRMED: $rc gated frame match(es) survived the planar-projection gate"
else
  fail "$C.copy_confirmed" "reskinned copy produced 0 gated matches (expected >=1)"
fi
draws="$(echo "$mr" | jq -r '[.payload.matches[]?.match_draw_path | select(. != null)] | length')"
if [ "${draws:-0}" -ge 1 ]; then ok "$C.copy_overlay" "wrote $draws RANSAC match overlay(s)"; else fail "$C.copy_overlay" "no match overlay written by --draw"; fi

# --- an UNRELATED clip must be REJECTED (0 gated matches) ----------------------
cond "an unrelated clip is REJECTED (0 gated matches — no degenerate false positive)"
if have_media "$VIDEO_OBJECTS" && [ "$VIDEO_OBJECTS" != "$ORIG" ]; then
  "$FFMPEG" -y -v error -ss 0 -t 20 -i "$VIDEO_OBJECTS" -vf "scale=854:480" -an -c:v libx264 -preset veryfast "$WORK/unrelated.mp4" 2>/dev/null
  unrelated_src="OC_VIDEO_OBJECTS"
else
  "$FFMPEG" -y -v error -f lavfi -i "testsrc=size=854x480:rate=15:duration=15" -c:v libx264 -preset veryfast "$WORK/unrelated.mp4" 2>/dev/null
  unrelated_src="synthetic testsrc"
fi
if [ -s "$WORK/unrelated.mp4" ]; then
  mu="$(OC_TIMEOUT=420 oc "$CASE" image match "$WORK/unrelated.mp4" --index "$IDX" --max-frames 40 --json)"
  save_json "27_match_unrelated" "$mu" >/dev/null
  uc="$(echo "$mu" | jq -r '.payload.count // 0')"
  if [ "${uc:-0}" -eq 0 ]; then
    ok "$C.unrelated_rejected" "unrelated clip ($unrelated_src) correctly rejected: 0 gated matches"
  else
    fail "$C.unrelated_rejected" "unrelated clip false-matched $uc time(s) — geometry gate leak"
  fi
else
  skip "$C.unrelated_rejected" "could not build an unrelated clip"
fi

# --- showcase: finding + brief HTML with the embedded overlay ------------------
cond "the confirmed copy becomes a finding and the brief embeds its match overlay"
MR_ID="$(echo "$mr" | jq -r '.id // empty')"
if [ -n "$MR_ID" ] && [ "${rc:-0}" -ge 1 ]; then
  oc "$CASE" finding create "copycat CONFIRMED: a reskinned copy (1.25x speed, cropped, rescaled, letterboxed) of the original is detected — $rc gated RANSAC frame match(es)" --ref "$MR_ID" --confidence high --json >/dev/null
  oc "$CASE" note "local copycat test — fingerprinted the original, CONFIRMED a sped-up/rescaled/letterboxed reskin ($rc gated matches), and REJECTED an unrelated clip (${uc:-0} matches). No external source or API used." --tag tldr,copycat --confidence high --json >/dev/null
  BRIEF="$WORK/27_copycat_local_brief.html"
  oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
  if [ -s "$BRIEF" ] && grep -q 'data-csi-overlays' "$BRIEF" && grep -q '<video class="embed"' "$BRIEF"; then
    ok "$C.showcase" "brief HTML embeds the match overlay + video player: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
  else
    fail "$C.showcase" "brief HTML missing overlay/video embed at $BRIEF"
  fi
else
  skip "$C.showcase" "no confirmed match to showcase"
fi
