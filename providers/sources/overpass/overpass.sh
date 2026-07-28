#!/usr/bin/env bash
# overcast source provider: overpass (OpenStreetMap features via the Overpass API
# — turn "every hospital / camera / fuel station / named place in this area" into
# geolocated case records that plot on `overcast map`). No API key.
#
# Bind with:  overcast source add 'overpass:amenity=hospital@around:2000,48.8584,2.2945'
#             overcast source add 'overpass:man_made=surveillance@48.85,2.34,48.87,2.36'
#             overcast scan   --source overpass --limit 100
#             overcast map     --no-open                 # every feature on one map
#             overcast monitor --source overpass --every 24h
# Refs / queries (enumerate --query):
#   key=value@around:<radius_m>,<lat>,<lng>   — features within <radius_m> of a point
#   key=value@<south,west,north,east>         — features inside a bbox
#   <raw OverpassQL>                          — any query containing `[out:` or `;`
#                                               is passed through verbatim
# Each element becomes one hit carrying top-level gps:{lat,lng} (from the node's
# lat/lon, or a way/relation's `out center` centroid) so the scan record plots on
# `map`; media.ref is the openstreetmap.org element page so `capture` stores it.
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
# shared outbound-fetch guard (scheme pinning, bounded redirects, private-address
# refusal on the FINAL hop) — see providers/engines/net/guarded-fetch.sh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../engines/net/guarded-fetch.sh
. "$here/../../engines/net/guarded-fetch.sh"

API="https://overpass-api.de/api/interpreter"
# overpass-api.de rejects requests with no/blank User-Agent (HTTP 406, content
# negotiation) — always send a real one. Override via OVERCAST_HTTP_UA.
UA="${OVERCAST_HTTP_UA:-overcast-osint/0.0.8 (+https://github.com/kdr/overcast)}"

# escape a tag key/value for safe embedding inside OverpassQL double quotes — an
# OSM value containing `"` or `\` would otherwise break or alter the generated
# query. Backslash first, then the quote, so the added backslash is not doubled.
esc_ql() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

# a numeric coordinate/radius (digits, optional leading sign + decimal) and NOTHING
# else — so a friendly region can neither smuggle OverpassQL punctuation (`)`/`;`)
# into the generated query nor be confused with raw QL.
is_coord() { [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; }

# is $1 a VALID friendly region — `around:<radius>,<lat>,<lng>` or a 4-number
# `<south,west,north,east>` bbox, every part numeric? This (NOT a substring marker)
# decides friendly-vs-raw: a tag VALUE can contain `[out:`, `;`, or `@`, so only a
# real numeric region after the LAST `@` makes a ref friendly.
is_region() {
  local a b c d e IFS=,
  case "$1" in
    around:*) read -r a b c d   <<<"${1#around:}"; [ -z "${d:-}" ] && is_coord "$a" && is_coord "$b" && is_coord "$c" ;;
    *)        read -r a b c d e <<<"$1";           [ -z "${e:-}" ] && is_coord "$a" && is_coord "$b" && is_coord "$c" && is_coord "$d" ;;
  esac
}

op="${1:-enumerate}"; shift || true

