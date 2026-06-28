#!/usr/bin/env bash
# Real tinycloud `index` lifecycle (>= 0.3.4): create → list (mirror) → show
# (live status) → delete (remote + mirror prune). Cheap metadata ops, no ingest.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=index
require_cred "$C" CLOUDGLUE_API_KEY "skipping real index" || exit 0

CASE=$(case_dir index)
NAME="oc-e2e-$$"

cond "index create makes a real tinycloud media-descriptions index and mirrors it"
out="$(OC_TIMEOUT=120 oc "$CASE" index create "$NAME" --type media-descriptions --json)"; rc=$?
assert_eq "$C.create_exit" "0" "$rc" "create exits 0"
assert_eq "$C.create_verb" "index" "$(echo "$out" | jq -r '.verb')" "record.verb is index"
assert_eq "$C.create_state" "ready" "$(echo "$out" | jq -r '.state')" "state is ready"
COLID="$(echo "$out" | jq -r '.payload.id // empty')"
assert_nonempty "$C.create_id" "$COLID" "create returns a tinycloud index id"

cond "the new index is tracked in the local .overcast mirror (index list)"
lst="$(oc "$CASE" index list --json)"
assert_eq "$C.mirror" "1" "$(echo "$lst" | jq --arg id "$COLID" '[.payload.indexes[]|select(.id==$id)]|length')" "the index is in the mirror"

cond "index show reports live remote status for the index"
shw="$(OC_TIMEOUT=120 oc "$CASE" index show "$COLID" --json)"
assert_eq "$C.show_state" "ready" "$(echo "$shw" | jq -r '.state')" "show state ready"
assert_nonempty "$C.show_detailed" "$(echo "$shw" | jq -r '.payload.detailed // empty | tostring')" "show detailed present"

cond "index delete removes it remotely and prunes the mirror"
del="$(OC_TIMEOUT=120 oc "$CASE" index delete "$COLID" --json)"
assert_eq "$C.delete_state" "ready" "$(echo "$del" | jq -r '.state')" "delete state ready"
assert_eq "$C.mirror_pruned" "0" "$(oc "$CASE" index list --json | jq --arg id "$COLID" '[.payload.indexes[]|select(.id==$id)]|length')" "mirror pruned after delete"
