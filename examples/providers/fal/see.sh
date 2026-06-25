#!/usr/bin/env bash
# overcast `see` provider — fal.ai (direct, FAL_KEY). Florence-2 vision:
# detailed caption by default, OCR with --ocr. Contract: init|describe|run.
#   overcast setup provider see "exec:bash examples/providers/fal/see.sh {{input}}"
# Model: $FAL_SEE_MODEL (default fal-ai/florence-2-large).
set -uo pipefail

MODEL="${FAL_SEE_MODEL:-fal-ai/florence-2-large}"
KEY="${FAL_KEY:-${FAL_API_KEY:-}}"
need() { [ -n "$KEY" ] || { echo "see (fal.ai) needs FAL_KEY (https://fal.ai/dashboard/keys)" >&2; exit 13; }; }

op="${1:-run}"
case "$op" in
  init)     need; exit 0 ;;
  describe) echo "{\"verb\":\"see\",\"kind\":\"image.analysis\",\"payload\":[\"caption\",\"ocr\"],\"model\":\"$MODEL\",\"needs\":[\"FAL_KEY\"]}"; exit 0 ;;
esac

input=""; ocr=0
while [ "$#" -gt 0 ]; do case "$1" in --input) input="${2:-}"; shift 2 2>/dev/null || shift ;; --ocr) ocr=1; shift ;; --*) shift ;; *) input="$1"; shift ;; esac; done
need
[ -f "$input" ] || { jq -nc --arg i "$input" '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[]},error:("image not found: "+$i),state:"error"}'; exit 0; }

case "$(echo "${input##*.}" | tr 'A-Z' 'a-z')" in jpg|jpeg) mime=image/jpeg ;; webp) mime=image/webp ;; *) mime=image/png ;; esac
b64="$(base64 -i "$input" 2>/dev/null | tr -d '\n')" || b64="$(base64 "$input" | tr -d '\n')"

# florence-2 sub-endpoint: detailed caption, or OCR
sub="more-detailed-caption"; [ "$ocr" = "1" ] && sub="ocr"
resp="$(curl -s -m 90 -X POST "https://fal.run/$MODEL/$sub" \
  -H "Authorization: Key $KEY" -H "Content-Type: application/json" \
  -d "{\"image_url\":\"data:$mime;base64,$b64\"}")"

text="$(jq -r '.results // .output // empty' <<<"$resp" 2>/dev/null)"
err="$(jq -r '(.detail // .error // empty)' <<<"$resp" 2>/dev/null)"
if [ -n "$text" ]; then
  key=caption; [ "$ocr" = "1" ] && key=ocr
  jq -nc --arg t "$text" --arg ref "$input" --arg m "fal:$MODEL" --arg k "$key" \
    '{verb:"see",format:"json",payload:({caption:"",ocr:"",detections:[]} + {($k):$t}),media:{ref:$ref},meta:{provider:$m},state:"ready"}'
else
  jq -nc --arg e "${err:-no result}" --arg ref "$input" --arg m "fal:$MODEL" \
    '{verb:"see",format:"json",payload:{caption:"",ocr:"",detections:[]},media:{ref:$ref},meta:{provider:$m},error:$e,state:"error"}'
fi
