#!/usr/bin/env bash
# fake geocode provider for offline tests — echoes a fixed place for any input,
# so `exif --geocode` can be exercised without a network call to Nominatim.
set -uo pipefail
case "${1:-run}" in
  init) exit 0 ;;
  describe) echo '{"verb":"geocode","kind":"place","payload":["place"],"needs":[]}'; exit 0 ;;
esac
printf '%s\n' '{"verb":"geocode","format":"json","payload":{"place":"San Francisco, California","provider":"fake"},"state":"ready"}'
