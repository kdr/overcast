#!/usr/bin/env bash
# Real visual DB checks: local image-ransac index + local deepface-local index.
# Uses paths from .env and skips cleanly when optional Python deps are absent.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=visual_db

have_media "$LOCAL_IMAGE_REF" || { skip "$C.image" "no OC_LOCAL_IMAGE_REF"; exit 0; }
have_media "$LOCAL_IMAGE_VIDEO_A" || { skip "$C.image" "no OC_LOCAL_IMAGE_VIDEO_A"; exit 0; }
have_media "$LOCAL_IMAGE_VIDEO_B" || { skip "$C.image" "no OC_LOCAL_IMAGE_VIDEO_B"; exit 0; }

PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import cv2, numpy
PY
then
  skip "$C.image_deps" "local image matcher deps missing in $PY (need opencv-python numpy)"
  exit 0
fi

CASE=$(case_dir visual_db)

cond "index create --local makes an image-ransac DB and image match finds the Starbucks reference in real videos"
created="$(oc "$CASE" index create starbucks --type image-ransac --local --json)"; rc=$?
assert_eq "$C.image_create_exit" "0" "$rc" "local image index create exits 0"
IMG_INDEX="$(echo "$created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.image_index_id" "$IMG_INDEX" "local image index id returned"

add_img="$(oc "$CASE" index add "$LOCAL_IMAGE_REF" --to "$IMG_INDEX" --json)"
assert_eq "$C.image_add_state" "ready" "$(echo "$add_img" | jq -r '.state')" "reference image added to index"

MIN_INLIERS="${OC_LOCAL_IMAGE_MIN_INLIERS:-8}"
MIN_RATIO="${OC_LOCAL_IMAGE_MIN_RATIO:-0.25}"
MAX_FRAMES="${OC_LOCAL_IMAGE_MAX_FRAMES:-12}"
IMAGE_FPS="${OC_LOCAL_IMAGE_FPS:-0.7}"

match_a="$(OC_TIMEOUT=420 oc "$CASE" image match "$LOCAL_IMAGE_VIDEO_A" --index "$IMG_INDEX" --min-inliers "$MIN_INLIERS" --min-ratio "$MIN_RATIO" --fps "$IMAGE_FPS" --max-frames "$MAX_FRAMES" --draw --json)"
assert_eq "$C.image_match_a_state" "ready" "$(echo "$match_a" | jq -r '.state')" "video A image match state ready"
count_a="$(echo "$match_a" | jq -r '.payload.count // 0')"
assert_eq "$C.image_match_a_fps" "$IMAGE_FPS" "$(echo "$match_a" | jq -r '.payload.sampling.fps // empty')" "video A image match used fps sampling"

match_b="$(OC_TIMEOUT=420 oc "$CASE" image match "$LOCAL_IMAGE_VIDEO_B" --index "$IMG_INDEX" --min-inliers "$MIN_INLIERS" --min-ratio "$MIN_RATIO" --fps "$IMAGE_FPS" --max-frames "$MAX_FRAMES" --draw --json)"
assert_eq "$C.image_match_b_state" "ready" "$(echo "$match_b" | jq -r '.state')" "video B image match state ready"
count_b="$(echo "$match_b" | jq -r '.payload.count // 0')"
assert_eq "$C.image_match_b_fps" "$IMAGE_FPS" "$(echo "$match_b" | jq -r '.payload.sampling.fps // empty')" "video B image match used fps sampling"

total=$((count_a + count_b))
if [ "$total" -gt 0 ]; then
  ok "$C.image_match_count" "found $total Starbucks image match(es) across the candidate videos"
else
  fail "$C.image_match_count" "expected at least one Starbucks image match, got 0 (thresholds: inliers=$MIN_INLIERS ratio=$MIN_RATIO fps=$IMAGE_FPS cap=$MAX_FRAMES)"
fi
save_json "visual_db_image_a" "$match_a" >/dev/null
save_json "visual_db_image_b" "$match_b" >/dev/null

