#!/usr/bin/env bash
# overcast source provider: tiktok (Apify clockworks/tiktok-scraper).
# Bind with:  overcast source add tiktok:@user
#             OVERCAST_SOURCE_TIKTOK_CMD="bash examples/providers/sources/tiktok.sh"
# Implements: enumerate --query <user|#tag> [--limit N]  |  fetch --url <u> --out <p>
set -euo pipefail
op="${1:-enumerate}"; shift || true
ACTOR="clockworks~tiktok-scraper"

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"tiktok","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=20
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac; done
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    run=$(curl -s -X POST \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
      -H 'content-type: application/json' \
      -d "{\"profiles\":[\"$query\"],\"resultsPerPage\":$limit}")
    jq -c '[.[] | {title:.text, url:.webVideoUrl, source:"tiktok",
                   published:.createTimeISO, snippet:.text,
                   media:{ref:.webVideoUrl}}]' <<<"$run" ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      *) shift ;;
    esac; done
    yt-dlp -o "$out" "$url" >&2
    echo "{\"kind\":\"video\",\"path\":\"$out\",\"source\":\"tiktok\"}" ;;
  *) echo "{}" ;;
esac
