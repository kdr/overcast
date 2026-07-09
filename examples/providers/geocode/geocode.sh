#!/usr/bin/env bash
# overcast `geocode` provider — OPT-IN reverse geocoding via OSM Nominatim. Turns
# "lat,lng" into a human place string. NO API KEY, but Nominatim's usage policy
# requires a descriptive User-Agent and no more than ~1 request/second; for any
# volume, point OVERCAST_GEOCODE_URL at your own Nominatim/Photon endpoint.
#
# NEVER bound by default: it egresses the subject's coordinates to a third party.
# Bind it explicitly (`setup provider geocode "exec:bash examples/providers/geocode/geocode.sh --input {{input}}"`)
# and opt in per call with `exif --geocode`.
#
# Contract: init | describe | run --input "<lat>,<lng>"
# Emits: { verb:"geocode", format:"json", payload:{ place, lat, lng, address, provider }, state }
set -uo pipefail

UA="${OVERCAST_GEOCODE_UA:-overcast-osint/1.0 (reverse-geocode; set OVERCAST_GEOCODE_UA to identify)}"
URL="${OVERCAST_GEOCODE_URL:-https://nominatim.openstreetmap.org}"

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

input=""; input_set=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; input_set=1; shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) [ "$input_set" = 1 ] || input="$1"; shift ;;
esac; done
need_deps

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

# a valid response with no match still emits place:null and stays `ready`
printf '%s' "$resp" | jq -c --arg lat "$lat" --arg lng "$lng" '
  {
    verb:"geocode", format:"json",
    payload:{
      place: (.display_name // null),
      lat: ($lat|tonumber), lng: ($lng|tonumber),
      address: (.address // null),
      provider: "nominatim"
    },
    meta:{provider:"nominatim"},
    state:"ready"
  }'
