#!/usr/bin/env bash
# Fixture source provider (exec): exercises the scan/capture/monitor pipeline
# offline. enumerate emits scan.hit JSON pointing at a local media file (so
# capture can copy it in); fetch copies the file to --out.
#   fake-source.sh enumerate --query <q> [--limit N]
#   fake-source.sh fetch --url <path> --out <dest>
set -euo pipefail
op="${1:-enumerate}"; shift || true

# the clip the hits point at: $OVERCAST_FIXTURE_CLIP (set by the test/e2e)
clip="${OVERCAST_FIXTURE_CLIP:-/nonexistent.mp4}"

case "$op" in
  enumerate)
    cat <<JSON
[
  {"title":"fixture hit one","url":"$clip","source":"fixture","published":"2026-06-01","snippet":"first item","media":{"ref":"$clip"}},
  {"title":"fixture hit two","url":"${clip}#2","source":"fixture","published":"2026-06-02","snippet":"second item","media":{"ref":"$clip"}}
]
JSON
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --url) url="$2"; shift 2 ;;
        --out) out="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    src="${url%%#*}"   # strip any #fragment
    cp "$src" "$out" 2>/dev/null || true
    echo "{\"kind\":\"video\",\"path\":\"$out\",\"source\":\"fixture\"}"
    ;;
  *) echo "{}" ;;
esac
