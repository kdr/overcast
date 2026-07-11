#!/usr/bin/env bash
# overcast source provider: dork (Google dorking via Serper.dev — real Google
# SERPs that HONOR search operators). Unlike the `web` source (Tavily/Brave,
# which quietly IGNORE operators), `dork` passes your query VERBATIM to Google,
# so `site:` `filetype:` `inurl:` `intitle:` `ext:` `-term` `OR` all work.
#
# ⚠️  Authorized recon only. Dorking surfaces exposed documents, directory
# listings, login/admin portals, and misconfigured hosts. Use only against
# targets you are permitted to investigate. Never a default binding — bind it.
#
# Bind with:  overcast source add dork:'site:example.com filetype:pdf'
#             overcast scan --source dork --pull
#             overcast scan --source dork --query 'intitle:"index of" inurl:backup'
# Key: SERPER_API_KEY (https://serper.dev — generous free tier, JSON API).
# Implements the exec source contract:
#   enumerate --query <dork> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail

SERPER="${SERPER_API_KEY:-}"

need() {
  if [ -z "$SERPER" ]; then
    cat >&2 <<'MSG'
dork source needs a Serper.dev key. Set it:
  • SERPER_API_KEY  (https://serper.dev — real Google SERPs that honor operators)
MSG
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"dork","emits":"scan.hit","needs":["SERPER_API_KEY"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""; limit=10; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    need
    [ -n "$query" ] || { echo "dork enumerate needs a query: bind dork:'<google dork>' or pass --query" >&2; exit 1; }
    # honor --since: bucket it into Google's tbs qdr window (d/w/m/y) so a recency
    # filter actually applies, not silently drops. Mirrors web.sh's bucketing.
    qdr=""
    if [ -n "$since" ]; then
      case "$since" in
        *[0-9]m|*[0-9]h) days=1 ;;
        *[0-9]d) days="${since%d}" ;;
        *[0-9]w) days=$(( ${since%w} * 7 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          # explicit date → its age in days, so it buckets by "newer than this date"
          d="$(date -d "$since" +%s 2>/dev/null || date -j -f '%Y-%m-%d %H:%M:%S' "$since 00:00:00" +%s 2>/dev/null || echo '')"
          if [ -n "$d" ]; then days=$(( ( $(date +%s) - d ) / 86400 )); [ "$days" -lt 0 ] && days=0; else days=31; fi ;;
        *) days=31 ;;   # unknown → month-ish bucket
      esac
      if   [ "$days" -le 1 ];  then qdr="d"
      elif [ "$days" -le 7 ];  then qdr="w"
      elif [ "$days" -le 31 ]; then qdr="m"
      else                          qdr="y"; fi
    fi
    body="$(jq -nc --arg q "$query" --argjson n "$limit" --arg tbs "$qdr" \
      '{q:$q, num:$n} + (if $tbs != "" then {tbs:("qdr:"+$tbs)} else {} end)')"
    # -f fails the request on HTTP errors (bad/expired key, rate limit) so a
    # credential/API failure surfaces as an enumerate error, not empty hits.
    if ! resp="$(curl -fsS -m 30 -X POST "https://google.serper.dev/search" \
      -H "X-API-KEY: $SERPER" -H "Content-Type: application/json" -d "$body")"; then
      echo "dork (serper) search request failed for '$query'" >&2; exit 1
    fi
    # Serper reports API-level failures (bad key, quota, bad params) as a JSON body
    # with a `message`/`statusCode` and NO `organic` key — and while those usually
    # arrive non-2xx (caught by curl -f), a body-level guard makes a fake-clean empty
    # scan impossible if one ever returns 2xx. A genuine 0-result search still carries
    # an (empty) `organic` array, so it passes through as a clean zero-hit scan.
    serr="$(printf '%s' "$resp" | jq -r 'if (has("organic")|not) and ((.message // .error) != null) then (.message // .error) else empty end' 2>/dev/null)"
    [ -z "$serr" ] || { echo "dork (serper) API error: $serr" >&2; exit 1; }
    # organic results carry the operators-honored hits; media.ref is the page url
    # so `capture`/--pull downloads the result page as evidence (like web.sh).
    printf '%s' "$resp" | jq -c '[ (.organic // [])[] | {title:.title, url:.link, source:"dork", published:(.date // null), snippet:(.snippet // ""), media:{ref:.link}} ]'
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    [ -n "$url" ] || { echo "dork fetch needs --url" >&2; exit 1; }
    # -f fails on HTTP errors; report a real failure instead of a ready-looking
    # capture pointing at a missing/empty file. Don't double the suffix when
    # --out already ends in .html/.htm (uniqueName preserves URL extensions).
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"dork",url:$u}'
    else
      echo "dork fetch failed for $url" >&2
      rm -f "$page"
      exit 1
    fi
    ;;
  *) echo "dork source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
