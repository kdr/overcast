#!/usr/bin/env bash
# overcast source provider: gdelttv (GDELT 2.0 Television API — broadcast news
# video search over the Internet Archive TV News Archive). No API key.
# Bind with:  overcast source add gdelttv:"climate change"
#             overcast scan --source gdelttv --query "protest station:CNN"
# Refs / queries: a keyword phrase, optionally with GDELT operators
# (station:CNN, market:"National", etc.). If the query names neither a station
# nor a market, `market:"National"` is added so the API (which requires one)
# still returns results.
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
#
# Each hit's media.ref is a bounded Internet Archive CLIP url
# (…/<show>.mp4?start=S&end=E) — a ~30s broadcast segment that `capture`
# downloads directly (full-show download is copyright-restricted; the clip
# service and thumbnails are public).
set -uo pipefail
API="https://api.gdeltproject.org/api/v2/tv/tv"

op="${1:-enumerate}"; shift || true

case "$op" in
  init)     exit 0 ;;  # no credentials to check
  describe) echo '{"source":"gdelttv","emits":"scan.hit","needs":[]}'; exit 0 ;;

  enumerate)
    query=""; limit=20; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    if [ -z "$query" ]; then
      echo "gdelttv enumerate needs a query: bind gdelttv:\"<phrase>\" or pass --query" >&2
      exit 1
    fi
    # GDELT's clipgallery requires a station or market scope; add a national
    # default when the query specifies neither (case-insensitive check).
    lc="$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]')"
    case "$lc" in
      *station:*|*market:*) : ;;
      *) query="$query market:\"National\"" ;;
    esac
    # GDELT clipgallery caps around 50 results per call.
    [ "$limit" -gt 50 ] 2>/dev/null && limit=50

    # honor --since → &STARTDATETIME=YYYYMMDDHHMMSS (UTC). Portable epoch→stamp:
    # BSD date uses `-r <epoch>`, GNU date uses `-d @<epoch>`.
    startparam=""
    if [ -n "$since" ]; then
      now="$(date -u +%s)"; cutepoch=""
      case "$since" in
        *[0-9]m) cutepoch=$(( now - ${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - ${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - ${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - ${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d' "$since" +%s 2>/dev/null || echo '')" ;;
        # an unparseable --since is a hard error (fail closed): don't silently
        # widen to the full corpus, returning far older content than requested.
        *) echo "gdelttv: could not parse --since '$since' (use Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      # a recognized format whose date conversion failed is also unparseable
      [ -n "$cutepoch" ] || { echo "gdelttv: could not parse --since '$since'" >&2; exit 1; }
      stamp="$(date -u -r "$cutepoch" +%Y%m%d%H%M%S 2>/dev/null || date -u -d "@$cutepoch" +%Y%m%d%H%M%S 2>/dev/null || echo '')"
      endstamp="$(date -u +%Y%m%d%H%M%S)"
      # NOTE: GDELT's TV clipgallery corpus lags real time by weeks — a very
      # recent window (e.g. --since 7d) can legitimately return zero clips.
      [ -n "$stamp" ] && startparam="&STARTDATETIME=$stamp&ENDDATETIME=$endstamp"
    fi

    q="$(jq -rn --arg q "$query" '$q|@uri')"
    url="$API?query=$q&mode=clipgallery&format=json&maxrecords=$limit$startparam"
    if ! run="$(curl -fsS -m 60 "$url")"; then
      echo "gdelttv enumerate request failed for '$query'" >&2; exit 1
    fi
    # a valid response is a JSON object; zero results come back as `{}` (no clips
    # key) — that maps to []. Only a non-JSON body (e.g. the plain-text "Your
    # query must contain at least one station.") is a failure.
    if ! printf '%s' "$run" | jq -e 'type == "object"' >/dev/null 2>&1; then
      echo "gdelttv enumerate: unexpected response: $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    printf '%s' "$run" | jq -c '[(.clips // [])[]
      | (.preview_url // "") as $pu
      | (.ia_show_id // "") as $id
      | ($pu | capture("start/(?<s>[0-9]+)/end/(?<e>[0-9]+)")? // {s:null,e:null}) as $se
      | (if $id != "" and $se.s != null
         then "https://archive.org/download/\($id)/\($id).mp4?start=\($se.s)&end=\($se.e)"
         else null end) as $clip
      | (([(.station // ""), (.show // "")] | map(select(. != "")) | join(" · ")) as $base
         | $base + (if (.date // "") != "" then " (" + (.date[0:10]) + ")" else "" end)) as $title
      | {
          title: $title,
          url: $pu,
          source: "gdelttv",
          published: (.date // null),
          snippet: (.snippet // ""),
          station: (.station // null),
          show: (.show // null),
          thumb: (.preview_thumb // null),
          clip_start: ($se.s // null),
          clip_end: ($se.e // null),
          ia_show_id: (if $id != "" then $id else null end),
          media: { ref: ($clip // .preview_thumb // $pu) }
        }
      | select(.media.ref != null and .media.ref != "")]'
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "gdelttv fetch needs --url" >&2; exit 1; }
    # a hit's ref is a bounded IA clip mp4 (or a thumbnail jpg fallback) — curl it
    # and report the kind by content type (overcast sniffs a missing extension).
    if ! ct="$(curl -fsSL -m 180 -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
      echo "gdelttv fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*) kind="image" ;;
      video/*) kind="video" ;;
      *)       kind="file" ;;
    esac
    jq -nc --arg p "$out" --arg k "$kind" --arg u "$url" '{kind:$k,path:$p,source:"gdelttv",url:$u}'
    ;;

  *) echo "gdelttv source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
