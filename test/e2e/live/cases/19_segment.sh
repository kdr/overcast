#!/usr/bin/env bash
# Real enhance --ops segment: text-prompted instance segmentation into mask +
# cutout evidence via fal sam-3 (FAL_KEY) and/or local GroundingDINO+SAM2 (venv).
# Verifies the fan-out (one record per instance) and crop interop on the parent.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=segment

IMG="$IMAGE_FILE"
if ! have_media "$IMG"; then
  # fall back to a frame of a real video
  SRC="$VIDEO_VISUAL"; have_media "$SRC" || SRC="$VIDEO_SMALL"
  if have_media "$SRC"; then IMG="$SMOKE_DIR/seg_frame.jpg"; frame_jpg "$SRC" 1 "$IMG"; fi
fi
[ -f "$IMG" ] || { skip "$C" "no image (OC_IMAGE or a video to frame)"; exit 0; }
PROMPT="${OC_SEGMENT_PROMPT:-person}"

run_segment() {  # <case> <label>
  local case="$1" label="$2" out pst n ref pid
  cond "$label: --ops segment --prompt \"$PROMPT\" yields mask+cutout evidence per instance"
  out="$(OC_TIMEOUT=600 oc "$case" enhance "$IMG" --ops segment --prompt "$PROMPT" --json)"
  save_json "19_segment_$label" "$out" >/dev/null
  pst="$(echo "$out" | jq -s -r '.[0].state')"
  n="$(echo "$out" | jq -s '[.[] | select(.payload.kind=="cutout" or .payload.kind=="mask")] | length')"
  if [ "$pst" != "ready" ]; then
    fail "$C.$label.state" "state=$pst err=$(echo "$out"|jq -s -r '.[0].error // empty'|head -c 120)"; return
  fi
  if [ "${n:-0}" -lt 1 ]; then
    ok "$C.$label.empty" "ready with 0 instances (nothing matched \"$PROMPT\")"; return
  fi
  ok "$C.$label.instances" "$n segmented instance(s)"
  ref="$(echo "$out" | jq -s -r '[.[] | select(.payload.kind=="cutout" or .payload.kind=="mask")][0].media.ref')"
  [ -f "$ref" ] && ok "$C.$label.file" "cutout/mask file written" || fail "$C.$label.file" "missing: $ref"
  # crop interop: the parent mirrors detections, so `crop <parent> --all` works.
  pid="$(echo "$out" | jq -s -r '.[0].id')"
  cout="$(OC_TIMEOUT=120 oc "$case" crop "$pid" --all --json)"
  save_json "19_segment_${label}_crop" "$cout" >/dev/null
  nc="$(echo "$cout" | jq -s '[.[] | select(.state=="ready")] | length')"
  [ "${nc:-0}" -ge 1 ] && ok "$C.$label.crop" "$nc crop(s) from the segment parent" || fail "$C.$label.crop" "crop found no boxes on the parent"
}

# ---- fal sam-3 --------------------------------------------------------------
if require_cred "$C.fal" FAL_KEY "skipping fal segment"; then
  CASE=$(case_dir segment_fal)
  FE="$PWD/examples/providers/fal/enhance.sh"
  ocrun "$CASE" setup provider enhance "exec:bash $FE {{input}}" --json >/dev/null 2>&1
  run_segment "$CASE" fal
fi

# ---- local GroundingDINO + SAM 2.1 -----------------------------------------
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import transformers, torch, PIL, numpy  # noqa
PY
then
  skip "$C.local" "segmentation deps missing in $PY (scripts/visual-db-uv.sh --segment)"
  exit 0
fi
CASE=$(case_dir segment_local)
LE="$PWD/examples/providers/local/enhance.sh"
ocrun "$CASE" setup provider enhance "exec:bash $LE {{input}}" --json >/dev/null 2>&1
run_segment "$CASE" local
