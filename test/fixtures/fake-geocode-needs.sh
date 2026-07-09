#!/usr/bin/env bash
# fake geocode provider that reports a DEPENDENCY gap (exit 13 → needs_credentials)
# — exercises enrichWithPlace distinguishing a provider/setup gap from a lookup miss.
set -uo pipefail
case "${1:-run}" in
  describe) echo '{"verb":"geocode","kind":"place","payload":["place"],"needs":["curl"]}'; exit 0 ;;
esac
echo "geocode needs curl (not found on PATH)" >&2
exit 13
