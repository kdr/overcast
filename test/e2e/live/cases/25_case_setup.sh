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

SETUP_INDEX_ARGS=()
if [ -n "${OC_TEST_MEDIA_INDEX:-}" ] && [ -n "${OC_TEST_FACE_INDEX:-}" ] && have_cred CLOUDGLUE_API_KEY; then
  SETUP_INDEX_ARGS=(--index "${OC_TEST_FACE_INDEX}:face-analysis:Live Setup Faces,${OC_TEST_MEDIA_INDEX}:media-descriptions:Live Setup Media")
fi

cond "case setup plan previews real-video routing without saving"
plan="$(oc "$CASE" case setup plan --name "live-setup-case" --target "live target" --source "web:live target" --video "$VIDEO_SMALL" "${SETUP_INDEX_ARGS[@]}" --json)"
assert_eq "$C.plan_state" "pending" "$(echo "$plan" | jq -r '.state')" "plan is pending"
assert_eq "$C.plan_saved" "false" "$(echo "$plan" | jq -r '.payload.saved')" "plan does not save"
if [ ! -f "$CASE/.overcast/setup.json" ]; then
  ok "$C.plan_no_file" "plan did not write setup.json"
else
  fail "$C.plan_no_file" "plan wrote setup.json"
fi

cond "case setup applies target/source/note and records the real video route"
apply="$(OC_TIMEOUT=300 oc "$CASE" case setup --name "live-setup-case" --target "live target" --source "web:live target" --note "live setup note" --video "$VIDEO_SMALL" "${SETUP_INDEX_ARGS[@]}" --yes --json)"
setup_rec="$(echo "$apply" | jq -s '.[]|select(.verb=="case" and .payload.op=="startup_setup")')"
assert_eq "$C.apply_state" "ready" "$(echo "$setup_rec" | jq -r '.state')" "setup apply ready"
assert_eq "$C.apply_saved" "true" "$(echo "$setup_rec" | jq -r '.payload.saved')" "setup apply saved"
assert_eq "$C.apply_video" "$VIDEO_SMALL" "$(jq -r '.media.videos[0]' "$CASE/.overcast/setup.json")" "setup.json stores the real video path"
assert_eq "$C.apply_signal" "watch" "$(jq -r '.media.routes[0].signals[0]' "$CASE/.overcast/setup.json")" "setup.json stores watch routing"
if [ "${#SETUP_INDEX_ARGS[@]}" -gt 0 ]; then
  add_count="$(echo "$apply" | jq -s '[.[]|select(.verb=="index" and .payload.op=="add")]|length')"
  [ "${add_count:-0}" -ge 2 ] && ok "$C.apply_index_adds" "setup queued face + media collection ingestion ($add_count add records)" || fail "$C.apply_index_adds" "setup did not emit index add records"
  assert_eq "$C.apply_face_index" "true" "$(jq -r '.media.routes[0].indexes|index("'"$OC_TEST_FACE_INDEX"'") != null' "$CASE/.overcast/setup.json")" "setup route includes face index"
  assert_eq "$C.apply_media_index" "true" "$(jq -r '.media.routes[0].indexes|index("'"$OC_TEST_MEDIA_INDEX"'") != null' "$CASE/.overcast/setup.json")" "setup route includes media index"
  if echo "$setup_rec" | jq -e '.payload.applied_operations[] | select(test("indexing started"))' >/dev/null; then
    ok "$C.apply_indexing_ops" "setup record says indexing started"
  else
    fail "$C.apply_indexing_ops" "setup record did not report indexing started"
  fi
else
  skip "$C.apply_indexing" "no OC_TEST_MEDIA_INDEX/OC_TEST_FACE_INDEX/CLOUDGLUE_API_KEY configured"
fi

cond "scan --local inspects setup media/indexes without sweeping sources"
local_scan="$(OC_TIMEOUT=300 oc "$CASE" scan --local --json)"
local_scan_rec="$(echo "$local_scan" | jq -s '.[]|select(.verb=="scan" and .payload.op=="local")')"
assert_eq "$C.local_scan_state" "ready" "$(echo "$local_scan_rec" | jq -r '.state')" "local scan ready"
assert_eq "$C.local_scan_video" "true" "$(echo "$local_scan_rec" | jq -r --arg video "$VIDEO_SMALL" '.payload.media|index($video) != null')" "local scan sees setup video"
if [ "${#SETUP_INDEX_ARGS[@]}" -gt 0 ]; then
  idx_count="$(echo "$local_scan_rec" | jq -r '.payload.indexes|length')"
  if [ "${idx_count:-0}" -ge 2 ]; then
    ok "$C.local_scan_indexes" "local scan sees setup indexes ($idx_count)"
  else
    fail "$C.local_scan_indexes" "local scan did not report setup indexes"
  fi
fi

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
