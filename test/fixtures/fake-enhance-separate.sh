#!/usr/bin/env bash
# Offline fixture: a bound enhance provider emitting a MULTI-OUTPUT "separate"
# envelope (payload.outputs[] = per-speaker tracks) so the real fanOutEnhance +
# --summarize paths are exercised without pyannote/fal. Writes empty track files
# under $OVERCAST_MEDIA_DIR/separate so media.ref points at real paths.
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"enhance","kind":"media.enhanced","ops":["separate"]}'; exit 0 ;;
esac
input=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --ops|--prompt|--speakers) shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) input="$1"; shift ;;
esac; done
OUT="${OVERCAST_MEDIA_DIR:-.}/separate"
mkdir -p "$OUT"
t0="$OUT/fixture_SPEAKER_00.wav"; t1="$OUT/fixture_SPEAKER_01.wav"
: > "$t0"; : > "$t1"
cat <<EOF
{"verb":"enhance","format":"json","payload":{"op":"separate","input":"$input","model":"fake","speakers":2,"count":2,"overlap":[{"at":[1.0,1.5],"speakers":["SPEAKER_00","SPEAKER_01"]}],"outputs":[{"kind":"track","ref":"$t0","speaker":"SPEAKER_00","speech_seconds":3.2,"segments":[{"at":[0.0,3.2]}],"overlap":[{"at":[1.0,1.5],"speakers":["SPEAKER_00","SPEAKER_01"]}]},{"kind":"track","ref":"$t1","speaker":"SPEAKER_01","speech_seconds":1.5,"segments":[{"at":[3.2,4.7]}],"overlap":[]}]},"media":{"ref":"$input"},"meta":{"provider":"fake:separate"},"state":"ready"}
EOF
