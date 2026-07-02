#!/usr/bin/env bash
# Real see: HF captioner + fal florence-2 (caption/OCR) + Cloudglue tinycloud
# see/extract (>= 0.3.7) + local OWLv2 detector, on a real image (OC_IMAGE) or
# a frame extracted from a real video.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=see

# Prefer a standalone image (OC_IMAGE); else extract one real frame from a video.
if have_media "$IMAGE_FILE"; then
  FRAME="$IMAGE_FILE"
elif have_media "$VIDEO_OBJECTS"; then
  FRAME="$SMOKE_DIR/see_frame.jpg"; frame_jpg "$VIDEO_OBJECTS" 3 "$FRAME"
elif have_media "$VIDEO_VISUAL"; then
  FRAME="$SMOKE_DIR/see_frame.jpg"; frame_jpg "$VIDEO_VISUAL" 3 "$FRAME"
fi
[ -n "${FRAME:-}" ] && [ -f "$FRAME" ] || { skip "$C" "no image (set OC_IMAGE or OC_VIDEO_OBJECTS/VISUAL)"; exit 0; }

# --- brain LLM (the DEFAULT see backend): no binding, image-capable brain
#     describes the frame directly. Turnkey with the Cloudglue brain. ---
if require_cred "$C.brain" CLOUDGLUE_API_KEY "skipping"; then
  CASE=$(case_dir see_brain)   # fresh case → default profile (no see binding) → brain default
  cond "see (default brain LLM) describes a real frame → ready record with a caption"
  out="$(OC_TIMEOUT=180 oc "$CASE" see "$FRAME" --json)"
  save_json "12_see_brain" "$out" >/dev/null
  st="$(echo "$out" | jq -r '.state')"
  prov="$(echo "$out" | jq -r '.meta.provider // empty')"
  if [ "$st" = "ready" ]; then
    assert_nonempty "$C.brain.caption" "$(echo "$out"|jq -r '.payload.caption')" "brain caption non-empty"
    case "$prov" in brain:*) ok "$C.brain.provider" "routed to $prov" ;; *) fail "$C.brain.provider" "expected brain:* provider, got '$prov'" ;; esac
  else
    fail "$C.brain.state" "state=$st err=$(echo "$out"|jq -r '.error // empty' | head -c 80)"
  fi
fi

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

# --- Cloudglue tinycloud see/extract (bound wrapper; image verbs need >= 0.3.7) ---
if require_cred "$C.tinycloud" CLOUDGLUE_API_KEY "skipping"; then
  read -r -a TCV <<<"${OVERCAST_TINYCLOUD_CMD:-tinycloud}"
  if "${TCV[@]}" --version 2>/dev/null | tail -n 1 | jq -e '(.features // []) | index("see.v1")' >/dev/null 2>&1; then
    CASE=$(case_dir see_tinycloud)
    TS="$PWD/examples/providers/tinycloud/see.sh"
    ocrun "$CASE" setup provider see "exec:bash $TS --input {{input}}" --json >/dev/null 2>&1
    cond "see (bound tinycloud see) describes a real image with on-screen text → ready record"
    out="$(OC_TIMEOUT=300 oc "$CASE" see "$FRAME" --ocr --json)"
    save_json "12_see_tinycloud" "$out" >/dev/null
    st="$(echo "$out" | jq -r '.state')"
    if [ "$st" = "ready" ]; then
      assert_nonempty "$C.tinycloud.caption" "$(echo "$out"|jq -r '.payload.caption')" "tinycloud see caption non-empty"
      prov="$(echo "$out" | jq -r '.meta.provider // empty')"
      case "$prov" in tinycloud:*) ok "$C.tinycloud.provider" "routed to $prov" ;; *) fail "$C.tinycloud.provider" "expected tinycloud:* provider, got '$prov'" ;; esac
    else
      fail "$C.tinycloud.state" "state=$st err=$(echo "$out"|jq -r '.error // empty' | head -c 80)"
    fi
    if "${TCV[@]}" --version 2>/dev/null | tail -n 1 | jq -e '(.features // []) | index("extract.images.v1")' >/dev/null 2>&1; then
      cond "see --prompt (bound tinycloud extract) pulls structured facts from a real image"
      pout="$(OC_TIMEOUT=300 oc "$CASE" see "$FRAME" --prompt "briefly: the main activity and setting" --json)"
      save_json "12_see_tinycloud_prompt" "$pout" >/dev/null
      assert_eq "$C.tinycloud.prompt_state" "ready" "$(echo "$pout"|jq -r '.state')" "tinycloud extract --prompt ready"
      [ "$(echo "$pout"|jq -r '.payload.extract != null')" = "true" ] \
        && ok "$C.tinycloud.prompt_facts" "payload.extract populated" \
        || fail "$C.tinycloud.prompt_facts" "payload.extract empty"
      cond "see --detect (bound tinycloud extract) returns boxless presence facts on a real image"
      dout="$(OC_TIMEOUT=300 oc "$CASE" see "$FRAME" --detect "person, vehicle, text" --json)"
      save_json "12_see_tinycloud_detect" "$dout" >/dev/null
      assert_eq "$C.tinycloud.detect_state" "ready" "$(echo "$dout"|jq -r '.state')" "tinycloud extract --detect ready"
      nd="$(echo "$dout" | jq -r '.payload.detections|length')"
      if [ "${nd:-0}" -gt 0 ]; then ok "$C.tinycloud.detect_facts" "$nd boxless facts ($(echo "$dout"|jq -rc '.payload.counts'))"; else fail "$C.tinycloud.detect_facts" "no detections"; fi
    else
      skip "$C.tinycloud.extract" "tinycloud lacks extract.images.v1 (< 0.3.7) — run tinycloud update"
    fi
  else
    skip "$C.tinycloud" "tinycloud lacks see.v1 (< 0.3.7) — run tinycloud update"
  fi
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
