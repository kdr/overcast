#!/usr/bin/env bash
# overcast `geocode` provider — OPT-IN geocoding via OSM Nominatim.
#   reverse (default):     "lat,lng" -> a human place string (used by `exif --geocode`).
#   forward (--query/--forward): a street address -> {lat,lng,place}.
# NO API KEY, but Nominatim's usage policy requires a descriptive User-Agent and no
# more than ~1 request/second; for any volume, point OVERCAST_GEOCODE_URL at your
# own Nominatim/Photon endpoint.
#
# NEVER bound by default: it egresses the subject's coordinates OR address to a
# third party. Bind it explicitly
# (`overcast provider setup apply --verb geocode --choice nominatim --yes`) and opt
# in per call with `exif --geocode` (reverse).
#
# Contract: init | describe | run --input "<lat>,<lng>" | run --query "<address>"
# Emits (reverse): { verb:"geocode", format:"json", payload:{ place, lat, lng, address, provider }, state }
# Emits (forward): { verb:"geocode", format:"json", payload:{ place, lat, lng, query, mode:"forward", address, provider }, state }
set -uo pipefail

UA="${OVERCAST_GEOCODE_UA:-overcast-osint/1.0 (geocode; set OVERCAST_GEOCODE_UA to identify)}"
URL="${OVERCAST_GEOCODE_URL:-https://nominatim.openstreetmap.org}"
# Forward-search path under $URL. Nominatim serves forward geocoding at /search;
# a Photon endpoint uses /api — set OVERCAST_GEOCODE_FORWARD_PATH=api for Photon.
FWD_PATH="${OVERCAST_GEOCODE_FORWARD_PATH:-search}"; FWD_PATH="${FWD_PATH#/}"

need_deps() {
  for bin in curl jq; do
    command -v "$bin" >/dev/null 2>&1 || {
      echo "geocode needs \`$bin\` (not found on PATH)." >&2
      exit 13
    }
  done
}

op="${1:-run}"
case "$op" in
  init)     need_deps; exit 0 ;;
  describe) echo '{"verb":"geocode","kind":"place","payload":["place","lat","lng","address"],"needs":["curl","jq"]}'; exit 0 ;;
esac

input=""; input_set=0; query=""; forward=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; input_set=1; shift 2 2>/dev/null || shift ;;
  --query) query="${2:-}"; forward=1; shift 2 2>/dev/null || shift ;;
  --forward) forward=1; shift ;;
  --*) shift ;;
  *) [ "$input_set" = 1 ] || input="$1"; shift ;;
esac; done
need_deps

