#!/usr/bin/env bash
# Fixture verify provider: emits a media.provenance record so the verify verb's
# dispatch/pass-through path can be exercised offline (no c2patool).
set -euo pipefail
op="${1:-run}"
case "$op" in
  describe) echo '{"verb":"verify","kind":"media.provenance","payload":["summary","has_manifest"]}'; exit 0 ;;
esac
input=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  *) shift ;;
esac; done
jq -nc --arg ref "$input" '{verb:"verify",format:"json",
  payload:{summary:"C2PA manifest · signer:TestCA · Valid",has_manifest:true,signer:"TestCA",validation_state:"Valid"},
  media:{ref:$ref},meta:{provider:"fake-verify"},state:"ready"}'
