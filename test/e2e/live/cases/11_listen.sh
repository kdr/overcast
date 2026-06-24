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
  out="$(OC_TIMEOUT=300 ocrun "$CASE" listen "$CLIP" --json 2>/dev/null)"
  save_json "11_listen_cloudglue" "$out" >/dev/null
  assert_eq "$C.cg.verb" "listen" "$(echo "$out" | jq -r '.verb')" "verb"
  assert_eq "$C.cg.state" "ready" "$(echo "$out" | jq -r '.state')" "Cloudglue listen ready"
  assert_eq "$C.cg.segments_array" "array" "$(echo "$out" | jq -r '.payload.segments|type')" "segments is an array"
  # transcript may legitimately be empty for some clips; assert the field exists
  echo "$out" | jq -e 'has("payload") and (.payload|has("transcript"))' >/dev/null 2>&1 \
    && ok "$C.cg.transcript_field" "transcript field present (len $(echo "$out"|jq -r '.payload.transcript|length'))" \
    || fail "$C.cg.transcript_field" "no transcript field"
fi

# --- ElevenLabs Scribe (bound provider) ---
if require_cred "$C.elevenlabs" ELEVENLABS_API_KEY "skipping"; then
  CASE=$(case_dir listen_el)
  EL="$PWD/examples/providers/elevenlabs/listen.sh"
  ocrun "$CASE" setup provider listen "exec:bash $EL {{input}}" --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=240 ocrun "$CASE" listen "$CLIP" --json 2>/dev/null)"
  save_json "11_listen_elevenlabs" "$out" >/dev/null
  assert_eq "$C.el.verb" "listen" "$(echo "$out" | jq -r '.verb')" "verb"
  st="$(echo "$out" | jq -r '.state')"
  if [ "$st" = "ready" ]; then ok "$C.el.state" "ElevenLabs Scribe ready"; else fail "$C.el.state" "state=$st err=$(echo "$out"|jq -r '.error // empty')"; fi
fi
