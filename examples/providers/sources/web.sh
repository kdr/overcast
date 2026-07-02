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
    query=""; limit=8; since=""
    while [ "$#" -gt 0 ]; do case "$1" in --query) query="${2:-}"; shift 2 2>/dev/null || shift ;; --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;; --since) since="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    need
    # honor --since: bucket it into Tavily's `time_range` / Brave's `freshness`
    # (day/week/month/year) so a recency filter actually applies, not silently drops.
    tav_range=""; brave_fresh=""
    if [ -n "$since" ]; then
      case "$since" in
        *[0-9]m|*[0-9]h) days=1 ;;
        *[0-9]d) days="${since%d}" ;;
        *[0-9]w) days=$(( ${since%w} * 7 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          # explicit date → its age in days, so it buckets by "newer than this date"
          d="$(date -d "$since" +%s 2>/dev/null || date -j -f '%Y-%m-%d' "$since" +%s 2>/dev/null || echo '')"
          if [ -n "$d" ]; then days=$(( ( $(date +%s) - d ) / 86400 )); [ "$days" -lt 0 ] && days=0; else days=31; fi ;;
        *) days=31 ;;   # unknown → month-ish bucket
      esac
      if   [ "$days" -le 1 ];  then tav_range="day";   brave_fresh="pd"
      elif [ "$days" -le 7 ];  then tav_range="week";  brave_fresh="pw"
      elif [ "$days" -le 31 ]; then tav_range="month"; brave_fresh="pm"
      else                          tav_range="year";  brave_fresh="py"; fi
    fi
    # -f fails the request on HTTP errors (bad/expired key, rate limit) so a
    # credential/API failure surfaces as an enumerate error, not empty hits.
    if [ -n "$TAVILY" ]; then
      body="$(jq -nc --arg k "$TAVILY" --arg q "$query" --argjson n "$limit" --arg tr "$tav_range" \
        '{api_key:$k, query:$q, max_results:$n, search_depth:"basic"} + (if $tr != "" then {time_range:$tr} else {} end)')"
      if ! resp="$(curl -fsS -m 30 -X POST "https://api.tavily.com/search" -H "Content-Type: application/json" -d "$body")"; then
        echo "web (tavily) search request failed for '$query'" >&2; exit 1
      fi
      printf '%s' "$resp" | jq -c '[ (.results // [])[] | {title:.title, url:.url, source:"web", published:(.published_date // null), snippet:(.content // ""), media:{ref:.url}} ]'
    else
      # freshness (pd/pw/pm/py) has no special chars → safe as a URL query param;
      # avoids an empty-array expansion under `set -u` on older bash.
      brave_url="https://api.search.brave.com/res/v1/web/search"
      [ -n "$brave_fresh" ] && brave_url="$brave_url?freshness=$brave_fresh"
      if ! resp="$(curl -fsS -m 30 -G "$brave_url" \
        --data-urlencode "q=$query" --data-urlencode "count=$limit" \
        -H "X-Subscription-Token: $BRAVE" -H "Accept: application/json")"; then
        echo "web (brave) search request failed for '$query'" >&2; exit 1
      fi
      printf '%s' "$resp" | jq -c '[ (.web.results // [])[] | {title:.title, url:.url, source:"web", published:(.age // null), snippet:(.description // ""), media:{ref:.url}} ]'
    fi
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    # -f fails on HTTP errors; report a real failure instead of a ready-looking
    # capture pointing at a missing/empty file. Don't double the suffix when
    # --out already ends in .html/.htm (uniqueName preserves URL extensions).
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"web",url:$u}'
    else
      echo "web fetch failed for $url" >&2
      rm -f "$page"
      exit 1
    fi
    ;;
  *) echo "web source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
