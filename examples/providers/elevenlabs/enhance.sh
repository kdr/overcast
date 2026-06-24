#!/usr/bin/env bash
# overcast `enhance` provider — ElevenLabs Voice Isolator (audio). Strips
# background noise/music, leaving clean speech. Bind to opt in:
#   overcast setup provider enhance "exec:bash examples/providers/elevenlabs/enhance.sh {{input}}"
# Audio only (image enhance: use the fal or ffmpeg providers). Output -> $OVERCAST_MEDIA_DIR.
set -uo pipefail

KEY="${ELEVENLABS_API_KEY:-${XI_API_KEY:-}}"
OUTDIR="${OVERCAST_MEDIA_DIR:-.}"
need() { [ -n "$KEY" ] || { echo "enhance (ElevenLabs) needs ELEVENLABS_API_KEY (https://elevenlabs.io/app/settings/api-keys)" >&2; exit 13; }; }

op="${1:-run}"
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"verb":"enhance","kind":"media.enhanced","op":"voice-isolation","needs":["ELEVENLABS_API_KEY"]}'; exit 0 ;;
esac

input=""
while [ "$#" -gt 0 ]; do case "$1" in --input) input="$2"; shift 2 ;; --*) shift ;; *) input="$1"; shift ;; esac; done
need
[ -f "$input" ] || { echo "{\"verb\":\"enhance\",\"error\":\"input not found\",\"state\":\"error\"}"; exit 0; }
mkdir -p "$OUTDIR"
ext="$(echo "${input##*.}" | tr 'A-Z' 'a-z')"
case "$ext" in mp3|wav|m4a|aac|flac|ogg|mp4|mov|webm) : ;; *) jq -nc --arg x ".$ext" '{verb:"enhance",error:("ElevenLabs voice-isolation is audio-only ("+$x+")"),state:"error"}'; exit 0 ;; esac
base="$(basename "${input%.*}")"; out="$OUTDIR/${base}_voiceiso.mp3"

http="$(curl -s -m 180 -o "$out" -w "%{http_code}" -X POST \
  "https://api.elevenlabs.io/v1/audio-isolation" \
  -H "xi-api-key: $KEY" -F "audio=@$input")"

if [ "$http" = "200" ] && [ -s "$out" ] && ! head -c1 "$out" | grep -q '{'; then
  jq -nc --arg o "$out" '{verb:"enhance",format:"json",payload:{output:$o,ops:["voice-isolation"],provider:"elevenlabs"},media:{ref:$o},meta:{provider:"elevenlabs:voice-isolator"},state:"ready"}'
else
  err="$(cat "$out" 2>/dev/null | jq -r '(.detail.message // .detail // .error // empty)' 2>/dev/null)"; rm -f "$out"
  jq -nc --arg e "${err:-ElevenLabs voice-isolation failed (http $http)}" '{verb:"enhance",format:"json",payload:{provider:"elevenlabs"},error:$e,state:"error"}'
fi
