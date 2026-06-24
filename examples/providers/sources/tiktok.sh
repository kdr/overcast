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
    # a `#tag` ref scrapes a hashtag (actor's `hashtags` field); otherwise a
    # profile/user. Strip a leading '#'/'@' for the field value.
    # build the body with jq so a query containing " or \ can't break the JSON
    case "$query" in
      \#*) input="$(jq -nc --arg t "${query#\#}" --argjson n "$limit" '{hashtags:[$t],resultsPerPage:$n}')" ;;
      *)   input="$(jq -nc --arg p "${query#@}" --argjson n "$limit" '{profiles:[$p],resultsPerPage:$n}')" ;;
    esac
    # -f fails the request on HTTP errors so Apify error JSON isn't parsed as hits
    if ! run=$(curl -fsS -X POST \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
      -H 'content-type: application/json' -d "$input"); then
      echo "tiktok enumerate request failed for '$query'" >&2; exit 1
    fi
    # Apify returns a JSON array on success; anything else (an error object) is a failure
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "tiktok enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    jq -c '[.[] | {title:.text, url:.webVideoUrl, source:"tiktok",
                   published:.createTimeISO, snippet:.text,
                   media:{ref:.webVideoUrl}}]' <<<"$run" ;;
  fetch)
    # enumerate uses Apify, but fetch downloads with yt-dlp — verify it's present
    # so a capture fails clearly instead of erroring mid-download.
    if ! command -v yt-dlp >/dev/null 2>&1; then
      echo "tiktok fetch needs yt-dlp on PATH (enumerate uses APIFY_TOKEN; fetch uses yt-dlp)" >&2
      exit 13
    fi
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      *) shift ;;
    esac; done
    if yt-dlp -o "$out" "$url" >&2; then
      # yt-dlp may append an extension; resolve the actual file written
      real="$out"; [ -f "$out" ] || real="$(ls "${out%.*}".* 2>/dev/null | head -1)"
      echo "{\"kind\":\"video\",\"path\":\"${real:-$out}\",\"source\":\"tiktok\"}"
    else
      echo "tiktok fetch failed for $url" >&2; exit 1
    fi ;;
  *) echo "{}" ;;
esac
