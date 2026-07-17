#!/usr/bin/env bash
# Real listen: Cloudglue (default) + ElevenLabs Scribe (bound) on a real speech clip.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=listen

# Prefer a standalone audio file (OC_AUDIO); else extract a short speech clip from
# a video (OC_VIDEO_SPEECH) so the cloud call stays cheap/fast.
if have_media "$AUDIO_FILE"; then
  CLIP="$AUDIO_FILE"
elif have_media "$VIDEO_SPEECH_SRC"; then
  CLIP="$SMOKE_DIR/speech20.mp4"; clip_av 20 "$VIDEO_SPEECH_SRC" "$CLIP"
fi
[ -n "${CLIP:-}" ] && [ -f "$CLIP" ] || { skip "$C" "no audio (set OC_AUDIO or OC_VIDEO_SPEECH)"; exit 0; }

# --- Cloudglue (default) ---
if require_cred "$C.cloudglue" CLOUDGLUE_API_KEY "skipping"; then
  CASE=$(case_dir listen_cg)
  cond "listen (default tinycloud) transcribes a real clip into an audio.analysis record"
  out="$(OC_TIMEOUT=300 oc "$CASE" listen "$CLIP" --json)"
  assert_eq "$C.cg.verb" "listen" "$(echo "$out" | jq -r '.verb')" "record.verb is listen"
  assert_eq "$C.cg.state" "ready" "$(echo "$out" | jq -r '.state')" "state is ready"
  assert_eq "$C.cg.segments_array" "array" "$(echo "$out" | jq -r '.payload.segments|type')" "payload.segments is an array"
  tlen="$(echo "$out" | jq -r '.payload.transcript | length')"
  [ "${tlen:-0}" -gt 0 ] \
    && ok "$C.cg.transcript_field" "transcript present and non-empty (len $tlen)" \
    || fail "$C.cg.transcript_field" "empty/missing transcript from a real speech clip"
  # tinycloud ≥ 0.3.12 (the floor) inlines the verbatim speech in the watch
  # envelope — listen maps it in ONE call (transcript_source=segments).
  # "caption" = the legacy pre-0.3.12 two-call fallback ran (old CLI on PATH);
  # a marked summary fallback means the speech path is broken again.
  src="$(echo "$out" | jq -r '.meta.transcript_source // empty')"
  if [ "$src" = "segments" ]; then
    ok "$C.cg.verbatim" "transcript is the inline watch speech (transcript_source=segments)"
  elif [ "$src" = "caption" ]; then
    fail "$C.cg.verbatim" "transcript_source=caption — the tinycloud on PATH is pre-0.3.12 (envelope shipped no inline speech); install the floor version"
  else
    fail "$C.cg.verbatim" "transcript_source='$src' — summary/none posing as the transcript"
  fi
  echo "$out" | jq -e '.payload.segments | length >= 1 and (.[0] | has("at"))' >/dev/null 2>&1 \
    && ok "$C.cg.segment_anchors" "segments carry time anchors ($(echo "$out"|jq -r '.payload.segments|length') cue(s))" \
    || fail "$C.cg.segment_anchors" "no time-anchored segments in a real speech clip"
fi

# --- ElevenLabs Scribe (bound provider) ---
if require_cred "$C.elevenlabs" ELEVENLABS_API_KEY "skipping"; then
  CASE=$(case_dir listen_el)
  EL="$PWD/providers/senses/elevenlabs/listen.sh"
  ocrun "$CASE" setup provider listen "exec:bash $EL {{input}}" --json >/dev/null 2>&1
  cond "a bound ElevenLabs Scribe provider transcribes the clip via the exec contract"
  out="$(OC_TIMEOUT=240 oc "$CASE" listen "$CLIP" --json)"
  assert_eq "$C.el.verb" "listen" "$(echo "$out" | jq -r '.verb')" "record.verb is listen"
  st="$(echo "$out" | jq -r '.state')"
  if [ "$st" = "ready" ]; then ok "$C.el.state" "ElevenLabs Scribe ready"; else fail "$C.el.state" "state=$st err=$(echo "$out"|jq -r '.error // empty')"; fi
fi