if ! have_media "$LOCAL_FACE_VIDEO" || ! have_media "$LOCAL_FACE_IMAGE"; then
  skip "$C.face" "no OC_LOCAL_FACE_VIDEO/OC_LOCAL_FACE_IMAGE"
  exit 0
fi
if ! "$PY" - <<'PY' >/dev/null 2>&1
import deepface, numpy
PY
then
  skip "$C.face_deps" "local face matcher deps missing in $PY (need deepface numpy; image DB test still ran)"
  exit 0
fi

cond "provider setup can bind face:deepface-local and plain face detection uses the local provider"
FACE_MIN="${OC_LOCAL_FACE_MIN_SIMILARITY:-45}"
FACE_FRAMES="${OC_LOCAL_FACE_MAX_FRAMES:-24}"
FACE_FPS="${OC_LOCAL_FACE_FPS:-0.5}"
deepface_local_setup="$(oc "$CASE" provider setup apply --verb face --choice deepface-local --profile local --yes --json)"
assert_eq "$C.deepface_setup_state" "ready" "$(echo "$deepface_local_setup" | jq -r '.state')" "face:deepface-local provider setup state ready"
deepface_local_detect="$(OC_TIMEOUT=420 oc "$CASE" face "$LOCAL_FACE_VIDEO" --profile local --fps "$FACE_FPS" --max-frames "$FACE_FRAMES" --json)"
assert_eq "$C.deepface_detect_state" "ready" "$(echo "$deepface_local_detect" | jq -r '.state')" "deepface-local provider detection state ready"
assert_eq "$C.deepface_detect_provider" "local:face" "$(echo "$deepface_local_detect" | jq -r '.meta.provider // empty')" "deepface-local provider routed to local face implementation"
assert_eq "$C.deepface_detect_fps" "$FACE_FPS" "$(echo "$deepface_local_detect" | jq -r '.payload.sampling.fps // empty')" "deepface-local provider detection used fps sampling"
deepface_detect_count="$(echo "$deepface_local_detect" | jq -r '.payload.count // 0')"
if [ "$deepface_detect_count" -gt 0 ]; then
  ok "$C.deepface_detect_count" "found $deepface_detect_count local face detection(s)"
else
  fail "$C.deepface_detect_count" "expected at least one local face detection, got 0 (fps=$FACE_FPS cap=$FACE_FRAMES)"
fi
save_json "visual_db_deepface_detect" "$deepface_local_detect" >/dev/null

cond "local deepface-local index matches the Will reference against a real video"
face_created="$(oc "$CASE" index create will --type deepface-local --local --json)"
FACE_INDEX="$(echo "$face_created" | jq -r '.payload.index // empty')"
assert_nonempty "$C.face_index_id" "$FACE_INDEX" "local face index id returned"
face_add="$(oc "$CASE" index add "$LOCAL_FACE_IMAGE" --to "$FACE_INDEX" --json)"
assert_eq "$C.face_add_state" "ready" "$(echo "$face_add" | jq -r '.state')" "reference face added to local face index"
face_match="$(OC_TIMEOUT=420 oc "$CASE" face "$LOCAL_FACE_VIDEO" --match "$LOCAL_FACE_IMAGE" --index "$FACE_INDEX" --min-similarity "$FACE_MIN" --fps "$FACE_FPS" --max-frames "$FACE_FRAMES" --json)"
assert_eq "$C.face_match_state" "ready" "$(echo "$face_match" | jq -r '.state')" "local face match state ready"
assert_eq "$C.face_match_fps" "$FACE_FPS" "$(echo "$face_match" | jq -r '.payload.sampling.fps // empty')" "local face match used fps sampling"
face_count="$(echo "$face_match" | jq -r '.payload.count // 0')"
if [ "$face_count" -gt 0 ]; then
  ok "$C.face_match_count" "found $face_count local face match(es)"
else
  fail "$C.face_match_count" "expected at least one local face match, got 0 (threshold=$FACE_MIN fps=$FACE_FPS cap=$FACE_FRAMES)"
fi
save_json "visual_db_face" "$face_match" >/dev/null
