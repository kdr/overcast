#!/usr/bin/env bash
# fake exiftool emitting an OUT-OF-RANGE GPS — verifies exif.sh's WGS84 guard
# (payload.gps suppressed to null, summary flags it invalid, consistent with map).
set -uo pipefail
case "${1:-}" in
  -ver) echo "12.76"; exit 0 ;;
esac
printf '%s\n' '[{"SourceFile":"bad.jpg","GPSLatitude":999,"GPSLongitude":2.5,"Make":"TestCam","MIMEType":"image/jpeg","ImageWidth":10,"ImageHeight":10}]'
