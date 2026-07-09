#!/usr/bin/env bash
# fake exiftool emitting an INCOMPLETE GPS (latitude only, no longitude) — verifies
# exif.sh classifies it as malformed (gps null + summary "GPS malformed or
# incomplete"), distinct from a true out-of-range failure.
set -uo pipefail
case "${1:-}" in
  -ver) echo "12.76"; exit 0 ;;
esac
printf '%s\n' '[{"SourceFile":"m.jpg","GPSLatitude":37.7,"Make":"TestCam","MIMEType":"image/jpeg","ImageWidth":10,"ImageHeight":10}]'
