#!/usr/bin/env bash
# SKILL: overcast-enhance-and-resolve — "zoom in… enhance" (frame forensics).
# Drives the skill's honest chain against a REAL clip: pin the moment, run the
# ffmpeg enhance ops, RE-READ the enhanced output (see --ocr on the enhanced frame),
# and record what was recovered with provenance (ops applied + source record).
# Proves the enhance→re-analyze chain and that recovered text is cited as a lead.
#
# Enhance is bundled ffmpeg (free); the re-read needs a brain see backend
# (CLOUDGLUE_API_KEY). The optional AI-restoration leg gates on FAL_KEY.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_enhance
SKILL_FILE="$PWD/skills/overcast-enhance-and-resolve/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }

CLIP="$SMOKE_DIR/enhance_raw.mp4"
SRC="$VIDEO_SMALL"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" && clip_av 8 "$SRC" "$CLIP"
[ -f "$CLIP" ] || { skip "$C" "no OC_VIDEO_SMALL/OC_VIDEO_VISUAL"; exit 0; }

CASE=$(case_dir skill_enhance)

# 1) skill step: pin the moment worth resolving (needs a source record → watch)
WID=""
if require_cred "$C.watch" CLOUDGLUE_API_KEY "pinning the moment needs a watch record"; then
  cond "enhance skill: watch the raw clip and pin the unreadable moment"
  wa="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP" --json)"
  WID="$(echo "$wa" | jq -r '.id // empty')"
  assert_eq "$C.watch" "ready" "$(echo "$wa" | jq -r '.state')" "raw clip watched"
  [ -n "$WID" ] && oc "$CASE" note "moment unreadable, want to resolve" --ref "$WID" --at 2-5 --json >/dev/null
fi

# 2) skill step: run the enhance ops (bundled ffmpeg)
cond "enhance skill: enhance --ops denoise,upscale produces a chainable media.enhanced record"
enh="$(OC_TIMEOUT=240 oc "$CASE" enhance "$CLIP" --ops denoise,upscale --json)"
save_json "83_enhance" "$enh" >/dev/null
assert_eq "$C.enh_state" "ready" "$(echo "$enh" | jq -r '.state')" "enhance ready"
assert_eq "$C.enh_provider" "ffmpeg" "$(echo "$enh" | jq -r '.meta.provider // empty')" "internal ffmpeg provider"
ENH_ID="$(echo "$enh" | jq -r '.id // empty')"
ENH_REF="$(echo "$enh" | jq -r '.media.ref // empty')"
if [ -n "$ENH_REF" ] && [ -f "$ENH_REF" ]; then ok "$C.enh_file" "enhanced output written ($(basename "$ENH_REF"))"; else fail "$C.enh_file" "no enhanced file at ${ENH_REF:-none}"; fi

# 3) skill step: RE-READ the enhanced output (see --ocr on the enhanced frame)
if require_cred "$C.reread" CLOUDGLUE_API_KEY "re-reading the enhanced frame needs a brain see backend" && [ -n "$ENH_ID" ]; then
  cond "enhance skill: see --ocr re-reads the ENHANCED frame (frame://<enhanced>@t)"
  see="$(OC_TIMEOUT=240 oc "$CASE" see "frame://$ENH_ID@2" --ocr --prompt "text, license plate, signage" --json)"
  save_json "83_reread" "$see" >/dev/null
  assert_eq "$C.reread_state" "ready" "$(echo "$see" | jq -r '.state')" "re-read of enhanced frame ready"
  SEE_ID="$(echo "$see" | jq -r '.id // empty')"
  txt="$(echo "$see" | jq -r '(.payload.caption // "") + (.payload.ocr // "")')"
  assert_nonempty "$C.reread_text" "$txt" "recovered caption/OCR from the enhanced frame"
fi

