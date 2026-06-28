#!/usr/bin/env bash
# Real-media case setup management: save setup with a configured local video,
# edit it, and verify setup history stays operational-only.
set -uo pipefail
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=case_setup

CASE=$(case_dir case_setup)
if ! have_media "$VIDEO_SMALL"; then
  skip "$C.video" "no OC_VIDEO_SMALL — real-video setup case"
  exit 0
fi

cond "case setup plan previews real-video routing without saving"
plan="$(oc "$CASE" case setup plan --name "live-setup-case" --target "live target" --source "web:live target" --video "$VIDEO_SMALL" --signals watch --json)"
assert_eq "$C.plan_state" "pending" "$(echo "$plan" | jq -r '.state')" "plan is pending"
assert_eq "$C.plan_saved" "false" "$(echo "$plan" | jq -r '.payload.saved')" "plan does not save"
if [ ! -f "$CASE/.overcast/setup.json" ]; then
  ok "$C.plan_no_file" "plan did not write setup.json"
else
  fail "$C.plan_no_file" "plan wrote setup.json"
fi

cond "case setup applies target/source/note and records the real video route"
apply="$(oc "$CASE" case setup --name "live-setup-case" --target "live target" --source "web:live target" --note "live setup note" --video "$VIDEO_SMALL" --signals watch --yes --json)"
setup_rec="$(echo "$apply" | jq -s '.[]|select(.verb=="case" and .payload.op=="startup_setup")')"
assert_eq "$C.apply_state" "ready" "$(echo "$setup_rec" | jq -r '.state')" "setup apply ready"
assert_eq "$C.apply_saved" "true" "$(echo "$setup_rec" | jq -r '.payload.saved')" "setup apply saved"
assert_eq "$C.apply_video" "$VIDEO_SMALL" "$(jq -r '.media.videos[0]' "$CASE/.overcast/setup.json")" "setup.json stores the real video path"
assert_eq "$C.apply_signal" "watch" "$(jq -r '.media.routes[0].signals[0]' "$CASE/.overcast/setup.json")" "setup.json stores watch routing"

cond "case setup edit appends a source and emits startup_setup_update"
edit="$(oc "$CASE" case setup edit --source "youtube:@overcast-live" --yes --json)"
update_rec="$(echo "$edit" | jq -s '.[]|select(.verb=="case" and .payload.op=="startup_setup_update")')"
assert_eq "$C.edit_state" "ready" "$(echo "$update_rec" | jq -r '.state')" "setup edit ready"
assert_eq "$C.edit_op" "startup_setup_update" "$(echo "$update_rec" | jq -r '.payload.op')" "edit emits update op"
assert_eq "$C.edit_source_count" "2" "$(jq -r '.sources|length' "$CASE/.overcast/setup.json")" "setup.json has both sources"

cond "setup history records are excluded from memory but setup note is evidence"
setup_search="$(oc "$CASE" case memory search startup_setup_update --json)"
assert_eq "$C.memory_excludes_setup" "0" "$(echo "$setup_search" | jq -r '.payload.passages|length')" "setup case records excluded from memory"
note_search="$(oc "$CASE" case memory search "live setup note" --json)"
note_hits="$(echo "$note_search" | jq -r '.payload.passages|length')"
[ "${note_hits:-0}" -ge 1 ] && ok "$C.note_searchable" "setup note is searchable evidence" || fail "$C.note_searchable" "setup note was not searchable"
