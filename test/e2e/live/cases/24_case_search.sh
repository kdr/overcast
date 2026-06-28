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

cond "real qmd indexes the case and answers through semantic memory"
if command -v qmd >/dev/null 2>&1; then
  setup="$(oc "$CASE" setup memory qmd --json)"
  assert_eq "$C.qmd_setup" "ready" "$(echo "$setup" | jq -r '.state')" "setup memory qmd ready"
  qmd_idx="$(OC_TIMEOUT=360 oc "$CASE" case memory index rebuild --memory qmd --json)"
  assert_eq "$C.qmd_rebuild" "ready" "$(echo "$qmd_idx" | jq -r '.state')" "real qmd rebuild ready"
  assert_eq "$C.qmd_model" "embeddinggemma-300M-Q8_0" "$(echo "$qmd_idx" | jq -r '.payload.memory_index[0].model')" "qmd default model tracked"
  qmd_ask="$(OC_TIMEOUT=180 oc "$CASE" ask "Hacker News discussion threads comments" --deep --json)"
  assert_eq "$C.qmd_ask_state" "ready" "$(echo "$qmd_ask" | jq -r '.state')" "ask --deep via qmd ready"
  assert_eq "$C.qmd_ask_provider" "qmd" "$(echo "$qmd_ask" | jq -r '.meta.provider')" "ask --deep selects qmd"
  if echo "$qmd_ask" | jq -e '.payload.citations[]|select(.verb=="note")' >/dev/null; then
    ok "$C.qmd_ask_cites" "qmd answer cites the indexed note"
  else
    fail "$C.qmd_ask_cites" "qmd answer did not cite the indexed note"
  fi
else
  skip "$C.qmd" "qmd CLI not installed (npm install -g @tobilu/qmd)"
fi

cond "remote Cloudglue media index can be attached and queried"
if [ -n "${OC_TEST_MEDIA_INDEX:-}" ] && require_cred "$C.remote" CLOUDGLUE_API_KEY "remote media index query"; then
  att="$(OC_TIMEOUT=120 oc "$CASE" index attach "$OC_TEST_MEDIA_INDEX" --type media-descriptions --json)"
  assert_eq "$C.remote_attach" "ready" "$(echo "$att" | jq -r '.state')" "remote media index attach ready"
  remote_ask="$(OC_TIMEOUT=180 oc "$CASE" ask "Which videos are about Zurich or Tokyo travel?" --index "$OC_TEST_MEDIA_INDEX" --json)"
  assert_eq "$C.remote_ask_state" "ready" "$(echo "$remote_ask" | jq -r '.state')" "remote ask --index ready"
  assert_eq "$C.remote_ask_index" "$OC_TEST_MEDIA_INDEX" "$(echo "$remote_ask" | jq -r '.payload.index')" "remote ask records index id"
  if echo "$remote_ask" | jq -e '.payload.text|test("Zurich";"i") and test("Tokyo";"i")' >/dev/null; then
    ok "$C.remote_ask_answer" "remote answer mentions Zurich and Tokyo"
  else
    fail "$C.remote_ask_answer" "remote answer missing Zurich/Tokyo"
  fi
  remote_probe="$(OC_TIMEOUT=180 oc "$CASE" ask "Zurich travel" --index "$OC_TEST_MEDIA_INDEX" --probe --json)"
  assert_eq "$C.remote_probe_state" "ready" "$(echo "$remote_probe" | jq -r '.state')" "remote probe ready"
  assert_eq "$C.remote_probe_mode" "probe" "$(echo "$remote_probe" | jq -r '.payload.mode')" "remote query used probe mode"
  if echo "$remote_probe" | jq -e '.payload.citations[]?|select((.context // "")|test("Zurich";"i"))' >/dev/null; then
    ok "$C.remote_probe_zurich" "remote probe returns Zurich moment citations"
  else
    fail "$C.remote_probe_zurich" "remote probe missing Zurich citations"
  fi
else
  skip "$C.remote" "no OC_TEST_MEDIA_INDEX configured"
fi
