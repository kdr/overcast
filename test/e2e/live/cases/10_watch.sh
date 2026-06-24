#!/usr/bin/env bash
# Real Cloudglue `watch` on a real video → video.analysis record, persisted.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=watch
require_cred "$C" CLOUDGLUE_API_KEY "skipping real watch" || exit 0
have_media "$VIDEO_VISUAL" || { skip "$C" "no $VIDEO_VISUAL"; exit 0; }

CASE=$(case_dir watch)

cond "watch runs the default tinycloud provider over a real video and emits a ready video.analysis record"
out="$(OC_TIMEOUT=300 oc "$CASE" watch "$VIDEO_VISUAL" --json)"; rc=$?
assert_eq "$C.exit_zero" "0" "$rc" "watch exits 0"
assert_eq "$C.verb" "watch" "$(echo "$out" | jq -r '.verb')" "record.verb is watch"
assert_eq "$C.state" "ready" "$(echo "$out" | jq -r '.state')" "state is ready"
assert_nonempty "$C.content" "$(echo "$out" | jq -r '.payload.content')" "payload.content (markdown describe) non-empty"
assert_nonempty "$C.detailed" "$(echo "$out" | jq -r '.payload.detailed // empty | tostring')" "payload.detailed (structured) present"
assert_nonempty "$C.title" "$(echo "$out" | jq -r '.meta.title // empty')" "Cloudglue title in meta"
assert_eq "$C.provider" "tinycloud" "$(echo "$out" | jq -r '.meta.provider')" "meta.provider is tinycloud"

cond "the watch record is persisted to the case store and is queryable"
recs="$(oc "$CASE" case records --verb watch --json | jq '.payload.count')"
assert_eq "$C.persisted" "1" "$recs" "one watch record persisted"
