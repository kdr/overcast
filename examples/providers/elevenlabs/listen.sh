#!/usr/bin/env bash
# overcast `listen` provider — ElevenLabs Speech-to-Text (Scribe). Emits an
# audio.analysis record: transcript, word-level segments[] with media.at anchors,
# detected language. Bind:
#   overcast setup provider listen "exec:bash examples/providers/elevenlabs/listen.sh {{input}}"
# Model: $ELEVENLABS_STT_MODEL (default scribe_v1).
set -uo pipefail

KEY="${ELEVENLABS_API_KEY:-${XI_API_KEY:-}}"
MODEL="${ELEVENLABS_STT_MODEL:-scribe_v1}"
need() { [ -n "$KEY" ] || { echo "listen (ElevenLabs) needs ELEVENLABS_API_KEY" >&2; exit 13; }; }

op="${1:-run}"
case "$op" in
  init)     need; exit 0 ;;
  describe) echo "{\"verb\":\"listen\",\"kind\":\"audio.analysis\",\"payload\":[\"transcript\",\"segments\",\"language\"],\"model\":\"$MODEL\",\"needs\":[\"ELEVENLABS_API_KEY\"]}"; exit 0 ;;
esac

input=""; diarize=""; lang=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="$2"; shift 2 ;;
  --diarize) diarize="-F diarize=true"; shift ;;
  --lang) lang="-F language_code=$2"; shift 2 ;;
  --*) shift ;;
  *) input="$1"; shift ;;
esac; done
need
[ -f "$input" ] || { echo "{\"verb\":\"listen\",\"error\":\"input not found: $input\",\"state\":\"error\"}"; exit 0; }

# shellcheck disable=SC2086
resp="$(curl -s -m 300 -X POST "https://api.elevenlabs.io/v1/speech-to-text" \
  -H "xi-api-key: $KEY" -F "model_id=$MODEL" $diarize $lang -F "file=@$input")"

text="$(jq -r '.text // empty' <<<"$resp" 2>/dev/null)"
if [ -n "$text" ]; then
  # map word objects -> segments {at:[start,end], text}, keep only real words
  jq -c '{verb:"listen",format:"json",
          payload:{transcript:.text,
                   language:(.language_code // null),
                   segments:[ (.words // [])[] | select(.type=="word") | {at:[.start,.end], text:.text, speaker:(.speaker_id // null)} ]},
          meta:{provider:"elevenlabs:scribe"}, state:"ready"}' <<<"$resp"
else
  err="$(jq -r '(.detail.message // .detail // .error // empty)' <<<"$resp" 2>/dev/null)"
  jq -nc --arg e "${err:-no transcript}" '{verb:"listen",format:"json",payload:{transcript:"",segments:[],language:null},error:$e,state:"error"}'
fi
