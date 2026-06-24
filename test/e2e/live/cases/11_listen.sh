#!/usr/bin/env bash
# Real listen: Cloudglue (default) + ElevenLabs Scribe (bound) on a real speech clip.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=listen

# prep a short real speech clip (20s) so the cloud call stays cheap/fast
CLIP="$SMOKE_DIR/speech20.mp4"
if have_media "$VIDEO_SPEECH_SRC"; then clip_av 20 "$VIDEO_SPEECH_SRC" "$CLIP"; fi
[ -f "$CLIP" ] || { skip "$C" "no speech clip available"; exit 0; }

# --- Cloudglue (default) ---
if require_cred "$C.cloudglue" CLOUDGLUE_API_KEY "skipping"; then
  CASE=$(case_dir listen_cg)
  cond "listen (default tinycloud) transcribes a real clip into an audio.analysis record"
  out="$(OC_TIMEOUT=300 oc "$CASE" listen "$CLIP" --json)"
  assert_eq "$C.cg.verb" "listen" "$(echo "$out" | jq -r '.verb')" "record.verb is listen"
  assert_eq "$C.cg.state" "ready" "$(echo "$out" | jq -r '.state')" "state is ready"
  assert_eq "$C.cg.segments_array" "array" "$(echo "$out" | jq -r '.payload.segments|type')" "payload.segments is an array"
  echo "$out" | jq -e 'has("payload") and (.payload|has("transcript"))' >/dev/null 2>&1 \
    && ok "$C.cg.transcript_field" "transcript field present (len $(echo "$out"|jq -r '.payload.transcript|length'))" \
    || fail "$C.cg.transcript_field" "no transcript field"
fi

# --- ElevenLabs Scribe (bound provider) ---
if require_cred "$C.elevenlabs" ELEVENLABS_API_KEY "skipping"; then
  CASE=$(case_dir listen_el)
  EL="$PWD/examples/providers/elevenlabs/listen.sh"
  ocrun "$CASE" setup provider listen "exec:bash $EL {{input}}" --json >/dev/null 2>&1
  cond "a bound ElevenLabs Scribe provider transcribes the clip via the exec contract"
  out="$(OC_TIMEOUT=240 oc "$CASE" listen "$CLIP" --json)"
  assert_eq "$C.el.verb" "listen" "$(echo "$out" | jq -r '.verb')" "record.verb is listen"
  st="$(echo "$out" | jq -r '.state')"
  if [ "$st" = "ready" ]; then ok "$C.el.state" "ElevenLabs Scribe ready"; else fail "$C.el.state" "state=$st err=$(echo "$out"|jq -r '.error // empty')"; fi
fi
