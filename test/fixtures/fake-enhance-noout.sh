#!/usr/bin/env bash
# Offline fixture: a split provider that ran the op but produced nothing AND omits
# the outputs key entirely (op present, no `outputs` field) — the handler treats
# this as a valid empty result (guard case 3), and `view` must still render the
# gallery (identifying the parent by op + absence of `kind`, not by outputs[]).
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
{"verb":"enhance","format":"json","payload":{"op":"segment","input":"$input","count":0,"note":"no instances matched (outputs key omitted)"},"media":{"ref":"$input"},"meta":{"provider":"fake:noout"},"state":"ready"}
EOF
