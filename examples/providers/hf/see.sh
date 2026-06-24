#!/usr/bin/env bash
# overcast `see` provider — Hugging Face vision-LLM captioning via the Inference
# Providers chat-completions API (the classic image-to-text endpoint is gone).
# Default-bound when HF_TOKEN is set. Contract: init | describe | run --input <img>
#   [--ocr] [--prompt "<focus>"]
#
# Model: $HF_SEE_MODEL (default google/gemma-3-27b-it — a vision model served by
# the inference providers). Override if your enabled providers offer a different
# VLM (Qwen2.5-VL, Llama-Vision, etc.).
set -uo pipefail

MODEL="${HF_SEE_MODEL:-google/gemma-3-27b-it}"
TOKEN="${HF_TOKEN:-${HUGGING_FACE_HUB_TOKEN:-}}"
ENDPOINT="https://router.huggingface.co/v1/chat/completions"

need_token() { [ -n "$TOKEN" ] || { echo "see (Hugging Face) needs HF_TOKEN (https://huggingface.co/settings/tokens)" >&2; exit 13; }; }

op="${1:-run}"
case "$op" in
  init)     need_token; exit 0 ;;
  describe) echo "{\"verb\":\"see\",\"kind\":\"image.analysis\",\"payload\":[\"caption\",\"ocr\"],\"model\":\"$MODEL\",\"needs\":[\"HF_TOKEN\"]}"; exit 0 ;;
esac

input=""; ocr=0; prompt=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="$2"; shift 2 ;;
  --ocr) ocr=1; shift ;;
  --prompt) prompt="$2"; shift 2 ;;
  --*) shift ;;
  *) input="$1"; shift ;;
esac; done
need_token
[ -f "$input" ] || { jq -nc --arg i "$input" '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[],error:("image not found: "+$i)},error:"image not found",state:"error"}'; exit 0; }

# mime from extension; base64 data URL
case "$(echo "${input##*.}" | tr 'A-Z' 'a-z')" in
  jpg|jpeg) mime="image/jpeg" ;; png) mime="image/png" ;; webp) mime="image/webp" ;; gif) mime="image/gif" ;; *) mime="image/png" ;;
esac
b64="$(base64 -i "$input" 2>/dev/null | tr -d '\n')" || b64="$(base64 "$input" | tr -d '\n')"

instruction="${prompt:-Describe this image in detail (people, objects, text, setting).}"
[ "$ocr" = "1" ] && instruction="$instruction Also transcribe any visible text (OCR)."

req="$(jq -nc --arg m "$MODEL" --arg t "$instruction" --arg url "data:$mime;base64,$b64" \
  '{model:$m, max_tokens:400, messages:[{role:"user", content:[{type:"text",text:$t},{type:"image_url",image_url:{url:$url}}]}]}')"

resp="$(curl -s -X POST "$ENDPOINT" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$req")"
caption="$(jq -r '.choices[0].message.content // empty' <<<"$resp" 2>/dev/null)"
hferr="$(jq -r '(.error.message // .error // .message // empty)' <<<"$resp" 2>/dev/null)"

if [ -n "$caption" ]; then
  jq -nc --arg c "$caption" --arg ref "$input" --arg m "hf:$MODEL" \
    '{verb:"see",format:"json",payload:{caption:$c,ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},state:"ready"}'
else
  jq -nc --arg e "${hferr:-no caption returned}" --arg ref "$input" --arg m "hf:$MODEL" \
    '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},error:$e,state:"error"}'
fi
