#!/usr/bin/env bash
# Real crop: materialize face/object detections from real media into inspectable
# JPEGs under the live smoke report folder.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=crop
CROP_DIR="$SMOKE_DIR/crops"
mkdir -p "$CROP_DIR"
made=0
object_made=0

# --- face detections from tinycloud -----------------------------------------
if have_cred CLOUDGLUE_API_KEY && { have_media "$VIDEO_SMALL" || have_media "$VIDEO_VISUAL"; }; then
  CASE=$(case_dir crop_face)
  if have_media "$VIDEO_SMALL"; then
    CLIP="$VIDEO_SMALL"
  else
    CLIP="$SMOKE_DIR/crop-face-clip.mp4"
    clip_av 8 "$VIDEO_VISUAL" "$CLIP" || CLIP="$VIDEO_VISUAL"
    [ -f "$CLIP" ] || CLIP="$VIDEO_VISUAL"
  fi

  cond "crop materializes real tinycloud face detections into JPEG evidence"
  fout="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP" --thumbnails --json)"
  save_json "15_crop_face_detect" "$fout" >/dev/null
  st="$(echo "$fout" | jq -r '.state')"
  if [ "$st" = "ready" ]; then
    nf="$(echo "$fout" | jq -r '.payload.faces | length')"
    if [ "${nf:-0}" -gt 0 ]; then
      fid="$(echo "$fout" | jq -r '.id')"
      cout="$(OC_TIMEOUT=120 oc "$CASE" crop "$fid" --all --limit 6 --square --pad 0.1 --out "$CROP_DIR" --json)"
      save_json "15_crop_face" "$cout" >/dev/null
      nready="$(echo "$cout" | jq -s '[.[] | select(.state=="ready")] | length')"
      if [ "${nready:-0}" -gt 0 ]; then
        made=$((made + nready))
        ok "$C.face.crops" "$nready face crop(s) written to $CROP_DIR"
      else
        fail "$C.face.crops" "no ready crop records from $nf face detections"
      fi
    else
      skip "$C.face" "face detect ready but found no faces"
    fi
  else
    fail "$C.face.detect" "face state=$st err=$(echo "$fout" | jq -r '.error // empty' | head -c 100)"
  fi
else
  skip "$C.face" "needs CLOUDGLUE_API_KEY and OC_VIDEO_SMALL or OC_VIDEO_VISUAL"
fi

# --- object detections from local detector ----------------------------------
DETECT_PY="${DETECT_PY:-}"
if [ -z "$DETECT_PY" ]; then
  for p in /tmp/oc-locate-venv/bin/python python3; do
    if "$p" -c "import torch,transformers,scipy,PIL" >/dev/null 2>&1; then DETECT_PY="$p"; break; fi
  done
fi
if [ -n "$DETECT_PY" ]; then
  CASE=$(case_dir crop_object)
  DET="$PWD/examples/providers/detect/detect.py"
  ocrun "$CASE" setup provider see "exec:$DETECT_PY $DET" --json >/dev/null 2>&1
  if have_media "$VIDEO_OBJECTS"; then
    OBJ_INPUT="$VIDEO_OBJECTS"
  elif have_media "$IMAGE_FILE"; then
    OBJ_INPUT="$IMAGE_FILE"
  elif have_media "$VIDEO_VISUAL"; then
    OBJ_INPUT="$VIDEO_VISUAL"
  else
    OBJ_INPUT=""
  fi
  if [ -n "$OBJ_INPUT" ]; then
    cond "crop materializes real open-vocabulary object detections into JPEG evidence"
    dout="$(OC_TIMEOUT=300 oc "$CASE" see "$OBJ_INPUT" --detect "person, car, vehicle, helmet, hard hat" --json)"
    save_json "15_crop_object_detect" "$dout" >/dev/null
    st="$(echo "$dout" | jq -r '.state')"
    if [ "$st" = "ready" ]; then
      nd="$(echo "$dout" | jq -r '.payload.detections | length')"
      if [ "${nd:-0}" -gt 0 ]; then
        did="$(echo "$dout" | jq -r '.id')"
        cout="$(OC_TIMEOUT=120 oc "$CASE" crop "$did" --all --limit 6 --pad 0.08 --out "$CROP_DIR" --json)"
        save_json "15_crop_object" "$cout" >/dev/null
        nready="$(echo "$cout" | jq -s '[.[] | select(.state=="ready")] | length')"
        if [ "${nready:-0}" -gt 0 ]; then
          made=$((made + nready))
          object_made=$((object_made + nready))
          ok "$C.object.crops" "$nready object crop(s) written to $CROP_DIR"
        else
          fail "$C.object.crops" "no ready crop records from $nd detections"
        fi
      else
        skip "$C.object" "detector ready but found no objects"
      fi
    else
      fail "$C.object.detect" "see state=$st err=$(echo "$dout" | jq -r '.error // empty' | head -c 100)"
    fi
  else
    skip "$C.object" "no OC_VIDEO_OBJECTS/OC_IMAGE/OC_VIDEO_VISUAL"
  fi
