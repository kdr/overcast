#!/usr/bin/env bash
# Case setup management: dry-run, apply, show/edit, and memory exclusion.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_setup"; mkdir -p "$casedir"
G=(--case "$casedir")

plan="$($OVERCAST case setup plan --target "@pier9" --source "web:pier9" --json "${G[@]}" 2>/dev/null)"
save_json "phase4_setup_plan" "$plan" >/dev/null
assert_eq "setup.plan_state" "pending" "$(jq -r '.state' <<<"$plan")" "setup plan is pending"
if [ ! -f "$casedir/.overcast/setup.json" ]; then
  ok "setup.plan_no_file" "plan did not save setup.json"
else
  fail "setup.plan_no_file" "plan unexpectedly saved setup.json"
fi

apply="$($OVERCAST case setup --name "dock-incident" --target "@pier9" --source "web:pier9" --note "setup searchable note" --yes --json "${G[@]}" 2>/dev/null)"
save_json "phase4_setup_apply" "$apply" >/dev/null
setup_rec="$(jq -s '.[]|select(.verb=="case" and .payload.op=="startup_setup")' <<<"$apply" 2>/dev/null)"
assert_eq "setup.apply_state" "ready" "$(jq -r '.state' <<<"$setup_rec")" "setup apply ready"
assert_eq "setup.apply_saved" "true" "$(jq -r '.payload.saved' <<<"$setup_rec")" "setup apply saved"

show="$($OVERCAST case setup show --json "${G[@]}" 2>/dev/null)"
save_json "phase4_setup_show" "$show" >/dev/null
assert_eq "setup.show_name" "dock-incident" "$(jq -r '.payload.case_name' <<<"$show")" "setup show reports case name"
assert_eq "setup.show_source" "web:pier9" "$(jq -r '.payload.sources[0]' <<<"$show")" "setup show reports source"

edit="$($OVERCAST case setup edit --target "second-target" --source "youtube:@pier9" --index "col_demo:media:Demo Media" --yes --json "${G[@]}" 2>/dev/null)"
save_json "phase4_setup_edit" "$edit" >/dev/null
update_rec="$(jq -s '.[]|select(.verb=="case" and .payload.op=="startup_setup_update")' <<<"$edit" 2>/dev/null)"
assert_eq "setup.edit_state" "ready" "$(jq -r '.state' <<<"$update_rec")" "setup edit ready"
assert_eq "setup.edit_op" "startup_setup_update" "$(jq -r '.payload.op' <<<"$update_rec")" "edit emits update op"

status="$($OVERCAST case setup status --json "${G[@]}" 2>/dev/null)"
assert_eq "setup.status_completed" "true" "$(jq -r '.payload.setup.completed' <<<"$status")" "setup status completed"
assert_eq "setup.status_indexes" "1" "$(jq -r '.payload.registry.indexes' <<<"$status")" "setup status sees mirrored index"

search_setup="$($OVERCAST case memory search startup_setup_update --json "${G[@]}" 2>/dev/null)"
assert_eq "setup.memory_excluded" "0" "$(jq -r '.payload.passages|length' <<<"$search_setup")" "setup case records excluded from memory"

search_note="$($OVERCAST case memory search searchable --json "${G[@]}" 2>/dev/null)"
note_hits="$(jq -r '.payload.passages|length' <<<"$search_note")"
[ "${note_hits:-0}" -ge 1 ] && ok "setup.note_searchable" "setup note is searchable evidence" || fail "setup.note_searchable" "setup note not searchable"
