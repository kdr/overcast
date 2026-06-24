#!/usr/bin/env bash
# Real enhance (vendored ffmpeg + fal esrgan) and view (HTML player) on real media.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=enhance

CLIP="$SMOKE_DIR/small10.mp4"
SRC="$VIDEO_SMALL"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" && clip_av 10 "$SRC" "$CLIP"
[ -f "$CLIP" ] || { skip "$C" "no clip"; exit 0; }

CASE=$(case_dir enhance)

# --- ffmpeg enhance (the default toolkit, runs inside the binary) ---
out="$(ocrun "$CASE" enhance "$CLIP" --ops denoise,grayscale --json 2>/dev/null)"
save_json "13_enhance_ffmpeg" "$out" >/dev/null
assert_eq "$C.ff.state" "ready" "$(echo "$out"|jq -r '.state')" "ffmpeg enhance ready"
outpath="$(echo "$out" | jq -r '.media.ref')"
if [ -f "$outpath" ]; then ok "$C.ff.output_exists" "enhanced file written"; else fail "$C.ff.output_exists" "missing: $outpath"; fi
assert_eq "$C.ff.provider" "ffmpeg" "$(echo "$out"|jq -r '.meta.provider')" "internal ffmpeg provider"

# --- view: real video → self-contained HTML player (no-open) ---
v="$(ocrun "$CASE" view "$CLIP" --no-open --json 2>/dev/null)"
save_json "13_view" "$v" >/dev/null
assert_eq "$C.view.mode" "video" "$(echo "$v"|jq -r '.payload.mode')" "view detects video"
vpath="$(echo "$v" | jq -r '.payload.viewer')"
if [ -f "$vpath" ] && grep -q "<video" "$vpath"; then ok "$C.view.html" "HTML player written w/ <video>"; else fail "$C.view.html" "no player html"; fi

# --- fal esrgan enhance (bound) on a real frame ---
if require_cred "$C.fal" FAL_KEY "skipping"; then
  FRAME="$SMOKE_DIR/enh_frame.jpg"; frame_jpg "$CLIP" 1 "$FRAME"
  FE="$PWD/examples/providers/fal/enhance.sh"
  ocrun "$CASE" setup provider enhance "exec:bash $FE {{input}}" --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=240 ocrun "$CASE" enhance "$FRAME" --json 2>/dev/null)"
  save_json "13_enhance_fal" "$out" >/dev/null
  st="$(echo "$out" | jq -r '.state')"
  [ "$st" = "ready" ] && ok "$C.fal.state" "fal esrgan enhance ready" || fail "$C.fal.state" "state=$st err=$(echo "$out"|jq -r '.error // empty'|head -c 80)"
fi