else
  skip "$C.object" "no python with torch/transformers/scipy (DETECT_PY)"
fi

# --- object detections from configured fal.ai model --------------------------
if [ "$object_made" -eq 0 ] && have_cred FAL_KEY; then
  CASE=$(case_dir crop_object_fal)
  if have_media "$VIDEO_OBJECTS"; then
    OBJ_FRAME="$SMOKE_DIR/crop-object-fal-frame.jpg"
    ffmpeg -y -ss 1 -i "$VIDEO_OBJECTS" -frames:v 1 -q:v 2 "$OBJ_FRAME" >/dev/null 2>&1 || OBJ_FRAME=""
  elif have_media "$IMAGE_FILE"; then
    OBJ_FRAME="$IMAGE_FILE"
  elif have_media "$VIDEO_VISUAL"; then
    OBJ_FRAME="$SMOKE_DIR/crop-object-fal-frame.jpg"
    ffmpeg -y -ss 1 -i "$VIDEO_VISUAL" -frames:v 1 -q:v 2 "$OBJ_FRAME" >/dev/null 2>&1 || OBJ_FRAME=""
  else
    OBJ_FRAME=""
  fi
  if [ -n "$OBJ_FRAME" ] && [ -f "$OBJ_FRAME" ]; then
    cond "crop materializes real fal open-vocabulary object detections into JPEG evidence"
    mime="image/jpeg"
    b64="$(base64 -i "$OBJ_FRAME" 2>/dev/null | tr -d '\n')" || b64="$(base64 "$OBJ_FRAME" | tr -d '\n')"
    prompt="${OC_OBJECT_PROMPT:-person, hard hat, helmet, safety vest, car, vehicle}"
    req="$(jq -nc --arg image_url "data:$mime;base64,$b64" --arg text_input "$prompt" '{image_url:$image_url,text_input:$text_input}')"
    fresp="$(curl -s -m 120 -X POST "https://fal.run/fal-ai/florence-2-large/open-vocabulary-detection" \
      -H "Authorization: Key ${FAL_KEY:-${FAL_API_KEY:-}}" \
      -H "Content-Type: application/json" \
      -d "$req")"
    printf '%s\n' "$fresp" > "$SMOKE_DIR/15_crop_object_fal_response.json"
    if echo "$fresp" | jq -e '.results.bboxes | length > 0' >/dev/null 2>&1; then
      rid="$(node --import tsx - "$CASE" "$OBJ_FRAME" "$SMOKE_DIR/15_crop_object_fal_response.json" <<'NODE'
