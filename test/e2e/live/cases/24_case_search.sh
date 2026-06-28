#!/usr/bin/env bash
# Real-data default case search: add a note anchored to a configured real media
# file, then ask the case and inspect the local case-search index. No cloud call.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=case_search

if [ -z "${VIDEO_VISUAL:-}" ] || ! have_media "$VIDEO_VISUAL"; then
  skip "$C.media" "no OC_VIDEO_VISUAL real media configured"
  exit 0
fi

CASE=$(case_dir case_search)

cond "note anchors a real media artifact and ask finds it through default case search"
note="$(oc "$CASE" note "Real artifact: Hacker News browsing video shows discussion threads and comments" --ref "$VIDEO_VISUAL" --tag real-media,case-search --json)"
assert_eq "$C.note_state" "ready" "$(echo "$note" | jq -r '.state')" "real media note ready"
assert_nonempty "$C.note_media" "$(echo "$note" | jq -r '.media.ref // empty')" "note carries real media ref"

ask="$(oc "$CASE" ask "Hacker News discussion threads comments" --json)"
assert_eq "$C.ask_state" "ready" "$(echo "$ask" | jq -r '.state')" "ask ready"
if echo "$ask" | jq -e '.payload.citations[]|select(.verb=="note")' >/dev/null; then
  ok "$C.ask_cites_note" "ask cites the real media-backed note"
else
  fail "$C.ask_cites_note" "ask did not cite the real media-backed note"
fi
assert_eq "$C.ask_provider" "local-grep" "$(echo "$ask" | jq -r '.meta.provider')" "default ask provider is local-grep"

cond "case memory index status exposes default backend and document count"
idx="$(oc "$CASE" case memory index status --json)"
assert_eq "$C.index_backend" "local-grep" "$(echo "$idx" | jq -r '.payload.memory_index[0].backend')" "local-grep backend"
assert_eq "$C.index_state" "ready" "$(echo "$idx" | jq -r '.payload.memory_index[0].state')" "index status ready"
docs="$(echo "$idx" | jq -r '.payload.memory_index[0].documents // 0')"
[ "${docs:-0}" -ge 1 ] && ok "$C.index_docs" "index sees $docs document(s)" || fail "$C.index_docs" "expected at least one indexable document"
