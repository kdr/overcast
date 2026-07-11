#!/usr/bin/env bash
# overcast source provider: dispatch (police CAD / calls-for-service feeds on the
# Socrata SODA API — real-time dispatched 911 calls as geolocated case records
# that plot on `overcast map`). Keyless; an optional SOCRATA_APP_TOKEN header
# raises rate limits.
#
# Bind with:  overcast source add dispatch:sf
#             overcast scan    --source dispatch --since 12h --limit 50
#             overcast monitor --source dispatch --every 15m
# Refs / queries (enumerate --query):
#   sf                                — San Francisco real-time law-enforcement
#                                       dispatched calls (data.sfgov.org/gnap-fj3t;
#                                       ~10-min lag, rolling ~48h window)
#   seattle                           — Seattle real-time 911 fire/EMS dispatch
#                                       (data.seattle.gov/kzjm-xkqj)
#   <domain>/<dataset>[@<datefield>]  — any Socrata calls-for-service dataset,
#                                       e.g. dispatch:data.sfgov.org/gnap-fj3t;
#                                       @<datefield> pins the date column, else
#                                       the system :updated_at orders/filters.
# Each row becomes one hit; the gps/title/snippet columns are AUTO-DETECTED per
# row (presets pin the date column), so hits carry top-level gps:{lat,lng} and
# scan records plot on `map`. media.ref/url is a stable per-row SODA deep link
# (https://<domain>/resource/<dataset>.json?<idfield>=<value>) — the monitor
# seen-set dedup key. A sensitive call may carry no location; it is still a hit,
# just without gps. Strong `monitor --every` fit (the feeds are rolling windows).
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail

op="${1:-enumerate}"; shift || true

# optional app token header — sent only when SOCRATA_APP_TOKEN is set (the
# ${arr[@]+...} expansion keeps `set -u` happy on an empty array, bash 3.2 safe).
hdr=()
[ -n "${SOCRATA_APP_TOKEN:-}" ] && hdr=(-H "X-App-Token: $SOCRATA_APP_TOKEN")

