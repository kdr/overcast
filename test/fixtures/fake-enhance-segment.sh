#!/usr/bin/env bash
# Offline fixture: a bound enhance provider emitting a MULTI-OUTPUT "segment"
# envelope (payload.outputs[] = per-instance cutouts + parent detections[]) so the
# fanOutEnhance + crop-interop (box_normalized) paths are exercised without SAM.
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"enhance","kind":"media.enhanced","ops":["segment"]}'; exit 0 ;;
esac
input=""; prompt="the object"
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --prompt) prompt="${2:-}"; shift 2 2>/dev/null || shift ;;
  --ops|--speakers) shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) input="$1"; shift ;;
esac; done
OUT="${OVERCAST_MEDIA_DIR:-.}/segment"
mkdir -p "$OUT"
c0="$OUT/fixture_1.png"; m0="$OUT/fixture_1_mask.png"
: > "$c0"; : > "$m0"
cat <<EOF
{"verb":"enhance","format":"json","payload":{"op":"segment","input":"$input","model":"fake","prompt":"$prompt","count":1,"detections":[{"label":"$prompt","score":0.9,"box":{"xmin":0.1,"ymin":0.2,"xmax":0.5,"ymax":0.6},"box_normalized":true}],"outputs":[{"kind":"cutout","ref":"$c0","mask":"$m0","label":"$prompt","instance":1,"score":0.9,"box":{"xmin":0.1,"ymin":0.2,"xmax":0.5,"ymax":0.6},"box_normalized":true}]},"media":{"ref":"$input"},"meta":{"provider":"fake:segment"},"state":"ready"}
EOF
