#!/usr/bin/env bash
# overcast `geolocate` provider — content-based image geolocation via the
# Picarta AI API (predicts GPS from image CONTENT alone — architecture, signage,
# vegetation — even with EXIF stripped). Complements `exif` (which reads embedded
# GPS when present). Key: PICARTA_API_KEY (https://picarta.ai/, free credits to
# start). Default backend for the `geolocate` sense.
# Contract: init | describe | run --input <image>
# Emits a geo.estimate record: { summary, lat, lng, city, country, province,
# confidence, candidates[] } (top-K predictions).
set -uo pipefail
API="${OVERCAST_PICARTA_URL:-https://picarta.ai/classify}"

need_key() {
  [ -n "${PICARTA_API_KEY:-}" ] || {
    echo "geolocate needs PICARTA_API_KEY (get one at https://picarta.ai/ — free credits to start)" >&2
    exit 13
  }
}

op="${1:-run}"
case "$op" in
  init)     need_key; exit 0 ;;
  describe) echo '{"verb":"geolocate","kind":"geo.estimate","payload":["summary","lat","lng","city","country","confidence"],"needs":["PICARTA_API_KEY"]}'; exit 0 ;;
esac

input=""; input_set=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; input_set=1; shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) [ "$input_set" = 1 ] || input="$1"; shift ;;
esac; done
need_key
[ -f "$input" ] || { jq -nc --arg i "$input" '{verb:"geolocate",format:"json",payload:{error:("image not found: "+$i)},error:"image not found",state:"error"}'; exit 0; }

# Picarta accepts a base64 image (or a URL) in the IMAGE field. Base64 the local
# file (portable: read from stdin so both BSD and GNU base64 work).
b64="$(base64 < "$input" 2>/dev/null | tr -d '\n')"
[ -n "$b64" ] || { jq -nc --arg i "$input" '{verb:"geolocate",format:"json",payload:{error:("could not read image: "+$i)},error:"read failed",state:"error"}'; exit 0; }

req="$(jq -nc --arg t "$PICARTA_API_KEY" --arg img "$b64" '{TOKEN:$t, IMAGE:$img, TOP_K:5}')"
if ! resp="$(curl -fsS -m 120 -X POST "$API" -H 'content-type: application/json' -d "$req")"; then
  echo "geolocate: Picarta request failed" >&2
  jq -nc --arg ref "$input" '{verb:"geolocate",format:"json",payload:{},media:{ref:$ref},error:"Picarta request failed",state:"error"}'
  exit 0
fi
if ! printf '%s' "$resp" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "geolocate: unexpected Picarta response: $(printf '%s' "$resp" | head -c 200)" >&2
  jq -nc --arg ref "$input" --arg e "$(printf '%s' "$resp" | head -c 200)" '{verb:"geolocate",format:"json",payload:{},media:{ref:$ref},error:("unexpected Picarta response: "+$e),state:"error"}'
  exit 0
fi
# a 200 body can still be an API error (invalid token, quota, bad image) — surface
# it as an error record instead of storing failed geolocation as ready evidence.
apierr="$(printf '%s' "$resp" | jq -r '(.error // .detail // .message // .Error // empty) | if type=="object" or type=="array" then tojson else tostring end' 2>/dev/null)"
if [ -n "$apierr" ]; then
  echo "geolocate: Picarta API error: $apierr" >&2
  jq -nc --arg ref "$input" --arg e "$apierr" '{verb:"geolocate",format:"json",payload:{},media:{ref:$ref},error:("Picarta API error: "+($e|.[0:300])),state:"error"}'
  exit 0
fi

# map defensively — Picarta field names vary; prefer ai_* then generic fallbacks.
printf '%s' "$resp" | jq -c --arg ref "$input" '
  (.ai_lat // .latitude // null) as $lat
  | (.ai_lon // .longitude // null) as $lng
  | (.city // .ai_city // null) as $city
  | (.ai_country // .country // null) as $country
  | (.province // .ai_province // .admin1 // null) as $prov
  | ([ (.topk_predictions_dict // {}) | to_entries[]
       | { rank: .key,
           gps: (.value.gps // null),
           address: (.value.address // .value.city // null),
           confidence: (.value.confidence // .value.probability // null) } ]) as $topk
  | ($topk[0].confidence // .ai_confidence // null) as $conf
  | {
      verb:"geolocate", format:"json",
      payload:{
        summary: (if ($lat == null and $lng == null)
                  then "geolocation · no confident location predicted"
                  else ("geolocation"
                        + (if $city != null then " · " + ($city|tostring) else "" end)
                        + (if $country != null then ", " + ($country|tostring) else "" end)
                        + " (" + ($lat|tostring) + "," + ($lng|tostring) + ")"
                        + (if $conf != null then " · conf " + ($conf|tostring) else "" end)) end),
        lat: $lat, lng: $lng, city: $city, country: $country, province: $prov,
        confidence: $conf, candidates: $topk
      },
      media:{ref:$ref}, meta:{provider:"picarta"}, state:"ready"
    }'
