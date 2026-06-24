#!/usr/bin/env bash
# overcast `enhance` provider — Hugging Face model ops (Inference API).
# Image -> image-to-image (upscale/unblur/restore); audio -> audio-to-audio
# (enhance/denoise). Opt-in: `overcast setup provider enhance "exec:bash <this>"`.
# (The default `enhance` stays the internal ffmpeg toolkit.) Output is written to
# $OVERCAST_MEDIA_DIR (set by overcast) and returned as a media.enhanced record.
#
# Models: $HF_ENHANCE_IMAGE_MODEL / $HF_ENHANCE_AUDIO_MODEL (override the defaults).
set -uo pipefail

IMG_MODEL="${HF_ENHANCE_IMAGE_MODEL:-prithivMLmods/Qwen-Image-Edit-2511-Unblur-Upscale}"
AUD_MODEL="${HF_ENHANCE_AUDIO_MODEL:-LocalAI-io/LocalVQE}"
TOKEN="${HF_TOKEN:-${HUGGING_FACE_HUB_TOKEN:-}}"
OUTDIR="${OVERCAST_MEDIA_DIR:-.}"

need_token() { [ -n "$TOKEN" ] || { echo "enhance (Hugging Face) needs HF_TOKEN" >&2; exit 13; }; }

op="${1:-run}"
case "$op" in
  init)     need_token; exit 0 ;;
  describe) echo "{\"verb\":\"enhance\",\"kind\":\"media.enhanced\",\"image_model\":\"$IMG_MODEL\",\"audio_model\":\"$AUD_MODEL\",\"needs\":[\"HF_TOKEN\"]}"; exit 0 ;;
esac

input=""
# unknown --flags are treated as single-token booleans (shift 1) so a flag
# placed before the positional input can't swallow the file path as a value.
while [ "$#" -gt 0 ]; do case "$1" in --input) input="$2"; shift 2 ;; --*) shift ;; *) input="$1"; shift ;; esac; done
need_token
[ -f "$input" ] || { echo "{\"verb\":\"enhance\",\"error\":\"input not found\",\"state\":\"error\"}"; exit 0; }

ext="${input##*.}"; base="$(basename "${input%.*}")"
case "$(echo "$ext" | tr 'A-Z' 'a-z')" in
  jpg|jpeg|png|webp|bmp|gif) model="$IMG_MODEL"; out="$OUTDIR/${base}_hf.png"; ctype="image/*" ;;
  mp3|wav|m4a|aac|flac|ogg)  model="$AUD_MODEL"; out="$OUTDIR/${base}_hf.${ext}"; ctype="audio/*" ;;
  *) jq -nc --arg x ".$ext" '{verb:"enhance",error:("unsupported modality "+$x+" for HF enhance"),state:"error"}'; exit 0 ;;
esac
mkdir -p "$OUTDIR"

# Endpoint: a dedicated HF Inference Endpoint URL ($HF_ENHANCE_ENDPOINT) if set,
# else the inference-providers router (most enhancement models are NOT hosted
# serverless — point HF_ENHANCE_ENDPOINT at a dedicated endpoint or a provider).
url="${HF_ENHANCE_ENDPOINT:-https://router.huggingface.co/hf-inference/models/$model}"
http=$(curl -s -o "$out" -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" -H "x-wait-for-model: true" -H "Accept: $ctype" \
  --data-binary @"$input" "$url")

if [ "$http" = "200" ] && [ -s "$out" ] && ! head -c1 "$out" | grep -q '{'; then
  jq -nc --arg o "$out" --arg m "hf:$model" \
    '{verb:"enhance",format:"json",payload:{output:$o,modality:"model",provider:$m},media:{ref:$o},meta:{provider:$m},state:"ready"}'
else
  raw="$(cat "$out" 2>/dev/null)"; rm -f "$out"
  err="$(jq -r '.error.message // .error // .message // empty' <<<"$raw" 2>/dev/null)"
  [ -z "$err" ] && err="HF enhance failed (http $http). Most upscale/restore models aren't on HF serverless — set HF_ENHANCE_ENDPOINT to a dedicated Inference Endpoint, or use ffmpeg enhance."
  jq -nc --arg e "$err" --arg m "hf:$model" \
    '{verb:"enhance",format:"json",payload:{provider:$m},error:$e,state:"error"}'
fi
