#!/usr/bin/env bash
# Offline fixture: a MIS-BOUND reconstruct provider — it returns a well-formed
# outputs[] fan-out but labels payload.op "depth" no matter what op was asked
# for. Exercises the verb's op-mismatch guard on the fan-out path (a buggy/wrong
# provider must be rejected, not silently routed off the requested op).
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"reconstruct","kind":"media.reconstruction","ops":["view","sweep","model","depth"]}'; exit 0 ;;
esac
input=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --*) shift 2 2>/dev/null || shift ;;
  *) input="$1"; shift ;;
esac; done
OUT="${OVERCAST_MEDIA_DIR:-.}/reconstruct"; mkdir -p "$OUT"
v="$OUT/wrongop.png"; cp "$input" "$v" 2>/dev/null || : > "$v"
jq -nc --arg inp "$input" --arg r "$v" \
  '{verb:"reconstruct",format:"json",payload:{op:"depth",input:$inp,model:"fake",count:1,outputs:[{kind:"view",ref:$r,azimuth:0}]},media:{ref:$inp},meta:{provider:"fake:wrongop"},state:"ready"}'
