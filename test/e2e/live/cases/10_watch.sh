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

# tinycloud ≥ 0.3.12 (the floor) inlines verbatim speech in the watch envelope
# (segments[].speech) — a watch over a SPEECH clip must populate
# payload.transcript from the envelope alone, no caption second call.
if have_media "$VIDEO_SPEECH_SRC"; then
  SPEECH_CLIP="$SMOKE_DIR/watch_speech20.mp4"; clip_av 20 "$VIDEO_SPEECH_SRC" "$SPEECH_CLIP"
  CASE2=$(case_dir watch_speech)
  cond "watch on a speech clip inlines the verbatim transcript (tinycloud ≥ 0.3.12)"
  sout="$(OC_TIMEOUT=300 oc "$CASE2" watch "$SPEECH_CLIP" --json)"
  assert_eq "$C.speech.state" "ready" "$(echo "$sout" | jq -r '.state')" "speech watch ready"
  stlen="$(echo "$sout" | jq -r '.payload.transcript | length')"
  [ "${stlen:-0}" -gt 0 ] \
    && ok "$C.speech.transcript" "watch transcript non-empty from the envelope (len $stlen)" \
    || fail "$C.speech.transcript" "empty watch transcript on a speech clip — inline segments[].speech missing (pre-0.3.12 tinycloud on PATH?)"
else
  skip "$C.speech" "no OC_VIDEO_SPEECH — watch transcript check skipped"
fi
