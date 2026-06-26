#!/usr/bin/env bash
# Real tinycloud `face` (>= 0.3.4): detect faces in a real clip, then match a face
# image against it. Emits face.analysis records (normalized faces[] + detailed).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=face
require_cred "$C" CLOUDGLUE_API_KEY "skipping real face" || exit 0
have_media "$VIDEO_VISUAL" || { skip "$C" "no OC_VIDEO_VISUAL"; exit 0; }

CASE=$(case_dir face)
# a short clip keeps the real cloud call cheap/fast (fall back to the full file)
CLIP="$SMOKE_DIR/face-clip.mp4"
clip_av 8 "$VIDEO_VISUAL" "$CLIP" || CLIP="$VIDEO_VISUAL"
[ -f "$CLIP" ] || CLIP="$VIDEO_VISUAL"

cond "face <video> detects faces via real tinycloud and emits a ready face.analysis record"
out="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP" --json)"; rc=$?
assert_eq "$C.exit_zero" "0" "$rc" "face exits 0"
assert_eq "$C.verb" "face" "$(echo "$out" | jq -r '.verb')" "record.verb is face"
assert_eq "$C.op" "detect" "$(echo "$out" | jq -r '.payload.op')" "op is detect"
assert_eq "$C.state" "ready" "$(echo "$out" | jq -r '.state')" "state is ready"
assert_eq "$C.faces_array" "array" "$(echo "$out" | jq -r '.payload.faces | type')" "payload.faces is an array"
assert_nonempty "$C.detailed" "$(echo "$out" | jq -r '.payload.detailed // empty | tostring')" "payload.detailed (structured) present"
assert_eq "$C.provider" "tinycloud" "$(echo "$out" | jq -r '.meta.provider')" "meta.provider is tinycloud"

# face --match needs a face image (OC_IMAGE); skip cleanly when absent.
if have_media "$IMAGE_FILE"; then
  cond "face --match <image> <video> finds the person and emits ranked matches (0-1 similarity)"
  mout="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP" --match "$IMAGE_FILE" --max-faces 5 --json)"; mrc=$?
  assert_eq "$C.match_exit" "0" "$mrc" "face --match exits 0"
  assert_eq "$C.match_op" "match" "$(echo "$mout" | jq -r '.payload.op')" "op is match"
  assert_eq "$C.match_state" "ready" "$(echo "$mout" | jq -r '.state')" "state is ready"
  assert_nonempty "$C.match_ref" "$(echo "$mout" | jq -r '.payload.reference // empty')" "the reference image is recorded"
else
  skip "$C.match" "no OC_IMAGE for --match"
fi
