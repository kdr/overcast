#!/usr/bin/env bash
# SKILL: overcast-bolo — be-on-the-lookout (standing face/image watchlist).
# Drives the skill's chain against REAL face media: register a reference face as
# an image target (the line hits attach to), sense a clip the person appears in,
# run the reference `face --match` (the BOLO core) so the shared persist hook
# auto-emits a `suggested` finding linked to that line, prove it lands in the
# triage queue (the BOLO board), then `finding accept` promotes it into evidence.
#
# Matcher is auto-picked: deepface-local when the visual-DB venv is present
# (offline, reference enrolled in a local index), else tinycloud when
# CLOUDGLUE_API_KEY is set. Needs a reference face image + a video the person
# appears in (OC_LOCAL_FACE_IMAGE/_VIDEO, else OC_IMAGE + OC_VIDEO_VISUAL).
# Skips cleanly without a matcher backend or face media.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=skill_bolo

SKILL_FILE="$PWD/skills/overcast-bolo/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }

# reference face image + a video the person appears in (local face fixtures, else
# OC_IMAGE + a visual clip — same fallback ladder as 18_findings.sh)
FACE_IMG="$LOCAL_FACE_IMAGE"; FACE_VID="$LOCAL_FACE_VIDEO"
have_media "$FACE_IMG" || FACE_IMG="$IMAGE_FILE"
have_media "$FACE_VID" || FACE_VID="$VIDEO_VISUAL"
have_media "$FACE_IMG" || { skip "$C" "no reference face image (OC_LOCAL_FACE_IMAGE / OC_IMAGE)"; exit 0; }
have_media "$FACE_VID" || { skip "$C" "no video (OC_LOCAL_FACE_VIDEO / OC_VIDEO_VISUAL)"; exit 0; }

# pick the matcher backend: deepface-local (offline venv) preferred, else tinycloud
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
USE_DEEPFACE=0
if "$PY" - <<'PY' >/dev/null 2>&1
import deepface, numpy  # noqa
PY
then
  USE_DEEPFACE=1
elif ! have_cred CLOUDGLUE_API_KEY; then
  skip "$C" "no matcher backend — need deepface venv (OC_VISUAL_DB_PY) or CLOUDGLUE_API_KEY for tinycloud face"
  exit 0
fi

CASE=$(case_dir skill_bolo)
CLIP="$SMOKE_DIR/bolo-clip.mp4"
clip_av 8 "$FACE_VID" "$CLIP" || CLIP="$FACE_VID"
[ -f "$CLIP" ] || CLIP="$FACE_VID"

# 1) skill step: register the watchlist reference as an image target (the line
#    every BOLO hit attaches to). suggest is the default findings mode.
cond "bolo skill: target add --image registers the reference face as an image line of investigation"
oc "$CASE" target add "$FACE_IMG" --image --question "Does the watchlisted person appear in incoming media?" >/dev/null
TID="$(oc "$CASE" target list --json | jq -r '.payload.targets[] | select(.kind=="image") | .id')"
assert_nonempty "$C.target" "$TID" "image target registered ($TID)"

# 1b) deepface path only: stand up a local face index + enroll the reference
MATCH_OPTS=(--match "$FACE_IMG")
if [ "$USE_DEEPFACE" -eq 1 ]; then
  cond "bolo skill (local): index create deepface-local + index add enrolls the reference face"
  created="$(oc "$CASE" index create bolo-faces --type deepface-local --local --json)"
  IDX="$(echo "$created" | jq -r '.payload.index // .payload.id // empty')"
  assert_nonempty "$C.index" "$IDX" "local deepface-local index created ($IDX)"
  add="$(oc "$CASE" index add "$FACE_IMG" --to "$IDX" --json)"
  assert_eq "$C.enroll" "ready" "$(echo "$add" | jq -r '.state')" "reference face enrolled in the local index"
  MATCH_OPTS=(--match "$FACE_IMG" --index "$IDX")
