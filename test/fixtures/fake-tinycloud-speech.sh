#!/usr/bin/env bash
# Fixture tinycloud for the listen DEFAULT path (bound via OVERCAST_TINYCLOUD_CMD):
# `watch` answers a tinycloud ≥0.3.12-shaped envelope — VERBATIM speech inlined
# as segments[].speech (string arrays; a boundary cue repeats in the next
# segment, like the real CLI) — so the single-call watch transcript wiring is
# exercised offline. `caption` answers the verbatim cues for the --diarize pass
# and the legacy (<0.3.12) fallback.
#   FAKE_TC_WATCH=nospeech → watch answers a 0.3.10/0.3.11-shaped envelope
#                            (summary only, segments: []) — tests the legacy
#                            caption-verb fallback path
#   FAKE_TC_WATCH=pending  → watch answers a pending async envelope (with a summary)
#   FAKE_TC_CAPTION=fail   → caption exits non-zero (tests the summary fallback path)
#   FAKE_TC_CAPTION=hang   → caption blocks (tests that an abort REJECTS, never a summary)
#   FAKE_TC_DIARIZED=off    → caption honors --diarize but answers diarized:false
#                             with "Word: …"-shaped SPEECH (diarization unavailable —
#                             tests that no phantom speaker is lifted)
#   FAKE_TC_DIARIZED=absent → caption answers speaker-prefixed cues WITHOUT the
#                             diarized field (an envelope that never confirms —
#                             lifting must not happen on a missing flag either)
set -euo pipefail
sub="${1:-}"
case "$sub" in
  watch)
    # strict like the real CLI (0.3.12): watch takes neither --diarize nor
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
    if [ "${FAKE_TC_WATCH:-}" = "nospeech" ]; then
      # 0.3.10/0.3.11: watch stopped inlining speech (segments: [] for audio /
      # short sources) — listen must fall back to the caption verb.
      cat <<'JSON'
{"tinycloud":"1","kind":"watch","status":"ready","data":{"title":"Zurich walk","summary":"A visitor describes exploring Zurich for the first time.","duration_seconds":5,"segmentation":null,"segments":[]}}
JSON
      exit 0
    fi
    # 0.3.12 (watch.speech.v1): verbatim cues ride segments[].speech; a cue
    # touching the segment boundary is repeated in the NEXT segment's array —
    # the mapper must dedupe it, never store it twice.
    cat <<'JSON'
{"tinycloud":"1","kind":"watch","status":"ready","data":{"title":"Zurich walk","summary":"A visitor describes exploring Zurich for the first time.","duration_seconds":5,"segmentation":"uniform:20","segments":[
  {"index":1,"start_time":0,"end_time":1.2,"description":"We'll walk through the streets","summary":null,"thumbnail_url":null,"speech":["We'll walk through the streets"]},
  {"index":2,"start_time":1.2,"end_time":2.5,"description":"of Zurich.","summary":null,"thumbnail_url":null,"speech":["We'll walk through the streets","of Zurich."]}
]}}
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
    if [ "${FAKE_TC_DIARIZED:-}" = "off" ]; then
      cat <<'JSON'
{"tinycloud":"1","kind":"caption","status":"ready","data":{"format":"srt","cues":[
  {"index":1,"start_time":0,"end_time":1.2,"text":"Warning: do not cross the bridge"}
],"diarized":false}}
JSON
    elif [ "${FAKE_TC_DIARIZED:-}" = "absent" ]; then
      cat <<'JSON'
{"tinycloud":"1","kind":"caption","status":"ready","data":{"format":"srt","cues":[
  {"index":1,"start_time":0,"end_time":1.2,"text":"1: We'll walk through the streets"}
]}}
JSON
    elif [[ "$*" == *"--diarize"* ]]; then
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
