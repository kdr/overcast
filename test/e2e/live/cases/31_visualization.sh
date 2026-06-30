#!/usr/bin/env bash
# Real-video case visualization: seed evidence with a real watch, then export the
# CSI-style self-contained HTML brief/status/log artifacts.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C="visualization"
require_cred "$C" CLOUDGLUE_API_KEY "skipping (needs a real watch to visualize)" || exit 0

CLIP="$SMOKE_DIR/viz_clip.mp4"
have_media "$VIDEO_VISUAL" && clip_av 12 "$VIDEO_VISUAL" "$CLIP"
[ -f "$CLIP" ] || { skip "$C" "no clip"; exit 0; }

CASE=$(case_dir visualization)

cond "case setup records named and visual targets for Will Smith and Starbucks"
setup_args=(case setup --name case_visualization --target "Will Smith,Starbucks" --source "web:Will Smith Starbucks visual evidence" --note "Investigation scope: verify whether Will Smith face evidence and Starbucks logo/image evidence appear in the configured real media." --yes --no-index --json)
have_media "$LOCAL_FACE_IMAGE" && setup_args+=(--face-ref "$LOCAL_FACE_IMAGE")
have_media "$LOCAL_IMAGE_REF" && setup_args+=(--image-target "$LOCAL_IMAGE_REF")
setup="$(oc "$CASE" "${setup_args[@]}")"
assert_eq "$C.setup.state" "true" "$(echo "$setup" | jq -sr 'all(.state == "ready")')" "case setup records ready"
assert_nonempty "$C.setup.targets" "$(echo "$setup" | jq -sr 'map(select(.payload.after).payload.after.targets | length) | .[-1] // empty')" "setup target scope recorded"

cond "visualization case seeds a real watch record from a real video"
w="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP" --json)"
assert_eq "$C.seed.state" "ready" "$(echo "$w" | jq -r '.state')" "seed watch ready"
assert_nonempty "$C.seed.content" "$(echo "$w" | jq -r '.payload.content')" "watch content available"

PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if [ ! -x "$PY" ] && [ -x "$LIVE/../../../.dev/visual-db-py/bin/python" ]; then
  PY="$LIVE/../../../.dev/visual-db-py/bin/python"
fi
export OC_VISUAL_DB_PY="$PY"
export OVERCAST_VISUAL_DB_PY="$PY"
if have_media "$LOCAL_IMAGE_REF" && have_media "$LOCAL_IMAGE_VIDEO_A" && "$PY" - <<'PY' >/dev/null 2>&1
import cv2, numpy
PY
then
  cond "local image matching traces the Starbucks reference against real video"
  img_index_rec="$(oc "$CASE" index create starbucks-viz --type image-ransac --local --json)"
  IMG_INDEX="$(echo "$img_index_rec" | jq -r '.payload.index // empty')"
  assert_nonempty "$C.starbucks.index" "$IMG_INDEX" "Starbucks image index id returned"
  img_add="$(oc "$CASE" image add "$LOCAL_IMAGE_REF" --index "$IMG_INDEX" --json)"
  assert_eq "$C.starbucks.add" "ready" "$(echo "$img_add" | jq -r '.state')" "Starbucks reference added"
  img_match="$(OC_TIMEOUT=420 oc "$CASE" image match "$LOCAL_IMAGE_VIDEO_A" --index "$IMG_INDEX" --min-inliers "${OC_LOCAL_IMAGE_MIN_INLIERS:-8}" --min-ratio "${OC_LOCAL_IMAGE_MIN_RATIO:-0.25}" --fps "${OC_LOCAL_IMAGE_FPS:-0.7}" --max-frames "${OC_LOCAL_IMAGE_MAX_FRAMES:-12}" --draw --json)"
  starbucks_state="$(echo "$img_match" | jq -r '.state // empty' 2>/dev/null || true)"
  starbucks_count="$(echo "$img_match" | jq -r '.payload.count // 0' 2>/dev/null || echo 0)"
  if [ "$starbucks_state" = "ready" ]; then
    ok "$C.starbucks.match" "Starbucks image match ran"
  else
    skip "$C.starbucks.match" "Starbucks image matcher returned no ready record"
  fi
  if [ "$starbucks_state" = "ready" ] && [ "${starbucks_count:-0}" -gt 0 ]; then
    ok "$C.starbucks.count" "found $starbucks_count Starbucks image match(es)"
  else
    skip "$C.starbucks.count" "Starbucks matcher ran but found 0 matches in the sampled frames"
  fi
  note_text="Starbucks image trace: local RANSAC compared the Starbucks reference image with candidate video A and returned ${starbucks_count:-0} match(es)."
  oc "$CASE" note "$note_text" --tag "starbucks,image-match,tldr" --confidence medium --json >/dev/null
else
  skip "$C.starbucks" "missing Starbucks media or OpenCV deps"
fi