# --- forward mode: address -> {lat,lng,place} (Nominatim /search, Photon /api) -
if [ "$forward" = 1 ]; then
  q="$query"; [ -z "$q" ] && q="$input"
  q="$(printf '%s' "$q" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$q" ]; then
    jq -nc '{verb:"geocode",format:"json",payload:{mode:"forward"},error:"forward geocode needs an address (--query \"<address>\")",state:"error"}'
    exit 0
  fi
  ferrf="$(mktemp)"
  fresp="$(curl -fsS -m 20 -A "$UA" --get \
    --data-urlencode "q=$q" --data-urlencode "format=jsonv2" \
    --data-urlencode "limit=1" --data-urlencode "addressdetails=1" \
    "$URL/$FWD_PATH" 2>"$ferrf")"; fcode=$?
  ferr="$(cat "$ferrf")"; rm -f "$ferrf"
  if [ "$fcode" -ne 0 ]; then
    jq -nc --arg q "$q" --arg e "$ferr" \
      '{verb:"geocode",format:"json",payload:{query:$q,mode:"forward"},error:("forward geocode request failed: "+($e|.[0:200])),state:"error"}'
    exit 0
  fi
  # A non-JSON body (rate-limit HTML) or an empty result is a clean "no match",
  # never a crash.
  if ! printf '%s' "$fresp" | jq -e 'type' >/dev/null 2>&1; then
    jq -nc --arg q "$q" '{verb:"geocode",format:"json",payload:{place:null,lat:null,lng:null,query:$q,mode:"forward",note:"no match (geocoder returned no usable result)"},state:"ready"}'
    exit 0
  fi
  # Map both Nominatim (array of {lat,lon,display_name,address}) and GeoJSON
  # FeatureCollection shapes; validate WGS84 before emitting a point. Every field
  # access is null-safe and every `tonumber` is wrapped in try/catch, so a
  # malformed hit ALWAYS falls through to the no-match record — the jq filter can
  # never exit non-zero and leave the provider contract (one JSON record per run)
  # unmet.
  printf '%s' "$fresp" | jq -c --arg q "$q" '
    (if type=="array" then (.[0] // null)
     elif (type=="object" and has("features") and (.features|type=="array") and (.features|length>0)) then .features[0]
     else null end) as $h
    | (if ($h|type)=="object" then $h else {} end) as $o
    | (try ($o.lat|tonumber) catch null) as $latA
    | (try ($o.lon|tonumber) catch null) as $lngA
    | (try ($o.geometry.coordinates[1]|tonumber) catch null) as $latB
    | (try ($o.geometry.coordinates[0]|tonumber) catch null) as $lngB
    | (if ($latA|type)=="number" then $latA elif ($latB|type)=="number" then $latB else null end) as $lat
    | (if ($lngA|type)=="number" then $lngA elif ($lngB|type)=="number" then $lngB else null end) as $lng
    | (if ($o|has("display_name")) then "nominatim" else "photon" end) as $prov
    | (if (($o|has("display_name")) and (($o.display_name|type)=="string")) then $o.display_name
       elif (($o.properties|type)=="object") then
         ([$o.properties.name,$o.properties.street,$o.properties.district,$o.properties.city,$o.properties.county,$o.properties.state,$o.properties.country]
          | map(select(type=="string" and . != "")) | join(", "))
       else null end) as $place
    | (($lat|type)=="number" and ($lng|type)=="number"
        and $lat>=-90 and $lat<=90 and $lng>=-180 and $lng<=180) as $ok
    | if $ok then {
        verb:"geocode", format:"json",
        payload:{ place:$place, lat:$lat, lng:$lng, query:$q, mode:"forward",
                  address:($o.address // $o.properties // null), provider:$prov },
        meta:{ provider:$prov },
        state:"ready" }
      else {
        verb:"geocode", format:"json",
        payload:{ place:null, lat:null, lng:null, query:$q, mode:"forward",
                  note:"no match for this address" },
        state:"ready" }
      end'
  exit 0
fi

case "$input" in
  *,*) lat="${input%%,*}"; lng="${input##*,}" ;;
  *)   jq -nc --arg i "$input" '{verb:"geocode",format:"json",payload:{error:("expected \"lat,lng\", got: "+$i)},error:"bad coordinates",state:"error"}'; exit 0 ;;
esac
lat="$(printf '%s' "$lat" | tr -d ' ')"; lng="$(printf '%s' "$lng" | tr -d ' ')"
if [ -z "$lat" ] || [ -z "$lng" ]; then
  jq -nc --arg i "$input" '{verb:"geocode",format:"json",payload:{error:("expected \"lat,lng\", got: "+$i)},error:"bad coordinates",state:"error"}'
  exit 0
fi

errf="$(mktemp)"
resp="$(curl -fsS -A "$UA" --get \
  --data-urlencode "lat=$lat" --data-urlencode "lon=$lng" \
  --data-urlencode "format=json" --data-urlencode "zoom=14" --data-urlencode "addressdetails=1" \
  "$URL/reverse" 2>"$errf")"; code=$?
err="$(cat "$errf")"; rm -f "$errf"
if [ "$code" -ne 0 ]; then
  jq -nc --arg lat "$lat" --arg lng "$lng" --arg e "$err" \
    '{verb:"geocode",format:"json",payload:{lat:($lat|tonumber),lng:($lng|tonumber)},error:("geocode request failed: "+($e|.[0:200])),state:"error"}'
  exit 0
fi

# Map both Nominatim (.display_name/.address) AND Photon GeoJSON
# (.features[0].properties) response shapes — OVERCAST_GEOCODE_URL may target
# either. A valid response with no match still emits place:null and stays `ready`.
printf '%s' "$resp" | jq -c --arg lat "$lat" --arg lng "$lng" '
  (.features[0].properties // null) as $photon
  | (if $photon
       then ([$photon.name, $photon.street, $photon.district, $photon.city, $photon.county, $photon.state, $photon.country]
             | map(select(. != null and . != "")) | join(", "))
       else "" end) as $photon_name
  | (.display_name // (if $photon_name == "" then null else $photon_name end)) as $place
  | {
      verb:"geocode", format:"json",
      payload:{
        place: $place,
        lat: ($lat|tonumber), lng: ($lng|tonumber),
        address: (.address // $photon),
        provider: (if (.display_name != null) then "nominatim" elif $photon then "photon" else "unknown" end)
      },
      meta:{provider:(if (.display_name != null) then "nominatim" elif $photon then "photon" else "unknown" end)},
      state:"ready"
    }'
