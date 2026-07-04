#!/usr/bin/env bash
# Offline fixture: a bound listen provider that echoes a canned transcript +
# summary regardless of input, so `enhance --summarize` can be tested without a
# real STT backend.
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"listen","kind":"audio.analysis"}'; exit 0 ;;
esac
echo '{"verb":"listen","format":"json","payload":{"transcript":"hello from the fixture","summary":"a short greeting"},"meta":{"provider":"fake:listen"},"state":"ready"}'
