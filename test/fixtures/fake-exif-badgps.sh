#!/usr/bin/env bash
# fake exif provider emitting an OUT-OF-RANGE gps — exercises enrichWithPlace's
# WGS84 guard (a bad coordinate must never be egressed to the geocode provider).
set -uo pipefail
case "${1:-run}" in
  init) exit 0 ;;
  describe) echo '{"verb":"exif","kind":"media.metadata","payload":["gps"],"needs":[]}'; exit 0 ;;
esac
printf '%s\n' '{"verb":"exif","format":"json","payload":{"summary":"badgps","gps":{"lat":999,"lng":1.0}},"media":{"ref":"x.jpg"},"state":"ready"}'
