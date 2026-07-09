#!/usr/bin/env bash
# fake exif provider emitting NO gps — exercises exif --geocode's actionable
# "no GPS coordinates to geocode" feedback on non-geotagged media.
set -uo pipefail
case "${1:-run}" in
  init) exit 0 ;;
  describe) echo '{"verb":"exif","kind":"media.metadata","payload":["gps"],"needs":[]}'; exit 0 ;;
esac
printf '%s\n' '{"verb":"exif","format":"json","payload":{"summary":"nogps","gps":null},"media":{"ref":"x.jpg"},"state":"ready"}'
