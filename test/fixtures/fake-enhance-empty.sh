#!/usr/bin/env bash
# Offline fixture: a split provider that ran the op but produced nothing (e.g. a
# segment prompt that matched no instances) — payload.op set, outputs empty. This
# is a VALID ready result: the handler must return the parent, not an error.
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"enhance","kind":"media.enhanced","ops":["segment"]}'; exit 0 ;;
esac
input=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --ops|--prompt|--speakers) shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) input="$1"; shift ;;
esac; done
cat <<EOF
{"verb":"enhance","format":"json","payload":{"op":"segment","input":"$input","prompt":"nothing","count":0,"detections":[],"outputs":[],"note":"no instances matched"},"media":{"ref":"$input"},"meta":{"provider":"fake:empty"},"state":"ready"}
EOF
