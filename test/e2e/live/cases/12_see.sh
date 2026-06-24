#!/usr/bin/env bash
# Real see: HF captioner + fal florence-2 (caption/OCR) + local OWLv2 detector,
# all on a REAL frame extracted from a real video.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=see

FRAME="$SMOKE_DIR/see_frame.jpg"
have_media "$VIDEO_OBJECTS" && frame_jpg "$VIDEO_OBJECTS" 3 "$FRAME"
[ -f "$FRAME" ] || { skip "$C" "no frame available"; exit 0; }

# --- HF captioner (bound explicitly with an absolute path: the bun binary can't
#     auto-resolve the shipped examples/ from its virtual FS) ---
if require_cred "$C.hf" HF_TOKEN "skipping"; then
  CASE=$(case_dir see_hf)
  HS="$PWD/examples/providers/hf/see.sh"
  ocrun "$CASE" setup provider see "exec:bash $HS {{input}}" --json >/dev/null 2>&1
  cond "see (bound HF vision-LLM) captions a real frame → ready record with a caption"
  out="$(OC_TIMEOUT=180 oc "$CASE" see "$FRAME" --json)"
  save_json "12_see_hf" "$out" >/dev/null
  st="$(echo "$out" | jq -r '.state')"
  if [ "$st" = "ready" ]; then assert_nonempty "$C.hf.caption" "$(echo "$out"|jq -r '.payload.caption')" "HF caption non-empty"
  else fail "$C.hf.state" "state=$st err=$(echo "$out"|jq -r '.error // empty' | head -c 80)"; fi
fi

# --- fal florence-2 (bound), caption + OCR ---
if require_cred "$C.fal" FAL_KEY "skipping"; then
  CASE=$(case_dir see_fal)
  FS="$PWD/examples/providers/fal/see.sh"
  ocrun "$CASE" setup provider see "exec:bash $FS {{input}}" --json >/dev/null 2>&1
  cond "see (bound fal florence-2) captions a real frame → ready record"
  out="$(OC_TIMEOUT=180 oc "$CASE" see "$FRAME" --json)"
  save_json "12_see_fal" "$out" >/dev/null
  st="$(echo "$out" | jq -r '.state')"
  [ "$st" = "ready" ] && ok "$C.fal.state" "fal florence-2 ready (caption len $(echo "$out"|jq -r '.payload.caption|length'))" || fail "$C.fal.state" "state=$st"
fi

# --- local OWLv2 object detector (needs torch/transformers/scipy) ---
DETECT_PY="${DETECT_PY:-}"
if [ -z "$DETECT_PY" ]; then
  for p in /tmp/oc-locate-venv/bin/python python3; do
    if "$p" -c "import torch,transformers,scipy,PIL" >/dev/null 2>&1; then DETECT_PY="$p"; break; fi
  done
fi
if [ -n "$DETECT_PY" ]; then
  CASE=$(case_dir see_detect)
  DET="$PWD/examples/providers/detect/detect.py"
  ocrun "$CASE" setup provider see "exec:$DETECT_PY $DET" --json >/dev/null 2>&1
  cond "see --detect (bound local OWLv2) returns open-vocab bounding boxes on a real frame"
  out="$(OC_TIMEOUT=300 oc "$CASE" see "$FRAME" --detect "person, hard hat, helmet" --json)"
  save_json "12_see_detect" "$out" >/dev/null
  assert_eq "$C.detect.state" "ready" "$(echo "$out"|jq -r '.state')" "OWLv2 detection ready"
  nd="$(echo "$out" | jq -r '.payload.detections|length')"
  if [ "${nd:-0}" -gt 0 ]; then ok "$C.detect.boxes" "$nd boxes ($(echo "$out"|jq -rc '.payload.counts'))"; else fail "$C.detect.boxes" "no detections"; fi
  assert_nonempty "$C.detect.box_shape" "$(echo "$out"|jq -r '.payload.detections[0].box.xmin // empty')" "box has xmin"
else
  skip "$C.detect" "no python with torch/transformers/scipy (DETECT_PY)"
fi
