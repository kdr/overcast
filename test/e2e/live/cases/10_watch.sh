#!/usr/bin/env bash
# Real Cloudglue `watch` on a real video → video.analysis record, persisted.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=watch
require_cred "$C" CLOUDGLUE_API_KEY "skipping real watch" || exit 0
have_media "$VIDEO_VISUAL" || { skip "$C" "no $VIDEO_VISUAL"; exit 0; }

CASE=$(case_dir watch)
out="$(OC_TIMEOUT=300 ocrun "$CASE" watch "$VIDEO_VISUAL" --json 2>/dev/null)"; rc=$?
save_json "10_watch" "$out" >/dev/null
assert_eq "$C.exit_zero" "0" "$rc" "watch exit code"
assert_eq "$C.verb" "watch" "$(echo "$out" | jq -r '.verb')" "record.verb"
assert_eq "$C.state" "ready" "$(echo "$out" | jq -r '.state')" "real Cloudglue watch ready"
assert_nonempty "$C.content" "$(echo "$out" | jq -r '.payload.content')" "describe content non-empty"
assert_nonempty "$C.detailed" "$(echo "$out" | jq -r '.payload.detailed // empty | tostring')" "structured detailed present"
assert_nonempty "$C.title" "$(echo "$out" | jq -r '.meta.title // empty')" "Cloudglue title in meta"
assert_eq "$C.provider" "tinycloud" "$(echo "$out" | jq -r '.meta.provider')" "default tinycloud provider"

# persisted to the case store
recs="$(ocrun "$CASE" case records --verb watch --json 2>/dev/null | jq '.payload.count')"
assert_eq "$C.persisted" "1" "$recs" "one watch record persisted"
