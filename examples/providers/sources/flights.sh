#!/usr/bin/env bash
# overcast source provider: flights (live ADS-B aircraft positions via the
# OpenSky Network REST API). KEYLESS-CAPABLE — anonymous access works (heavily
# rate-limited, coarser resolution); optional OAuth2 client credentials raise the
# limits.
# Bind with:  overcast source add 'flights:2.0,48.5,2.8,49.0'   # a bbox
#             overcast scan    --source flights --limit 20      # live snapshot
#             overcast monitor --source flights --every 5m      # poll → build a track
# Refs / queries (enumerate --query):
#   <west,south,east,north>  a bounding box  → ?lamin&lomin&lamax&lomax
#   <icao24>                 a 24-bit hex id → ?icao24=<hex>
#   <callsign>               anything else   → fetch all states, filter client-side
# Each state vector with a known position becomes a hit carrying top-level
# `payload.gps` (so scan records plot on `map`, and `monitor --every` builds a
# track), the aircraft-profile page as `media.ref`, and the raw state fields.
# --since is ignored (this is a live snapshot); --limit caps hits client-side.
#
# AUTH: if BOTH OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET are set, we exchange
# them at the OpenSky Keycloak token endpoint (client_credentials grant) and call
# the states endpoint with a Bearer token; otherwise we make an anonymous request.
# `init` therefore exits 0 with no creds (anonymous is allowed) and only errors
# when creds ARE set but the token exchange fails.
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
STATES="https://opensky-network.org/api/states/all"
TOKEN_URL="https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"

op="${1:-enumerate}"; shift || true

is_num() { [[ "$1" =~ ^[+-]?[0-9]+(\.[0-9]+)?$ ]]; }

# Print an OAuth2 access token on stdout when client creds are set, empty for the
# anonymous path. Non-zero exit = creds were set but the token exchange failed.
opensky_token() {
  if [ -n "${OPENSKY_CLIENT_ID:-}" ] && [ -n "${OPENSKY_CLIENT_SECRET:-}" ]; then
    local tok
    if ! tok="$(curl -fsS -m 30 -X POST "$TOKEN_URL" \
      --data-urlencode 'grant_type=client_credentials' \
      --data-urlencode "client_id=$OPENSKY_CLIENT_ID" \
      --data-urlencode "client_secret=$OPENSKY_CLIENT_SECRET" \
      | jq -r '.access_token // empty')" || [ -z "$tok" ]; then
      return 1
    fi
    printf '%s' "$tok"
  fi
  # no creds → anonymous (empty token)
}

