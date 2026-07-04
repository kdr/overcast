#!/usr/bin/env bash
# Offline fixture: a LEGACY single-output enhance provider (no payload.outputs[]).
# Confirms fanOutEnhance passes single-output providers through unchanged
# (backward compat with the shipped hf/fal/elevenlabs enhance scripts).
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"enhance","kind":"media.enhanced"}'; exit 0 ;;
esac
# the output is a fixed path; just consume args (value-flags take a value) so a
# trailing value-less flag can't crash under set -u.
while [ "$#" -gt 0 ]; do case "$1" in
  --input|--ops|--prompt|--speakers) shift 2 2>/dev/null || shift ;;
  *) shift ;;
esac; done
OUT="${OVERCAST_MEDIA_DIR:-.}/fixture_single.png"
: > "$OUT"
cat <<EOF
{"verb":"enhance","format":"json","payload":{"output":"$OUT","ops":["fake"],"model":"fake"},"media":{"ref":"$OUT"},"meta":{"provider":"fake:single"},"state":"ready"}
EOF
