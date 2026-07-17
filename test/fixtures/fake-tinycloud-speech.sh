#!/usr/bin/env bash
# Fixture tinycloud for the listen DEFAULT path (bound via OVERCAST_TINYCLOUD_CMD):
# `watch` answers with a tinycloud ≥0.3.10-shaped envelope — summary only, NO
# inline speech segments — and `caption` answers with the verbatim cues, so the
# two-step watch→caption transcript wiring is exercised offline.
#   FAKE_TC_CAPTION=fail  → caption exits non-zero (tests the summary fallback path)
#   FAKE_TC_CAPTION=hang  → caption blocks (tests that an abort REJECTS, never a summary)
#   FAKE_TC_WATCH=pending → watch answers a pending async envelope (with a summary)
set -euo pipefail
sub="${1:-}"
case "$sub" in
  watch)
    # strict like the real CLI (0.3.10): watch takes neither --diarize nor
    # --lang — regressing to pushing listen flags onto watch must fail loudly.
    for a in "$@"; do
      case "$a" in
        --diarize|--lang) echo "Error: Unknown flag for watch: $a" >&2; exit 1 ;;
      esac
    done
    if [ "${FAKE_TC_WATCH:-}" = "pending" ]; then
      cat <<'JSON'
{"tinycloud":"1","kind":"watch","status":"pending","data":{"title":"Zurich walk","summary":"A visitor describes exploring Zurich for the first time.","segments":[]}}
JSON
      exit 0
    fi
    cat <<'JSON'
{"tinycloud":"1","kind":"watch","status":"ready","data":{"title":"Zurich walk","summary":"A visitor describes exploring Zurich for the first time.","duration_seconds":5,"segmentation":null,"segments":[]}}
JSON
    ;;
  caption)
    if [ "${FAKE_TC_CAPTION:-}" = "hang" ]; then
      sleep 30
      exit 1
    fi
    if [ "${FAKE_TC_CAPTION:-}" = "fail" ]; then
      echo '{"tinycloud":"1","kind":"caption","status":"needs_upload","data":null,"error":{"code":"needs_upload","message":"No cached speech for this source."}}'
      exit 3
    fi
    if [[ "$*" == *"--diarize"* ]]; then
      cat <<'JSON'
{"tinycloud":"1","kind":"caption","status":"ready","data":{"format":"srt","cues":[
  {"index":1,"start_time":0,"end_time":1.2,"text":"1: We'll walk through the streets"},
  {"index":2,"start_time":1.2,"end_time":2.5,"text":"1: of Zurich."}
],"diarized":true}}
JSON
    else
      cat <<'JSON'
{"tinycloud":"1","kind":"caption","status":"ready","data":{"format":"srt","cues":[
  {"index":1,"start_time":0,"end_time":1.2,"text":"We'll walk through the streets"},
  {"index":2,"start_time":1.2,"end_time":2.5,"text":"of Zurich."}
],"diarized":false}}
JSON
    fi
    ;;
  *)
    echo "fake-tinycloud-speech: unexpected subcommand: $*" >&2
    exit 2
    ;;
esac
