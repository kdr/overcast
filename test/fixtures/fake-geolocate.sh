#!/usr/bin/env bash
# Fixture geolocate provider: emits a geo.estimate record so the geolocate verb's
# dispatch/pass-through path can be exercised offline (no Picarta key).
set -euo pipefail
op="${1:-run}"
case "$op" in
  describe) echo '{"verb":"geolocate","kind":"geo.estimate","payload":["summary","lat","lng"]}'; exit 0 ;;
esac
input=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  *) shift ;;
esac; done
jq -nc --arg ref "$input" '{verb:"geolocate",format:"json",
  payload:{summary:"geolocation · Paris, France (48.8584,2.2945) · conf 0.62",lat:48.8584,lng:2.2945,city:"Paris",country:"France",confidence:0.62},
  media:{ref:$ref},meta:{provider:"fake-geolocate"},state:"ready"}'
