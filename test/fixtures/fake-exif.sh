#!/usr/bin/env bash
# Fixture exif provider: emits a media.metadata record so the exif verb's
# dispatch/pass-through/provenance path can be exercised offline (no exiftool).
set -euo pipefail
op="${1:-run}"
case "$op" in
  describe) echo '{"verb":"exif","kind":"media.metadata","payload":["summary","gps"]}'; exit 0 ;;
esac
input=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  *) shift ;;
esac; done
jq -nc --arg ref "$input" '{verb:"exif",format:"json",
  payload:{summary:"GPS 1.5,2.5 · TestCam ModelX",gps:{lat:1.5,lng:2.5},make:"TestCam",model:"ModelX"},
  media:{ref:$ref},meta:{provider:"fake-exif"},state:"ready"}'