case "$op" in
  init)     exit 0 ;;  # no credentials to check (public Socrata SODA API)
  describe) echo '{"source":"dispatch","emits":"scan.hit","needs":[]}'; exit 0 ;;

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
      echo "dispatch enumerate needs a query: bind dispatch:sf|seattle|<domain>/<dataset>[@<datefield>] or pass --query" >&2
      exit 1
    fi
    # sane bounds; SODA accepts up to 50k per page but a CAD feed is dense.
    case "$limit" in ''|*[!0-9]*) limit=50 ;; esac
    [ "$limit" -gt 1000 ] 2>/dev/null && limit=1000
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1

    # resolve the ref → domain + dataset + date column. Presets pin all three;
    # the generic <domain>/<dataset> form defaults the date column to the SODA
    # system field :updated_at (works in $where AND $order on any dataset),
    # overridable with an @<datefield> suffix.
    domain=""; ds=""; datefield=""
    case "$query" in
      sf)      domain="data.sfgov.org";   ds="gnap-fj3t"; datefield="received_datetime" ;;
      seattle) domain="data.seattle.gov"; ds="kzjm-xkqj"; datefield="datetime" ;;
      */*)
        rest="$query"; datefield=":updated_at"
        case "$rest" in *@*) datefield="${rest##*@}"; rest="${rest%@*}" ;; esac
        domain="${rest%%/*}"; ds="${rest#*/}"
        ;;
      *)
        echo "dispatch: unknown ref '$query' (use sf, seattle, or <domain>/<dataset>[@<datefield>])" >&2
        exit 1 ;;
    esac
    # validate the pieces so a hostile ref can't smuggle URL syntax or SoQL into
    # the request (domain = hostname chars, dataset = a Socrata 4x4-style id,
    # datefield = an identifier or a :system field).
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]]   || { echo "dispatch: invalid domain '$domain'" >&2; exit 1; }
    [[ "$ds" =~ ^[A-Za-z0-9_-]+$ ]]       || { echo "dispatch: invalid dataset '$ds'" >&2; exit 1; }
    [[ "$datefield" =~ ^:?[A-Za-z0-9_]+$ ]] || { echo "dispatch: invalid date field '$datefield'" >&2; exit 1; }

    # honor --since → $where=<datefield> > '<cutoff>'. Portable epoch→stamp: BSD
    # date uses `-r <epoch>`, GNU date uses `-d @<epoch>` (mirrors overpass.sh).
    # Socrata datetimes are FLOATING (no Z, typically the feed's LOCAL clock), so
    # the cutoff is formatted floating too — computed in UTC, so against a
    # local-clock feed the effective window is skewed by that feed's UTC offset
    # (a few hours for the US presets). Acceptable for a recency filter; prefer
    # a window comfortably larger than the skew (e.g. --since 1d, not 1h).
    whereparam=""
    if [ -n "$since" ]; then
      now="$(date -u +%s)"; cutepoch=""
      case "$since" in
        *[0-9]s) cutepoch=$(( now - 10#${since%s} )) ;;
        *[0-9]m) cutepoch=$(( now - 10#${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - 10#${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - 10#${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - 10#${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d' "$since" +%s 2>/dev/null || echo '')" ;;
        # an unparseable --since is a hard error (fail closed): don't silently drop
        # the recency filter and return the full, unfiltered call log.
        *) echo "dispatch: could not parse --since '$since' (use Ns/Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      [ -n "$cutepoch" ] || { echo "dispatch: could not parse --since '$since'" >&2; exit 1; }
      cutoff="$(date -u -r "$cutepoch" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d "@$cutepoch" +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo '')"
      [ -n "$cutoff" ] || { echo "dispatch: could not format --since '$since' into a timestamp" >&2; exit 1; }
      whereparam="$datefield > '$cutoff'"
    fi

    # GET with --data-urlencode so the SoQL params ($order's space, $where's
    # quotes) encode correctly. Always newest first.
    curlargs=(--get --data-urlencode "\$limit=$limit" --data-urlencode "\$order=$datefield DESC")
    [ -n "$whereparam" ] && curlargs+=(--data-urlencode "\$where=$whereparam")
    if ! run="$(curl -fsS -m 60 ${hdr[@]+"${hdr[@]}"} "${curlargs[@]}" "https://$domain/resource/$ds.json")"; then
      echo "dispatch enumerate request failed for '$query' (bad dataset / rate limit?)" >&2; exit 1
    fi
    # a valid response is a JSON ARRAY of rows; zero matches = [] (clean empty
    # scan). A non-array body (a Socrata error object, HTML) is a failure, not a
    # fake-clean empty scan.
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "dispatch enumerate: unexpected response: $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    printf '%s' "$run" | jq -c --arg domain "$domain" --arg ds "$ds" --arg df "$datefield" '
      # gps auto-detect, per row: numeric latitude/longitude columns (Seattle
      # serves them as STRINGS — tonumber), else the first value that looks like
      # a GeoJSON point ({type:"Point",coordinates:[lng,lat]} — SF
      # intersection_point, Seattle report_location), else the first nested
      # Socrata location object (.latitude/.longitude strings). A row with no
      # detectable point still becomes a hit, just without gps (sensitive calls
      # legitimately carry no location).
      def detect_gps($r):
        (if ($r.latitude? != null and $r.longitude? != null)
         then (try { lat: ($r.latitude|tonumber), lng: ($r.longitude|tonumber) } catch null)
         else null end)
        // (first($r[]? | select(type=="object" and (.coordinates?|type)=="array" and (.coordinates|length) >= 2)
             | (try { lat: (.coordinates[1]|tonumber), lng: (.coordinates[0]|tonumber) } catch empty)) // null)
        // (first($r[]? | select(type=="object" and .latitude? != null and .longitude? != null)
             | (try { lat: (.latitude|tonumber), lng: (.longitude|tonumber) } catch empty)) // null);
      # title = the call type: first present of the common call-type columns.
      def detect_title($r):
        first(($r.call_type_final_desc?, $r.call_type_original_desc?, $r.calldescription?,
               $r.typetext?, $r.type?, $r.call_type?, $r.description?, $r.title?)
              | select(type=="string" and . != "")) // null;
      # row id for the stable dedup deep link: first present of the common
      # unique-id columns (returned as {k: field, v: value}).
      def detect_id($r):
        first(({k:"id", v:$r.id?}, {k:"cad_number", v:$r.cad_number?},
               {k:"incident_number", v:$r.incident_number?}, {k:"nopd_item", v:$r.nopd_item?},
               {k:"objectid", v:$r.objectid?}, {k:"event_number", v:$r.event_number?})
              | select(.v != null and (.v|tostring) != "")) // null;
      # tiny row fingerprint for the no-id-column fallback ref, so monitor dedup
      # still works when a dataset has none of the known id fields.
      def fp: tojson | explode | reduce .[] as $c (0; (. * 31 + $c) % 2147483647);
      to_entries | [ .[]
        | .key as $i | .value as $r
        | detect_gps($r) as $gps
        | detect_id($r) as $idf
        | (if $idf != null
           then "https://\($domain)/resource/\($ds).json?\($idf.k)=\($idf.v|tostring|@uri)"
           else "https://\($domain)/resource/\($ds).json#row-\($r|fp)" end) as $link
        # published/created = the pinned date column, falling back to the common
        # CAD date columns (the generic-form :updated_at system field is not in
        # the row payload). map ranks by payload.created — same convention as
        # overpass/firms.
        | ($r[$df]? // $r.received_datetime? // $r.datetime? // null) as $when
        | {
            title: (detect_title($r) // ($ds + " row #" + ($i|tostring))),
            url: $link,
            source: "dispatch",
            published: $when,
            created: $when,
            # address/priority/agency/disposition-ish context, whichever are present
            snippet: ([$r.address?, $r.intersection_name?, $r.block_address?,
                       $r.priority_final?, $r.priority?, $r.agency?, $r.disposition?,
                       $r.police_district?, $r.analysis_neighborhood?]
                      | map(select(type=="string" and . != "")) | join(" · ")),
            dataset: ($domain + "/" + $ds),
            row_id: (if $idf != null then ($idf.v|tostring) else null end),
            media: { ref: $link }
          }
        + (if $gps != null then { gps: $gps } else {} end)
      ]'
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "dispatch fetch needs --url" >&2; exit 1; }
    # a hit's ref is the per-row SODA deep link (a one-row JSON document) — curl
    # it as evidence and report the kind by content type.
    if ! ct="$(curl -fsSL -m 60 ${hdr[@]+"${hdr[@]}"} -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
      echo "dispatch fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*)                          kind="image" ;;
      video/*)                          kind="video" ;;
      application/json*|text/html*|"")  kind="page" ;;
      *)                                kind="file" ;;
    esac
    jq -nc --arg p "$out" --arg k "$kind" --arg u "$url" '{kind:$k,path:$p,source:"dispatch",url:$u}'
    ;;

  *) echo "dispatch source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
