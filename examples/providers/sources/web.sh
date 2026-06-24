#!/usr/bin/env bash
# overcast source provider: web search (Tavily default, Brave fallback).
#   overcast source add web:"pier 9 dock incident"
#   overcast scan --source web --query "..." --pull
# Keys: TAVILY_API_KEY (preferred) or BRAVE_API_KEY. Implements the exec source
# contract: enumerate --query <q> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail

TAVILY="${TAVILY_API_KEY:-}"
BRAVE="${BRAVE_API_KEY:-}"

need() {
  if [ -z "$TAVILY" ] && [ -z "$BRAVE" ]; then
    cat >&2 <<'MSG'
web source needs a search key. Set one:
  • TAVILY_API_KEY  (https://tavily.com — generous free tier, JSON API)  [preferred]
  • BRAVE_API_KEY   (https://brave.com/search/api)
MSG
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"web","emits":"scan.hit","needs":["TAVILY_API_KEY|BRAVE_API_KEY"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""; limit=8
    while [ "$#" -gt 0 ]; do case "$1" in --query) query="$2"; shift 2 ;; --limit) limit="$2"; shift 2 ;; *) shift ;; esac; done
    need
    # -f fails the request on HTTP errors (bad/expired key, rate limit) so a
    # credential/API failure surfaces as an enumerate error, not empty hits.
    if [ -n "$TAVILY" ]; then
      if ! resp="$(curl -fsS -m 30 -X POST "https://api.tavily.com/search" -H "Content-Type: application/json" \
        -d "$(jq -nc --arg k "$TAVILY" --arg q "$query" --argjson n "$limit" '{api_key:$k, query:$q, max_results:$n, search_depth:"basic"}')")"; then
        echo "web (tavily) search request failed for '$query'" >&2; exit 1
      fi
      printf '%s' "$resp" | jq -c '[ (.results // [])[] | {title:.title, url:.url, source:"web", published:(.published_date // null), snippet:(.content // ""), media:{ref:.url}} ]'
    else
      if ! resp="$(curl -fsS -m 30 -G "https://api.search.brave.com/res/v1/web/search" \
        --data-urlencode "q=$query" --data-urlencode "count=$limit" \
        -H "X-Subscription-Token: $BRAVE" -H "Accept: application/json")"; then
        echo "web (brave) search request failed for '$query'" >&2; exit 1
      fi
      printf '%s' "$resp" | jq -c '[ (.web.results // [])[] | {title:.title, url:.url, source:"web", published:(.age // null), snippet:(.description // ""), media:{ref:.url}} ]'
    fi
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="$2"; shift 2 ;; --out) out="$2"; shift 2 ;; *) shift ;; esac; done
    # -f fails on HTTP errors; report a real failure instead of a ready-looking
    # capture pointing at a missing/empty file.
    if curl -fsSL -m 60 -o "${out}.html" "$url"; then
      echo "{\"kind\":\"page\",\"path\":\"${out}.html\",\"source\":\"web\",\"url\":\"$url\"}"
    else
      echo "web fetch failed for $url" >&2
      rm -f "${out}.html"
      exit 1
    fi
    ;;
  *) echo "{}" ;;
esac
