#!/usr/bin/env bash
# Offline fixture: a split provider that claims to have run (payload.op=segment)
# but emits a MALFORMED outputs[] (item missing `ref`). fanOutEnhance would drop
# it to just the parent, losing the artifact — the enhance handler must error.
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
{"verb":"enhance","format":"json","payload":{"op":"segment","input":"$input","count":1,"outputs":[{"kind":"cutout"}]},"media":{"ref":"$input"},"meta":{"provider":"fake:malformed"},"state":"ready"}
EOF
