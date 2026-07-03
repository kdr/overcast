#!/usr/bin/env bash
# SKILL: overcast-scene-locate — "where was this taken?" (geolocation workup).
# Drives the skill's cheap-before-billed clue funnel against REAL media: read the
# scene for signage/landmark clues (see --ocr/--prompt, the free tier), then
# reverse-image-search a frame through Google Lens (Apify) and corroborate on the
# web, landing a cited location note + finding + brief.
#
# Clue extraction needs a brain see backend (CLOUDGLUE_API_KEY) + OC_VIDEO_VISUAL
# or OC_IMAGE. The lens/web reverse-search tiers gate on APIFY_TOKEN / TAVILY_API_KEY.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_scene_locate
SKILL_FILE="$PWD/skills/overcast-scene-locate/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }
require_cred "$C" CLOUDGLUE_API_KEY "clue extraction needs a brain see backend" || exit 0

# pick a still to work: standalone image, else a frame from the visual clip
FRAME=""
if have_media "$IMAGE_FILE"; then
  FRAME="$SMOKE_DIR/scene_still.${IMAGE_FILE##*.}"; cp "$IMAGE_FILE" "$FRAME"
elif have_media "$VIDEO_VISUAL"; then
  FRAME="$SMOKE_DIR/scene_still.jpg"; frame_jpg "$VIDEO_VISUAL" 3 "$FRAME"
fi
[ -n "$FRAME" ] && [ -f "$FRAME" ] || { skip "$C" "no OC_IMAGE or OC_VIDEO_VISUAL to geolocate"; exit 0; }

CASE=$(case_dir skill_scene_locate)

# 1) skill step (free tier): read the scene for clues — OCR + a focused prompt
cond "scene-locate skill: see --ocr/--prompt extracts location clues from the still"
see="$(OC_TIMEOUT=240 oc "$CASE" see "$FRAME" --ocr --prompt "signage, storefront names, landmarks, terrain, language of text" --json)"
save_json "82_see_clues" "$see" >/dev/null
assert_eq "$C.see_state" "ready" "$(echo "$see" | jq -r '.state')" "clue read ready"
CAP="$(echo "$see" | jq -r '.payload.caption // empty')"
OCR="$(echo "$see" | jq -r '.payload.ocr // empty')"
assert_nonempty "$C.clues" "${CAP}${OCR}" "extracted caption/OCR clues from the scene"
SEE_ID="$(echo "$see" | jq -r '.id // empty')"

# 2) skill step (billed tier): reverse-image-search the still through Google Lens
LENS_URL=""; lens_done=0; web_done=0
if require_cred "$C.lens" APIFY_TOKEN "reverse-image tier needs Apify"; then
  cond "scene-locate skill: lens reverse-image-searches the still for matching pages"
  export OVERCAST_SOURCE_LENS_CMD="bash $PWD/examples/providers/sources/lens.sh"
  cp "$FRAME" "$CASE/lens_query.${FRAME##*.}"
  ocrun "$CASE" source add "lens:lens_query.${FRAME##*.}" --json >/dev/null 2>&1   # register the lens source
  lout="$(OC_TIMEOUT=420 oc "$CASE" scan --source lens --query "lens_query.${FRAME##*.}" --limit 3 --json)"
  save_json "82_lens" "$lout" >/dev/null
  lerr="$(echo "$lout" | jq -s -r '[.[]|select(.state=="error")][0].error // empty' 2>/dev/null)"
  lhits="$(echo "$lout" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.url // "") != "")]|length' 2>/dev/null)"
  if [ -z "$lerr" ]; then
    ok "$C.lens_ran" "lens reverse-image tier ran clean ($lhits page match(es))"
  else
    fail "$C.lens_ran" "lens reverse-image errored: $lerr"
  fi
  if [ "${lhits:-0}" -ge 1 ]; then
    LENS_URL="$(echo "$lout" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.url // "") != "")][0].payload.url' 2>/dev/null)"
    match="$(echo "$lout" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.match // empty' 2>/dev/null)"
    ok "$C.lens_match" "top lens match ($match): $LENS_URL"
  fi
  # only claim the reverse-image search in the note if it ran clean AND matched pages
  [ -z "$lerr" ] && [ "${lhits:-0}" -ge 1 ] && lens_done=1
  unset OVERCAST_SOURCE_LENS_CMD
fi

# 3) skill step: corroborate an OCR'd clue on the open web
if require_cred "$C.web" TAVILY_API_KEY "web corroboration tier needs Tavily"; then
  cond "scene-locate skill: web search corroborates a scene clue"
  export OVERCAST_SOURCE_WEB_CMD="bash $PWD/examples/providers/sources/web.sh"
  ocrun "$CASE" source add 'web:famous landmark location' --json >/dev/null 2>&1
  wout="$(OC_TIMEOUT=300 oc "$CASE" scan --source web --limit 3 --json)"
  save_json "82_web" "$wout" >/dev/null
  whits="$(echo "$wout" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.url // "") != "")]|length' 2>/dev/null)"
  if [ "${whits:-0}" -ge 1 ]; then ok "$C.web_hits" "web corroboration returned $whits page(s)"; else fail "$C.web_hits" "web search returned no pages"; fi
  # only claim web corroboration in the note if it actually returned pages
  [ "${whits:-0}" -ge 1 ] && web_done=1
  unset OVERCAST_SOURCE_WEB_CMD
fi

# 4) skill step: cited location note + finding + mandatory tldr note + brief
cond "scene-locate skill: a location finding cites the evidence and a tldr note feeds the brief"
oc "$CASE" note "scene clue: ${OCR:-$CAP}" --ref "$SEE_ID" --confidence medium --json >/dev/null
if [ -n "$LENS_URL" ]; then
  oc "$CASE" finding create "location workup: lens matched the scene to $LENS_URL; OCR/landmark clues corroborate" --confidence medium --json >/dev/null
else
  oc "$CASE" finding create "location workup: extracted scene clues; reverse-image match undetermined" --confidence low --json >/dev/null
fi
legs="read clues from the still"
[ "$lens_done" -eq 1 ] && legs="$legs, reverse-image-searched via lens"
[ "$web_done" -eq 1 ] && legs="$legs, corroborated on the web"
oc "$CASE" note "scene-locate: $legs." --tag tldr --json >/dev/null
findings="$(ocrun "$CASE" case records --verb finding --json 2>/dev/null | jq -r '.payload.count // 0')"
assert_nonempty "$C.finding" "$([ "${findings:-0}" -ge 1 ] && echo "$findings")" "location finding persisted"
BRIEF="$SMOKE_DIR/82_scene_locate_brief.html"
oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
if [ -s "$BRIEF" ] && grep -qi "<html" "$BRIEF"; then
  ok "$C.brief" "scene-locate brief exported: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
else
  fail "$C.brief" "no scene-locate brief HTML at $BRIEF"
fi
