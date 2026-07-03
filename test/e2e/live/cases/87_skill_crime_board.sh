#!/usr/bin/env bash
# SKILL: overcast-crime-board — the red-string corkboard.
# Drives the skill's chain against REAL media: materialize face crops as evidence
# cards, link people across the case with the local face DB, connect themes with
# CLIP semantic search, then render the two visual surfaces — a CSI brief (the
# corkboard) and a control-room wall.
#
# Face crops need Cloudglue (tinycloud face --thumbnails) + a real clip with people
# (OC_VIDEO_OBJECTS). The cluster leg gates on the deepface venv; the similar leg on
# the open_clip venv; object crops on DETECT_PY.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_crime_board
SKILL_FILE="$PWD/skills/overcast-crime-board/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }
require_cred "$C" CLOUDGLUE_API_KEY "crime board needs a face backend" || exit 0
SRC="$VIDEO_OBJECTS"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" || { skip "$C" "no OC_VIDEO_OBJECTS/OC_VIDEO_VISUAL"; exit 0; }

CASE=$(case_dir skill_crime_board)
CLIP="$SMOKE_DIR/crimeboard_clip.mp4"; clip_av 10 "$SRC" "$CLIP"

# 1) skill step: materialize evidence cards — face detections → crops
cond "crime-board skill: face --thumbnails then crop materializes face evidence cards"
fd="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP" --thumbnails --json)"
save_json "87_face" "$fd" >/dev/null
FID="$(echo "$fd" | jq -r '.id // empty')"
fcount="$(echo "$fd" | jq -r '.payload.count // 0')"
assert_eq "$C.face_state" "ready" "$(echo "$fd" | jq -r '.state')" "face detect ready ($fcount box(es))"
if [ -n "$FID" ] && [ "${fcount:-0}" -ge 1 ]; then
  crop="$(oc "$CASE" crop "$FID" --all --class face --square --pad 0.1 --json)"
  save_json "87_crop" "$crop" >/dev/null
  # crop --all emits a stream of one media.crop record per crop
  crop_ready="$(echo "$crop" | jq -sr 'if length>0 and all(.[];.state=="ready") then "ready" else "notready" end')"
  ccount="$(echo "$crop" | jq -s '[.[]|select(.verb=="crop" and .state=="ready")]|length')"
  assert_eq "$C.crop_state" "ready" "$crop_ready" "crop stream all ready"
  assert_nonempty "$C.crops" "$([ "${ccount:-0}" -ge 1 ] && echo "$ccount")" "materialized $ccount face crop card(s)"
else
  skip "$C.crop" "no face boxes to crop in this clip"
fi

# 2) skill step (object cards): see --detect → crop (needs a bound detector)
if [ -n "${DETECT_PY:-}" ]; then
  cond "crime-board skill: see --detect object cards (needs a detector)"
  export OVERCAST_SEE_DETECT_PY="$DETECT_PY"
  det="$(OC_TIMEOUT=300 oc "$CASE" see "$CLIP" --detect "person, car, bag" --json)"
  DID="$(echo "$det" | jq -r '.id // empty')"
  [ -n "$DID" ] && oc "$CASE" crop "$DID" --all --kind object --json >/dev/null 2>&1
  ok "$C.object_cards" "object detection card leg ran"
else
  skip "$C.object_cards" "no DETECT_PY — object crops need a bound detector"
fi

# 3) skill step: draw strings — link the same person across the case (local face DB)
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if "$PY" - <<'PY' >/dev/null 2>&1
import deepface, numpy  # noqa
PY
then
  cond "crime-board skill: cluster add links people across the case"
  cid="$(oc "$CASE" index create people --type face-cluster --local --json | jq -r '.payload.index // .payload.id // empty')"
  if [ -n "$cid" ]; then
    add="$(OC_TIMEOUT=600 oc "$CASE" cluster add "$CLIP" --index "$cid" --fps 0.5 --max-frames 8 --json)"
    save_json "87_cluster" "$add" >/dev/null
    assert_eq "$C.cluster_state" "ready" "$(echo "$add" | jq -r '.state')" "cluster add linked $(echo "$add"|jq -r '.payload.count // 0') face(s)"
  fi
else
  skip "$C.cluster" "no deepface venv — person-linking DB skipped"
fi

# 4) skill step: connect themes with CLIP semantic search
if "$PY" - <<'PY' >/dev/null 2>&1
import open_clip, torch  # noqa
PY
then
  cond "crime-board skill: similar (CLIP) connects the case by visual theme"
  sid="$(oc "$CASE" index create scenes --type basic-clip --local --json | jq -r '.payload.index // .payload.id // empty')"
  if [ -n "$sid" ]; then
    sa="$(OC_TIMEOUT=600 oc "$CASE" similar add "$CLIP" --index "$sid" --json)"
    save_json "87_similar_add" "$sa" >/dev/null
    assert_eq "$C.similar_add" "ready" "$(echo "$sa" | jq -r '.state')" "clip embedded into the CLIP DB"
    ss="$(OC_TIMEOUT=300 oc "$CASE" similar search "a person at a work site" --index "$sid" --json)"
    save_json "87_similar_search" "$ss" >/dev/null
    assert_eq "$C.similar_search" "ready" "$(echo "$ss" | jq -r '.state')" "text→image thematic search ran"
  fi
else
  skip "$C.similar" "no open_clip venv — thematic CLIP links skipped"
fi

# 5) skill step: record the connections as notes so they land on the board
cond "crime-board skill: connection notes tie the evidence together"
oc "$CASE" note "connection: subject appears across the case media; visual theme links the clips" --ref "${FID:-}" --tag connection --confidence medium --json >/dev/null
oc "$CASE" note "crime-board: materialized face cards, linked people via the local face DB, connected themes with CLIP." --tag tldr --json >/dev/null

# 6) skill step: the two visual surfaces — CSI brief (corkboard) + wall (monitor bank)
cond "crime-board skill: render the corkboard (CSI brief) and the control-room wall"
BOARD="$SMOKE_DIR/87_crime_board.html"
oc "$CASE" brief --theme csi --export "$BOARD" --json >/dev/null
if [ -s "$BOARD" ] && grep -q 'data-overcast-theme="csi"' "$BOARD"; then
  ok "$C.board" "CSI evidence board exported: $BOARD ($(wc -c <"$BOARD" | tr -d ' ') bytes)"
else
  fail "$C.board" "no CSI board HTML at $BOARD"
fi
WHTML="$SMOKE_DIR/87_crime_board_wall.html"
w="$(oc "$CASE" wall --theme csi --export "$WHTML" --no-open --json)"
save_json "87_wall" "$w" >/dev/null
if [ "$(echo "$w" | jq -r '.state')" = "ready" ] && [ -s "$WHTML" ]; then
  ok "$C.wall" "control-room wall exported: $WHTML ($(echo "$w" | jq -r '.payload.tiles // 0') tile(s))"
else
  fail "$C.wall" "wall not rendered"
fi
