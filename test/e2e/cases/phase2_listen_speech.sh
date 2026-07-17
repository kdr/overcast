#!/usr/bin/env bash
# Phase 2 e2e (offline): the DEFAULT listen path against a fake tinycloud —
# tinycloud ≥ 0.3.12 (the floor) inlines VERBATIM speech in the watch envelope
# (segments[].speech), so listen maps it in ONE call. listen must (a) store the
# verbatim words, deduping the boundary cue the CLI repeats across segments,
# (b) never silently store the watch SUMMARY as the transcript, (c) never push
# --diarize/--lang onto `watch` (the real CLI rejects both with exit 1), and
# (d) keep the legacy caption-verb fallback working for a pre-0.3.12 envelope
# (segments: []). Fixture: test/fixtures/fake-tinycloud-speech.sh
# (watch → 0.3.12 speech envelope, FAKE_TC_WATCH=nospeech → 0.3.10 summary-only
# envelope, caption → verbatim cues, FAKE_TC_CAPTION=fail → caption outage).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

FAKE_TC="bash $REPO/test/fixtures/fake-tinycloud-speech.sh"
casedir="$SMOKE_DIR/case_listen_speech"; mkdir -p "$casedir"

# a real (tiny, silent) wav so media resolution sees an actual audio file
wav="$SMOKE_DIR/talk.wav"
node --import tsx -e "
import {FFMPEG_PATH} from '$REPO/src/media/ffmpeg.ts';
import {execFileSync} from 'node:child_process';
execFileSync(FFMPEG_PATH,['-y','-f','lavfi','-i','sine=frequency=440:duration=1','-ar','8000','$wav'],{stdio:'ignore'});
" 2>"$SMOKE_DIR/phase2_listen_speech_ff.err"
if [ ! -f "$wav" ]; then
  fail "listen_speech.wav_gen" "could not generate test wav with system ffmpeg"
  return 0 2>/dev/null || exit 0
fi

# 1) default listen (0.3.12 envelope): transcript = the inline verbatim speech,
# single call — transcript_source=caption here means the two-call workaround
# came back
out="$(OVERCAST_TINYCLOUD_CMD="$FAKE_TC" $OVERCAST listen "$wav" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_listen_speech" "$out" >/dev/null
assert_eq "listen_speech.state" "ready" "$(jq -r '.state // "ready"' <<<"$out")" "default listen ready"
assert_eq "listen_speech.source" "segments" "$(jq -r '.meta.transcript_source' <<<"$out")" "transcript came from the inline watch speech"
tr_text="$(jq -r '.payload.transcript' <<<"$out")"
case "$tr_text" in
  *"We'll walk through the streets"*) ok "listen_speech.verbatim" "transcript holds the verbatim speech" ;;
  *) fail "listen_speech.verbatim" "transcript missing verbatim cues: $tr_text" ;;
esac
case "$tr_text" in
  *"visitor describes"*) fail "listen_speech.no_summary" "the watch SUMMARY leaked into the transcript: $tr_text" ;;
  *) ok "listen_speech.no_summary" "watch summary did not pose as the transcript" ;;
esac
# the boundary cue repeated in the next segment's speech[] is stored once
assert_eq "listen_speech.segments" "2" "$(jq -r '.payload.segments|length' <<<"$out")" "cue-anchored segments (boundary repeat deduped)"
assert_eq "listen_speech.anchor" "[0,1.2]" "$(jq -c '.payload.segments[0].at' <<<"$out")" "segment carries [start,end]"

# 2) --diarize rides the caption pass (watch REJECTS --diarize — the fixture
# fails hard like the real CLI if listen regresses to pushing it onto watch)
dout="$(OVERCAST_TINYCLOUD_CMD="$FAKE_TC" $OVERCAST listen "$wav" --diarize --json --case "$casedir" 2>/dev/null)"
save_json "phase2_listen_speech_diarize" "$dout" >/dev/null
assert_eq "listen_speech.diarize_state" "ready" "$(jq -r '.state // "ready"' <<<"$dout")" "--diarize did not hit watch (ready)"
assert_eq "listen_speech.diarize_speaker" "1" "$(jq -r '.payload.segments[0].speaker' <<<"$dout")" "speaker label lifted from diarized cues"

# 3) legacy pre-0.3.12 envelope (segments: []): the caption verb still supplies
# the verbatim cues
lout="$(FAKE_TC_WATCH=nospeech OVERCAST_TINYCLOUD_CMD="$FAKE_TC" $OVERCAST listen "$wav" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_listen_speech_legacy" "$lout" >/dev/null
assert_eq "listen_speech.legacy_state" "ready" "$(jq -r '.state // "ready"' <<<"$lout")" "legacy envelope still yields a ready record"
assert_eq "listen_speech.legacy_source" "caption" "$(jq -r '.meta.transcript_source' <<<"$lout")" "legacy fallback pulled the caption cues"
case "$(jq -r '.payload.transcript' <<<"$lout")" in
  *"We'll walk through the streets"*) ok "listen_speech.legacy_verbatim" "legacy fallback transcript is verbatim" ;;
  *) fail "listen_speech.legacy_verbatim" "legacy fallback transcript missing verbatim cues" ;;
esac

# 4) caption outage on a legacy envelope: the summary may stand in ONLY with an
# explicit marker
fout="$(FAKE_TC_WATCH=nospeech FAKE_TC_CAPTION=fail OVERCAST_TINYCLOUD_CMD="$FAKE_TC" $OVERCAST listen "$wav" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_listen_speech_fallback" "$fout" >/dev/null
assert_eq "listen_speech.fallback_state" "ready" "$(jq -r '.state // "ready"' <<<"$fout")" "caption outage still yields a ready record"
assert_eq "listen_speech.fallback_source" "summary" "$(jq -r '.meta.transcript_source' <<<"$fout")" "summary fallback is marked transcript_source=summary"
case "$(jq -r '.payload.warning // empty' <<<"$fout")" in
  *"SUMMARY of the audio"*) ok "listen_speech.fallback_warning" "summary fallback carries the not-the-spoken-words warning" ;;
  *) fail "listen_speech.fallback_warning" "missing/wrong payload.warning on summary fallback" ;;
esac