case "$op" in
  init)     exit 0 ;;  # no credentials to check (public Overpass API)
  describe) echo '{"source":"overpass","emits":"scan.hit","needs":[]}'; exit 0 ;;

  enumerate)
    query=""; limit=50; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # trim surrounding whitespace so a padded ref still parses (a whitespace-only
    # query then trips the empty check below) — consistent with the other sources.
    query="${query#"${query%%[![:space:]]*}"}"; query="${query%"${query##*[![:space:]]}"}"
    if [ -z "$query" ]; then
      echo "overpass enumerate needs a query: bind overpass:<key=value@region> or pass --query" >&2
      exit 1
    fi
    # sane bounds; a dense tag over a wide area can return tens of thousands.
    case "$limit" in ''|*[!0-9]*) limit=50 ;; esac
    [ "$limit" -gt 1000 ] 2>/dev/null && limit=1000
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1
    # Fetch a BROADER candidate pool than the requested limit so the client-side
    # newest-first sort (below) can surface recently-edited features. Overpass
    # `out N` returns the first N in type-then-id order (lowest node ids first,
    # ways/relations last), so a raw server cap would drop the newest features that
    # --since/newer is meant to surface. qlimit bounds the fetch; the sort + `.[0:$n]`
    # then keep the $limit most-recently-edited.
    qlimit=$(( limit * 4 )); [ "$qlimit" -gt 2000 ] && qlimit=2000

    # honor --since → an OSM `(newer:"<ISO>")` filter (only elements edited after the
    # cutoff). Portable epoch→stamp: BSD date uses `-r <epoch>`, GNU date uses
    # `-d @<epoch>` (mirrors gdelttv.sh). Applied only to the friendly
    # form (raw OverpassQL is passed through untouched — the author owns its filters).
    newer=""
    if [ -n "$since" ]; then
      now="$(date -u +%s)"; cutepoch=""
      case "$since" in
        *[0-9]s) cutepoch=$(( now - 10#${since%s} )) ;;
        *[0-9]m) cutepoch=$(( now - 10#${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - 10#${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - 10#${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - 10#${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$since 00:00:00" +%s 2>/dev/null || echo '')" ;;
        # an unparseable --since is a hard error (fail closed): don't silently drop
        # the recency filter and return the full, unfiltered feature set.
        *) echo "overpass: could not parse --since '$since' (use Ns/Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      [ -n "$cutepoch" ] || { echo "overpass: could not parse --since '$since'" >&2; exit 1; }
      iso="$(date -u -r "$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
      [ -n "$iso" ] || { echo "overpass: could not format --since '$since' into an ISO timestamp" >&2; exit 1; }
      newer="(newer:\"$iso\")"
    fi

    # kv rides into the fallback title (`key=value #<id>`) when an element has no name.
    kv=""
    # Decide friendly `key=value@region` vs raw OverpassQL by the REGION (the part
    # after the LAST `@`), NOT by substring markers — a tag VALUE can legitimately
    # contain `[out:`, `;`, or `@`. A ref is friendly ONLY when that suffix is a
    # valid NUMERIC region (is_region); anything else carrying a settings block /
    # statement terminator is raw; the rest is an error.
    # the @-suffix, with inner spaces stripped so a spaced region ("48.85, 2.34,
    # 48.87, 2.36") still validates — is_region is the gate, so stripping is safe
    # even when the query has no @ (a raw QL's stripped form is never a valid region).
    # Consistent with the space handling in firms/flights bbox parsing.
    region="${query##*@}"; region="${region// /}"
    if [ "$query" != "$region" ] && is_region "$region"; then
      # FRIENDLY: expand key=value@region → node/way/relation QL with `out center meta`.
      tagpart="${query%@*}"
      [ -n "$tagpart" ] || { echo "overpass: empty tag in '$query' (expected key=value@region)" >&2; exit 1; }
      case "$tagpart" in
        *'='*) key="${tagpart%%=*}"; value="${tagpart#*=}"; kv="$key=$value"; tagfilter="[\"$(esc_ql "$key")\"=\"$(esc_ql "$value")\"]" ;;
        *)     key="$tagpart"; kv="$key"; tagfilter="[\"$(esc_ql "$key")\"]" ;;   # key-only: any value
      esac
      case "$region" in
        around:*) regionfilter="(around:${region#around:})" ;;   # radius,lat,lng — already validated numeric
        *)        regionfilter="($region)" ;;                     # bbox S,W,N,E — already validated numeric
      esac
      ql="[out:json][timeout:25];(node${tagfilter}${regionfilter}${newer};way${tagfilter}${regionfilter}${newer};relation${tagfilter}${regionfilter}${newer};);out center meta ${qlimit};"
    elif [[ "$query" == *'[out:'* || "$query" == *';'* ]]; then
      # RAW OverpassQL: a settings block or statement terminator, and NOT a friendly
      # region. The author owns `[out:json]` + a bounded `out`; a non-JSON body errors.
      ql="$query"
    else
      echo "overpass: '$query' is neither raw OverpassQL nor key=value@region" >&2
      exit 1
    fi

    # POST the QL as form field `data=` (Overpass's documented interface).
    if ! run="$(curl -fsS -m 90 -H "User-Agent: $UA" --data-urlencode "data=$ql" "$API")"; then
      echo "overpass enumerate request failed for '$query'" >&2; exit 1
    fi
    # A valid response is a JSON object with an `elements` array; zero matches come
    # back as {"elements":[]} → maps to []. A non-JSON body (e.g. an HTML 429/400 or
    # raw QL that forgot [out:json]) is a failure, not a fake-clean empty scan.
    if ! printf '%s' "$run" | jq -e 'type == "object" and has("elements")' >/dev/null 2>&1; then
      echo "overpass enumerate: unexpected response (need [out:json]?): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    printf '%s' "$run" | jq -c --arg kv "$kv" --argjson n "$limit" '
      [ (.elements // [])[]
        # gps from a node lat/lon, or a way/relation `out center` centroid; an
        # element with neither (rare) is dropped so every hit carries a plottable point.
        | (if (.lat != null and .lon != null) then { lat: .lat, lng: .lon }
           elif (.center.lat != null and .center.lon != null) then { lat: .center.lat, lng: .center.lon }
           else null end) as $gps
        | select($gps != null)
        | (.tags // {}) as $t
        | ("https://www.openstreetmap.org/" + (.type // "node") + "/" + (.id|tostring)) as $osm
        | {
            title: ($t.name // (if $kv != "" then ($kv + " #" + (.id|tostring)) else ((.type // "node") + " #" + (.id|tostring)) end)),
            url: $osm,
            source: "overpass",
            published: ($t.start_date // null),
            # map ranks/--since-filters by payload.created — anchor to the OSM
            # element last-edit time (meta), so an old feature scanned today does
            # not rank as new. Same convention as exif/firms/flights/chronolocate.
            created: (.timestamp // $t.start_date // null),
            snippet: (($t | to_entries | map(.key + "=" + (.value|tostring)))[0:6] | join(" · ")),
            osm_type: (.type // null),
            osm_id: (.id // null),
            gps: $gps,
            tags: $t,
            media: { ref: $osm }
          }
      ]
      # newest-edited first (payload.created = OSM last-edit meta), THEN cap — so a
      # capped scan keeps the most recent features, not the lowest-id ones. Undated
      # elements (no timestamp/start_date) sort last. Same shape as firms.
      | sort_by(.created // "") | reverse | .[0:$n]'
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "overpass fetch needs --url" >&2; exit 1; }
    # a hit's ref is an openstreetmap.org element page — curl it as evidence and
    # report the kind by content type (overcast sniffs a missing extension).
    if ! ct="$(oc_guarded_fetch "$url" "$out" -m 60 -H "User-Agent: $UA")" || [ ! -s "$out" ]; then
      echo "overpass fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*)          kind="image" ;;
      video/*)          kind="video" ;;
      text/html*|"")    kind="page" ;;
      *)                kind="file" ;;
    esac
    jq -nc --arg p "$out" --arg k "$kind" --arg u "$url" '{kind:$k,path:$p,source:"overpass",url:$u}'
    ;;

  *) echo "overpass source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