import { readFileSync } from "node:fs";
import { openCase } from "./src/case.ts";
import { makeRecord } from "./src/record.ts";
const [, , dir, media, responsePath] = process.argv;
const c = openCase(dir);
c.ensure();
const response = JSON.parse(readFileSync(responsePath, "utf8"));
const detections = (response.results?.bboxes ?? []).map((b, i) => ({
  detection_id: `fal_${i + 1}`,
  label: b.label ?? "object",
  score: typeof b.score === "number" ? b.score : 1,
  box: { x: b.x, y: b.y, width: b.w, height: b.h },
  source: media,
}));
const counts = Object.fromEntries(detections.map((d) => [d.label, 1]));
const rec = makeRecord({
  verb: "see",
  payload: { summary: `fal open-vocabulary detections: ${detections.length}`, detections, counts, provider_response: response },
  media: { ref: media },
  meta: { provider: "fal:florence-2-open-vocabulary" },
  state: "ready",
});
c.writeRecord(rec);
process.stdout.write(rec.id);
NODE
)"
      cout="$(OC_TIMEOUT=120 oc "$CASE" crop "$rid" --all --limit 6 --pad 0.08 --out "$CROP_DIR" --json)"
      save_json "15_crop_object_fal" "$cout" >/dev/null
      nready="$(echo "$cout" | jq -s '[.[] | select(.state=="ready")] | length')"
      if [ "${nready:-0}" -gt 0 ]; then
        made=$((made + nready))
        object_made=$((object_made + nready))
        ok "$C.object.fal.crops" "$nready fal object crop(s) written to $CROP_DIR"
      else
        fail "$C.object.fal.crops" "fal returned detections but crop emitted no ready records"
      fi
    else
      skip "$C.object.fal" "fal returned no object boxes"
    fi
  else
    skip "$C.object.fal" "no OC_VIDEO_OBJECTS/OC_IMAGE/OC_VIDEO_VISUAL frame available"
  fi
fi

count="$(find "$CROP_DIR" -path "$CROP_DIR/.frames" -prune -o -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' \) -print | wc -l | tr -d ' ')"
if [ "${count:-0}" -eq 0 ]; then
  if have_media "$IMAGE_FILE"; then
    FALLBACK_MEDIA="$IMAGE_FILE"; FALLBACK_AT=""
  elif have_media "$VIDEO_OBJECTS"; then
    FALLBACK_MEDIA="$VIDEO_OBJECTS"; FALLBACK_AT="1"
  elif have_media "$VIDEO_VISUAL"; then
    FALLBACK_MEDIA="$VIDEO_VISUAL"; FALLBACK_AT="1"
  else
    FALLBACK_MEDIA=""
  fi
  if [ -n "$FALLBACK_MEDIA" ]; then
    CASE=$(case_dir crop_region)
    cond "crop materializes a deterministic central region from configured real media"
    rid="$(node --import tsx - "$CASE" "$FALLBACK_MEDIA" "$FALLBACK_AT" <<'NODE'
import { openCase } from "./src/case.ts";
import { makeRecord } from "./src/record.ts";
const [, , dir, media, atRaw] = process.argv;
const c = openCase(dir);
c.ensure();
const at = atRaw ? Number(atRaw) : undefined;
const detection = { label: "inspection-region", score: 1, box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
if (at !== undefined) detection.at = at;
const rec = makeRecord({
  verb: "see",
  payload: { summary: "synthetic central detection over configured real media", detections: [detection], counts: { "inspection-region": 1 } },
  media: { ref: media, at },
  state: "ready",
});
c.writeRecord(rec);
process.stdout.write(rec.id);
NODE
)"
    cout="$(OC_TIMEOUT=120 oc "$CASE" crop "$rid" --all --out "$CROP_DIR" --json)"
    save_json "15_crop_region" "$cout" >/dev/null
    nready="$(echo "$cout" | jq -s '[.[] | select(.state=="ready")] | length')"
    if [ "${nready:-0}" -gt 0 ]; then
      made=$((made + nready))
      ok "$C.region.crops" "$nready fallback real-media crop(s) written to $CROP_DIR"
    else
      fail "$C.region.crops" "fallback real-media crop failed"
    fi
  fi
fi

count="$(find "$CROP_DIR" -path "$CROP_DIR/.frames" -prune -o -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' \) -print | wc -l | tr -d ' ')"
if [ "${count:-0}" -gt 0 ]; then
  ok "$C.folder" "$count crop image(s) available for inspection in $CROP_DIR"
elif [ "$made" -eq 0 ]; then
  skip "$C.folder" "no real detections available to crop in this environment"
fi
