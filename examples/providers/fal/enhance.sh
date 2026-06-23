#!/usr/bin/env bash
# overcast `enhance` provider — fal.ai (direct, FAL_KEY). Image: faithful upscale
# (ESRGAN); Audio: speech denoise + 48kHz (DeepFilterNet3). The default `enhance`
# stays the internal ffmpeg toolkit; bind to opt in:
#   overcast setup provider enhance "exec:bash examples/providers/fal/enhance.sh {{input}}"
# Models: $FAL_ENHANCE_IMAGE_MODEL (fal-ai/esrgan), $FAL_ENHANCE_AUDIO_MODEL
# (fal-ai/deepfilternet3). Output is written to $OVERCAST_MEDIA_DIR.
set -uo pipefail

IMG_MODEL="${FAL_ENHANCE_IMAGE_MODEL:-fal-ai/esrgan}"
AUD_MODEL="${FAL_ENHANCE_AUDIO_MODEL:-fal-ai/deepfilternet3}"
KEY="${FAL_KEY:-${FAL_API_KEY:-}}"
OUTDIR="${OVERCAST_MEDIA_DIR:-.}"
need() { [ -n "$KEY" ] || { echo "enhance (fal.ai) needs FAL_KEY (https://fal.ai/dashboard/keys)" >&2; exit 13; }; }

op="${1:-run}"
case "$op" in
  init)     need; exit 0 ;;
  describe) echo "{\"verb\":\"enhance\",\"kind\":\"media.enhanced\",\"image_model\":\"$IMG_MODEL\",\"audio_model\":\"$AUD_MODEL\",\"needs\":[\"FAL_KEY\"]}"; exit 0 ;;
esac

input=""
while [ "$#" -gt 0 ]; do case "$1" in --input) input="$2"; shift 2 ;; --*) shift ;; *) input="$1"; shift ;; esac; done
need
[ -f "$input" ] || { echo "{\"verb\":\"enhance\",\"error\":\"input not found\",\"state\":\"error\"}"; exit 0; }
mkdir -p "$OUTDIR"
ext="$(echo "${input##*.}" | tr 'A-Z' 'a-z')"; base="$(basename "${input%.*}")"
b64="$(base64 -i "$input" 2>/dev/null | tr -d '\n')" || b64="$(base64 "$input" | tr -d '\n')"

case "$ext" in
  jpg|jpeg|png|webp|bmp) model="$IMG_MODEL"; field=image_url; mime="image/$ext"; rkey=".image.url"; out="$OUTDIR/${base}_fal.png" ;;
  mp3|wav|m4a|aac|flac|ogg) model="$AUD_MODEL"; field=audio_url; mime="audio/$ext"; rkey=".audio_file.url"; out="$OUTDIR/${base}_fal.mp3" ;;
  *) echo "{\"verb\":\"enhance\",\"error\":\"unsupported modality .$ext\",\"state\":\"error\"}"; exit 0 ;;
esac

resp="$(curl -s -m 180 -X POST "https://fal.run/$model" \
  -H "Authorization: Key $KEY" -H "Content-Type: application/json" \
  -d "{\"$field\":\"data:$mime;base64,$b64\"}")"
url="$(jq -r "$rkey // empty" <<<"$resp" 2>/dev/null)"
err="$(jq -r '(.detail // .error // empty)' <<<"$resp" 2>/dev/null)"

if [ -n "$url" ]; then
  curl -s -m 120 -o "$out" "$url"
  jq -nc --arg o "$out" --arg m "fal:$model" \
    '{verb:"enhance",format:"json",payload:{output:$o,ops:["fal"],model:$m},media:{ref:$o},meta:{provider:$m},state:"ready"}'
else
  jq -nc --arg e "${err:-fal enhance failed}" --arg m "fal:$model" \
    '{verb:"enhance",format:"json",payload:{provider:$m},error:$e,state:"error"}'
fi
