#!/usr/bin/env bash
# Fixture listen provider: emits a tinycloud speech-only-style envelope so the
# REAL listen mapper can be exercised offline.
set -euo pipefail
cat <<'JSON'
{"kind":"watch","status":"ready","data":{
  "language":"en",
  "summary":"Two speakers discuss a meeting.",
  "segments":[
    {"start_time":0,"end_time":3,"speaker":"A","transcript":"Hello, are you there?"},
    {"start_time":3,"end_time":6,"speaker":"B","transcript":"Yes, I can hear you."}
  ]}}
JSON
