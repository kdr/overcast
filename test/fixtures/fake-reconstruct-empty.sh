#!/usr/bin/env bash
# Offline fixture: a FAILED-but-"ready" reconstruct provider — it echoes the
# requested op but produces an empty outputs[]. Every reconstruct op must yield
# an artifact or error (no matched-nothing case like enhance --ops segment), so
# the verb must reject this as a provider failure, not emit a parent-only
# "success" with zero synthesized media.
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"reconstruct","kind":"media.reconstruction","ops":["view","sweep","model","depth"]}'; exit 0 ;;
esac
input=""; ops="view"
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --ops)   ops="${2:-}"; shift 2 2>/dev/null || shift ;;
  --*) shift 2 2>/dev/null || shift ;;
  *) input="$1"; shift ;;
esac; done
jq -nc --arg inp "$input" --arg o "$ops" \
  '{verb:"reconstruct",format:"json",payload:{op:$o,input:$inp,model:"fake",count:0,outputs:[]},media:{ref:$inp},meta:{provider:"fake:empty"},state:"ready"}'
