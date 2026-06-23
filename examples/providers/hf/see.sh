#!/usr/bin/env bash
# overcast `see` provider — Hugging Face image captioning (Inference API).
# Default-bound when HF_TOKEN is set (else `see` is a placeholder). Implements
# the exec contract: init | describe | run --input <image> [--ocr] [--prompt ...]
#
# Model: $HF_SEE_MODEL (default Salesforce/blip-image-captioning-large).
set -uo pipefail

MODEL="${HF_SEE_MODEL:-Salesforce/blip-image-captioning-large}"
TOKEN="${HF_TOKEN:-${HUGGING_FACE_HUB_TOKEN:-}}"

need_token() {
  if [ -z "$TOKEN" ]; then
    echo "see (Hugging Face) needs HF_TOKEN (https://huggingface.co/settings/tokens)" >&2
    exit 13
  fi
}

op="${1:-run}"
case "$op" in
  init)     need_token; exit 0 ;;
  describe) echo "{\"verb\":\"see\",\"kind\":\"image.analysis\",\"payload\":[\"caption\"],\"model\":\"$MODEL\",\"needs\":[\"HF_TOKEN\"]}"; exit 0 ;;
esac

# run --input <image>
input=""
while [ "$#" -gt 0 ]; do case "$1" in --input) input="$2"; shift 2 ;; --*) shift ;; *) input="$1"; shift ;; esac; done
need_token
if [ ! -f "$input" ]; then
  echo "{\"verb\":\"see\",\"payload\":{\"error\":\"image not found: $input\"},\"error\":\"image not found\",\"state\":\"error\"}"; exit 0
fi

resp="$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-wait-for-model: true" \
  --data-binary @"$input" \
  "https://api-inference.huggingface.co/models/$MODEL")"

# captioning models return [{"generated_text":"..."}]; errors return {"error":"..."}
caption="$(jq -r 'if type=="array" then .[0].generated_text else empty end' <<<"$resp" 2>/dev/null)"
hferr="$(jq -r 'if type=="object" then (.error // empty) else empty end' <<<"$resp" 2>/dev/null)"

if [ -n "$caption" ]; then
  jq -nc --arg c "$caption" --arg ref "$input" --arg m "hf:$MODEL" \
    '{verb:"see",format:"json",payload:{caption:$c,ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},state:"ready"}'
else
  jq -nc --arg e "${hferr:-no caption returned}" --arg ref "$input" --arg m "hf:$MODEL" \
    '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},error:$e,state:"error"}'
fi