# Map an OpenSky states response (a JSON object with a `.states` array of
# positional arrays) into scan.hit records. Reads the response on stdin so the
# mapping can be exercised offline with a fixture ($1=limit, $2=callsign filter).
# OpenSky state index schema: 0=icao24 1=callsign 2=origin_country
# 3=time_position 5=longitude 6=latitude 7=baro_altitude 8=on_ground 9=velocity
# 10=true_track 13=geo_altitude.
map_states() {
  jq -c --argjson n "$1" --arg cs "$2" '
    ( .states // [] )
    | map(select(.[5] != null and .[6] != null))
    | ( if $cs != ""
        then map(select(((.[1] // "") | ascii_upcase | gsub("^ +| +$";"")) == ($cs | ascii_upcase | gsub("^ +| +$";""))))
        else . end )
    | .[0:$n]
    | map(
        . as $s
        | ($s[0]) as $icao
        | (($s[1] // "") | gsub("^ +| +$";"")) as $call
        | ($s[2] // "") as $country
        | ($s[3]) as $tpos
        | ($s[5]) as $lng
        | ($s[6]) as $lat
        | ($s[7]) as $baro
        | ($s[8]) as $ground
        | ($s[9]) as $vel
        | ($s[10]) as $track
        | ($s[13]) as $geo
        | ("https://opensky-network.org/aircraft-profile?icao24=" + $icao) as $page
        # tag the state time onto a URL fragment so each position of the SAME
        # aircraft is a distinct monitor identity (hitKey keys on payload.url);
        # the fragment is inert to fetch (curl drops it), like the shodan port frag.
        | ($page + (if $tpos != null then ("#t" + ($tpos | floor | tostring)) else "" end)) as $url
        | {
            title: ((if $call == "" then "?" else $call end) + " (" + $icao + ") " + $country),
            url: $url,
            source: "flights",
            published: (if $tpos != null then (($tpos | floor) | todate) else null end),
            snippet: (
              "alt " + (if $baro != null then ($baro | tostring) + "m" else "?" end)
              + " · vel " + (if $vel != null then ($vel | tostring) + "m/s" else "?" end)
              + " · hdg " + (if $track != null then ($track | tostring) + "°" else "?" end)
              + " · " + (if $ground == true then "on ground" else "airborne" end)
            ),
            gps: { lat: $lat, lng: $lng },
            icao24: $icao,
            callsign: (if $call == "" then null else $call end),
            origin_country: (if $country == "" then null else $country end),
            velocity: $vel,
            baro_altitude: $baro,
            geo_altitude: $geo,
            on_ground: $ground,
            true_track: $track,
            media: { ref: $url }
          }
      )'
}

case "$op" in
  init)
    # anonymous is allowed → no creds is not an error; only fail when creds are
    # set but the token exchange fails.
    if [ -n "${OPENSKY_CLIENT_ID:-}" ] && [ -n "${OPENSKY_CLIENT_SECRET:-}" ]; then
      if ! opensky_token >/dev/null; then
        echo "flights: OPENSKY_CLIENT_ID/SECRET set but the OAuth2 token exchange failed" >&2
        exit 1
      fi
    fi
    exit 0 ;;
  describe)
    echo '{"source":"flights","emits":"scan.hit","needs":["OPENSKY_CLIENT_ID","OPENSKY_CLIENT_SECRET (optional — anonymous works, rate-limited)"]}'; exit 0 ;;

  enumerate)
    query=""; limit=50; callsign=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) shift 2 2>/dev/null || shift ;;   # live snapshot — no recency filter
      *) shift ;;
    esac; done
    if [ -z "$query" ]; then
      echo "flights enumerate needs a query: bind flights:<bbox|icao24|callsign> or pass --query" >&2
      exit 1
    fi
    case "$limit" in ''|*[!0-9]*) limit=50 ;; esac
    [ "$limit" -gt 500 ] 2>/dev/null && limit=500
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1

    # Resolve the query shape → the states-endpoint URL. A bbox is exactly four
    # comma-separated numbers (west,south,east,north); a bare 6-hex token is an
    # icao24; anything else is treated as a callsign (fetch all states, then
    # filter client-side — an all-states pull is large and, anonymously, the
    # first thing OpenSky rate-limits, so a bbox is strongly preferred).
    url="$STATES"
    IFS=',' read -r bw bs be bn bx <<<"$query"
    if [ -z "${bx:-}" ] && is_num "$bw" && is_num "$bs" && is_num "$be" && is_num "$bn"; then
      url="$STATES?lamin=$bs&lomin=$bw&lamax=$bn&lomax=$be"
    elif [[ "$query" =~ ^[0-9a-fA-F]{6}$ ]]; then
      url="$STATES?icao24=$(printf '%s' "$query" | tr 'A-F' 'a-f')"
    else
      callsign="$query"
    fi

    if ! token="$(opensky_token)"; then
      echo "flights: OPENSKY_CLIENT_ID/SECRET set but the OAuth2 token exchange failed" >&2; exit 1
    fi
    # -f so a rate-limit (HTTP 429) or API error is a non-zero exit (→ error hit),
    # never a fake-clean []. Anonymous access is commonly 429'd — that surfaces as
    # a request failure, which is the intended behavior.
    if [ -n "$token" ]; then
      run="$(curl -fsS -m 60 -H "Authorization: Bearer $token" "$url")" || {
        echo "flights enumerate request failed for '$query'" >&2; exit 1; }
    else
      run="$(curl -fsS -m 60 "$url")" || {
        echo "flights enumerate request failed for '$query' (anonymous OpenSky access is rate-limited — HTTP 429 is expected under load)" >&2; exit 1; }
    fi
    # a valid response is a JSON object ({time, states}); zero aircraft come back
    # as states:null → []. A non-JSON / non-object body is a failure.
    if ! printf '%s' "$run" | jq -e 'type == "object"' >/dev/null 2>&1; then
      echo "flights enumerate: unexpected response: $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    printf '%s' "$run" | map_states "$limit" "$callsign"
    ;;

  _map)
    # internal (offline test): read a states response on stdin → hits.
    limit=50; callsign=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --limit) limit="${2:-50}"; shift 2 2>/dev/null || shift ;;
      --callsign) callsign="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    case "$limit" in ''|*[!0-9]*) limit=50 ;; esac
    map_states "$limit" "$callsign"
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "flights fetch needs --url" >&2; exit 1; }
    # a hit's ref is the aircraft-profile page — download it and report the kind
    # by content type (overcast sniffs a missing extension).
    if ! ct="$(curl -fsSL -m 120 -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
      echo "flights fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*)       kind="image" ;;
      video/*)       kind="video" ;;
      text/html*|"") kind="page" ;;
      *)             kind="file" ;;
    esac
    jq -nc --arg p "$out" --arg k "$kind" --arg u "$url" '{kind:$k,path:$p,source:"flights",url:$u}'
    ;;

  *) echo "flights source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