# 4) skill step (optional crop): the skill's chain is enhance → see --detect → crop.
# `crop` needs detection boxes, so bind an OWLv2 detector and run see --detect on the
# ENHANCED frame (the --ocr record from step 3 carries no detections to crop).
if [ -n "${DETECT_PY:-}" ] && [ -n "${ENH_ID:-}" ]; then
  cond "enhance skill: see --detect on the enhanced frame, then crop the resolved region"
  DET="$PWD/examples/providers/detect/detect.py"
  ocrun "$CASE" setup provider see "exec:$DETECT_PY $DET" --json >/dev/null 2>&1
  det="$(OC_TIMEOUT=240 oc "$CASE" see "frame://$ENH_ID@2" --detect "license plate, text, sign" --json)"
  save_json "83_detect" "$det" >/dev/null
  if [ "$(echo "$det" | jq -r '.state')" = "ready" ] && [ "$(echo "$det" | jq -r '.payload.detections | length')" -ge 1 ]; then
    DID="$(echo "$det" | jq -r '.id')"
    crop="$(oc "$CASE" crop "$DID" --all --pad 0.15 --square --json)"
    nready="$(echo "$crop" | jq -s '[.[]|select(.verb=="crop" and .state=="ready")]|length')"
    if [ "${nready:-0}" -ge 1 ]; then ok "$C.crop_state" "cropped $nready resolved region(s) from the detector"; else fail "$C.crop_state" "detections found but crop emitted no ready records"; fi
  else
    fail "$C.crop_state" "see --detect on the enhanced frame produced no detections (state=$(echo "$det"|jq -r '.state'))"
  fi
else
  skip "$C.crop" "no DETECT_PY — crop of a --detect region needs a bound detector"
fi

# 5) skill step: provenance-honest finding + before/after notes + brief
cond "enhance skill: the finding states the enhancement provenance (ops + source), recovered text is a lead"
[ -n "$WID" ] && oc "$CASE" note "before: moment illegible on $WID" --ref "$WID" --at 2-5 --json >/dev/null
[ -n "${SEE_ID:-}" ] && oc "$CASE" note "after denoise+upscale: re-read the enhanced frame (recovered text is a lead, not proof)" --ref "$ENH_ID" --json >/dev/null
# the finding/note name only the legs that ran: pin + re-read need a brain backend;
# the ffmpeg enhance always runs.
if [ -n "${SEE_ID:-}" ]; then
  oc "$CASE" finding create "resolved a moment via enhance denoise,upscale then re-read the enhanced frame — recovered text is low-confidence (interpolation cannot invent detail)" --ref "$SEE_ID" --confidence low --json >/dev/null
else
  oc "$CASE" finding create "enhanced a moment via ffmpeg denoise,upscale — re-read requires a brain see backend (interpolation cannot invent detail)" --ref "${ENH_ID:-}" --confidence low --json >/dev/null
fi
did="ran ffmpeg denoise+upscale"
[ -n "$WID" ] && did="pinned the moment, $did"
[ -n "${SEE_ID:-}" ] && did="$did, re-read the enhanced frame with OCR"
oc "$CASE" note "enhance-and-resolve: $did." --tag tldr --json >/dev/null
BRIEF="$SMOKE_DIR/83_enhance_brief.html"
oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
if [ -s "$BRIEF" ] && grep -qi "<html" "$BRIEF"; then
  ok "$C.brief" "enhance brief exported: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
else
  fail "$C.brief" "no enhance brief HTML at $BRIEF"
fi

# 6) skill caveat leg: bind a model provider for real AI restoration (fal esrgan)
if require_cred "$C.fal" FAL_KEY "AI-restoration caveat leg needs fal"; then
  cond "enhance skill caveat: a bound fal esrgan provider does real restoration (not interpolation)"
  FRAME="$SMOKE_DIR/enhance_frame.jpg"; frame_jpg "$CLIP" 1 "$FRAME"
  FE="$PWD/examples/providers/fal/enhance.sh"
  ocrun "$CASE" setup provider enhance "exec:bash $FE {{input}}" --json >/dev/null 2>&1
  fo="$(OC_TIMEOUT=240 oc "$CASE" enhance "$FRAME" --json)"
  st="$(echo "$fo" | jq -r '.state')"
  [ "$st" = "ready" ] && ok "$C.fal_state" "fal esrgan restoration ready" || fail "$C.fal_state" "state=$st err=$(echo "$fo"|jq -r '.error // empty'|head -c 80)"
fi