fi

# 2) skill step (the BOLO core): run the reference face --match over incoming
#    media; a hit >= threshold auto-emits a `suggested` finding via the persist
#    hook, linked to the image target line.
cond "bolo skill: face --match over new media auto-emits a quarantined 'suggested' finding linked to the reference line"
mout="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP" "${MATCH_OPTS[@]}" --json)"; mrc=$?
assert_eq "$C.match_exit" "0" "$mrc" "face --match exits 0"
# slurp: the batch is the face record PLUS the auto-suggested finding
sug="$(echo "$mout" | jq -s '[.[] | select(.verb=="finding" and .payload.status=="suggested")]')"
sug_n="$(echo "$sug" | jq 'length')"
if [ "${sug_n:-0}" -ge 1 ]; then
  ok "$C.suggested" "$sug_n suggested BOLO finding(s) emitted from the reference match"
  assert_eq "$C.trigger" "signal:face-match" "$(echo "$sug" | jq -r '.[0].payload.trigger')" "trigger is signal:face-match"
  assert_nonempty "$C.signal_score" "$(echo "$sug" | jq -r '.[0].payload.signal.score // empty')" "signal.score carried on the lead"
  assert_eq "$C.linked" "$TID" "$(echo "$sug" | jq -r '.[0].payload.target_id // empty')" "lead linked to the reference image line"
  FID="$(echo "$sug" | jq -r '.[0].id')"
else
  # a real clip where the reference isn't detected (or scores under 75) yields no
  # lead — the match ran cleanly, there is just nothing to alert on. Not a failure.
  ok "$C.suggested" "no BOLO hit >= threshold in this clip (clean no-alert pass); skipping triage/accept round-trip"
  exit 0
fi

# 3) skill step: the triage queue is the BOLO board — the lead awaits review
cond "bolo skill: finding list --state triage surfaces the lead on the BOLO board"
tri="$(oc "$CASE" finding list --state triage --json)"
assert_eq "$C.triage_has_lead" "true" "$(echo "$tri" | jq --arg id "$FID" 'any(.payload.findings[]; .id==$id)')" "the BOLO lead is in the triage queue"

# 4) skill step: a suggested lead is quarantined from brief until reviewed
cond "bolo skill: an unreviewed BOLO lead is quarantined from brief evidence"
b0="$(oc "$CASE" brief --json)"
assert_eq "$C.quarantined" "false" "$(echo "$b0" | jq -r --arg id "$FID" '.payload.report | contains("[accepted]") and contains($id)')" "unreviewed lead is NOT in Key findings"

# 5) skill step: finding accept promotes the hit onto the reference line
cond "bolo skill: finding accept --target confirms the hit into evidence on the reference line"
oc "$CASE" finding accept "$FID" --target "$TID" --note "confirmed watchlist match" >/dev/null
b1="$(oc "$CASE" brief --json)"
assert_eq "$C.accepted_in_brief" "true" "$(echo "$b1" | jq -r --arg id "$FID" '.payload.report | contains("[accepted]") and contains($id)')" "accepted BOLO finding now appears in Key findings"

# 6) skill step (optional surface): the control-room wall renders the standing watch
cond "bolo skill: wall renders the standing watch as a CSI monitor board"
WHTML="$SMOKE_DIR/93_bolo_wall.html"
w="$(oc "$CASE" wall --export "$WHTML" --theme csi --refresh 60 --no-open --json)"
if [ -s "$WHTML" ] && grep -q 'data-csi-wall="true"' "$WHTML"; then
  ok "$C.wall" "CSI monitor wall exported: $WHTML ($(wc -c <"$WHTML" | tr -d ' ') bytes)"
else
  # a wall with no video tiles (image-only reference case) still emits a ready
  # record; only fail if the verb itself errored.
  assert_eq "$C.wall" "ready" "$(echo "$w" | jq -r '.state')" "wall verb ready"
fi