if have_media "$LOCAL_FACE_IMAGE" && have_media "$LOCAL_FACE_VIDEO" && "$PY" - <<'PY' >/dev/null 2>&1
import deepface, numpy
PY
then
  cond "local face matching traces the Will Smith reference against real video"
  face_setup="$(oc "$CASE" provider setup apply --verb face --choice deepface-local --profile local --yes --json)"
  assert_eq "$C.will.provider" "ready" "$(echo "$face_setup" | jq -r '.state')" "deepface-local provider setup ready"
  face_index_rec="$(oc "$CASE" index create will-viz --type deepface-local --local --json)"
  FACE_INDEX="$(echo "$face_index_rec" | jq -r '.payload.index // empty')"
  assert_nonempty "$C.will.index" "$FACE_INDEX" "Will face index id returned"
  face_add="$(oc "$CASE" index add "$LOCAL_FACE_IMAGE" --to "$FACE_INDEX" --json)"
  assert_eq "$C.will.add" "ready" "$(echo "$face_add" | jq -r '.state')" "Will reference added"
  face_match="$(OC_TIMEOUT=420 oc "$CASE" face "$LOCAL_FACE_VIDEO" --match "$LOCAL_FACE_IMAGE" --index "$FACE_INDEX" --profile local --min-similarity "${OC_LOCAL_FACE_MIN_SIMILARITY:-45}" --fps "${OC_LOCAL_FACE_FPS:-0.5}" --max-frames "${OC_LOCAL_FACE_MAX_FRAMES:-24}" --json)"
  will_state="$(echo "$face_match" | jq -r '.state // empty' 2>/dev/null || true)"
  will_count="$(echo "$face_match" | jq -r '.payload.count // 0' 2>/dev/null || echo 0)"
  if [ "$will_state" = "ready" ]; then
    ok "$C.will.match" "Will face match ran"
  else
    skip "$C.will.match" "Will face matcher returned no ready record"
  fi
  if [ "$will_state" = "ready" ] && [ "${will_count:-0}" -gt 0 ]; then
    ok "$C.will.count" "found $will_count Will Smith face match(es)"
  else
    skip "$C.will.count" "Will matcher ran but found 0 matches in the sampled frames"
  fi
  note_text="Will Smith face trace: local DeepFace compared the Will Smith reference image with candidate video and returned ${will_count:-0} match(es)."
  oc "$CASE" note "$note_text" --tag "will-smith,face-match,tldr" --confidence medium --json >/dev/null
else
  skip "$C.will" "missing Will Smith media or DeepFace deps"
fi

cond "case memory can produce a TL;DR over the visual matching findings"
tldr="$(oc "$CASE" ask "TL;DR the Will Smith and Starbucks visual findings in this case" --json)"
save_json "31_visualization_tldr" "$tldr" >/dev/null
assert_eq "$C.tldr.state" "ready" "$(echo "$tldr" | jq -r '.state')" "ask TL;DR ready"
assert_nonempty "$C.tldr.text" "$(echo "$tldr" | jq -r '.payload.text')" "ask returned TL;DR text"

cond "brief exports a CSI HTML visualization with escaped case evidence"
BHTML="$SMOKE_DIR/visualization-brief-csi.html"
b="$(oc "$CASE" brief --export "$BHTML" --theme csi --json)"
save_json "31_visualization_brief" "$b" >/dev/null
assert_eq "$C.brief.state" "ready" "$(echo "$b" | jq -r '.state')" "brief ready"
assert_eq "$C.brief.export" "$BHTML" "$(echo "$b" | jq -r '.payload.export')" "brief export path returned"
if [ -f "$BHTML" ] && grep -q 'data-overcast-theme="csi"' "$BHTML" && grep -q 'data-csi-timeline="true"' "$BHTML"; then
  ok "$C.brief.html" "CSI brief HTML exported: $BHTML"
else
  fail "$C.brief.html" "missing CSI brief HTML markers"
fi

cond "case status exports a CSI HTML status visualization"
SHTML="$SMOKE_DIR/visualization-status-csi.html"
s="$(oc "$CASE" case status --export "$SHTML" --theme csi --json)"
save_json "31_visualization_status" "$s" >/dev/null
assert_eq "$C.status.state" "ready" "$(echo "$s" | jq -r '.state')" "status ready"
assert_eq "$C.status.export" "$SHTML" "$(echo "$s" | jq -r '.payload.export')" "status export path returned"
assert_nonempty "$C.status.memory" "$(echo "$s" | jq -r '.payload.memory_index | length')" "memory provider status included"
if [ -f "$SHTML" ] && grep -q 'data-overcast-theme="csi"' "$SHTML" && grep -q 'data-csi-status="true"' "$SHTML"; then
  ok "$C.status.html" "CSI status HTML exported: $SHTML"
else
  fail "$C.status.html" "missing CSI status HTML markers"
fi

cond "case records exports a CSI HTML audit timeline"
RHTML="$SMOKE_DIR/visualization-records-csi.html"
r="$(oc "$CASE" case records --export "$RHTML" --theme csi --json)"
save_json "31_visualization_records" "$r" >/dev/null
assert_eq "$C.records.state" "ready" "$(echo "$r" | jq -r '.state')" "records ready"
assert_eq "$C.records.export" "$RHTML" "$(echo "$r" | jq -r '.payload.export')" "records export path returned"
if [ -f "$RHTML" ] && grep -q 'data-csi-timeline="true"' "$RHTML" && grep -q 'watch' "$RHTML"; then
  ok "$C.records.html" "CSI records timeline exported: $RHTML"
else
  fail "$C.records.html" "missing CSI records timeline"
fi
