#!/usr/bin/env bash
# fake geocode provider that resolves NO place (a valid ready record with
# place:null) — exercises the enrichWithPlace "no place → geocode_status" path.
set -uo pipefail
case "${1:-run}" in
  init) exit 0 ;;
  describe) echo '{"verb":"geocode","kind":"place","payload":["place"],"needs":[]}'; exit 0 ;;
esac
printf '%s\n' '{"verb":"geocode","format":"json","payload":{"place":null,"provider":"fake"},"state":"ready"}'
