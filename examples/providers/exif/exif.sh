#!/usr/bin/env bash
# overcast `exif` provider — embedded metadata + GPS via ExifTool (system CLI,
# no API key). Default backend for the `exif` sense. Works on images AND video
# (MOV/MP4 carry capture time, device make/model, and sometimes GPS).
# Contract: init | describe | run --input <media>
# Emits an exif record: { summary, gps:{lat,lng[,altitude]}|null, created, make,
# model, software, mime, dimensions, duration, tags } — a compact, searchable
# summary; the full tag dump stays out of case memory by design.
set -uo pipefail

need_exiftool() {
  command -v exiftool >/dev/null 2>&1 || {
    cat >&2 <<'MSG'
exif needs `exiftool` (not found on PATH). Install one of:
  • brew install exiftool
  • apt-get install libimage-exiftool-perl
  • https://exiftool.org/
MSG
    exit 13
  }
}

op="${1:-run}"
case "$op" in
  init)     need_exiftool; exit 0 ;;
  describe) echo '{"verb":"exif","kind":"media.metadata","payload":["summary","gps","created","make","model","software"],"needs":["exiftool"]}'; exit 0 ;;
esac

input=""; input_set=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; input_set=1; shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) [ "$input_set" = 1 ] || input="$1"; shift ;;
esac; done
need_exiftool
[ -f "$input" ] || { jq -nc --arg i "$input" '{verb:"exif",format:"json",payload:{error:("file not found: "+$i)},error:"file not found",state:"error"}'; exit 0; }

# -n = numeric values (signed decimal GPS via the Composite group), -json = one
# object per file. Take the first (only) element; {} if exiftool returns nothing.
obj="$(exiftool -n -json "$input" 2>/dev/null | jq -c '.[0] // {}')"
[ -n "$obj" ] || obj='{}'

get() { printf '%s' "$obj" | jq -r --arg k "$1" '.[$k] // empty' 2>/dev/null; }
lat="$(get GPSLatitude)"; lng="$(get GPSLongitude)"; alt="$(get GPSAltitude)"
make="$(get Make)"; model="$(get Model)"; soft="$(get Software)"
created="$(get DateTimeOriginal)"; [ -n "$created" ] || created="$(get CreateDate)"
[ -n "$created" ] || created="$(get MediaCreateDate)"
w="$(get ImageWidth)"; h="$(get ImageHeight)"
mime="$(get MIMEType)"; dur="$(get Duration)"
count="$(printf '%s' "$obj" | jq 'keys | length' 2>/dev/null)"; [ -n "$count" ] || count=0

# human, searchable one-liner (indexed into case memory)
summary=""
add() { [ -n "$1" ] || return 0; if [ -n "$summary" ]; then summary="$summary · $1"; else summary="$1"; fi; }
if [ -n "$lat" ] && [ -n "$lng" ]; then add "GPS ${lat},${lng}"; else add "no GPS"; fi
dev="$(printf '%s %s' "$make" "$model" | xargs 2>/dev/null || true)"
add "$dev"
add "$created"
[ -n "$soft" ] && add "sw:$soft"

jq -nc \
  --arg ref "$input" \
  --arg summary "$summary" \
  --arg lat "$lat" --arg lng "$lng" --arg alt "$alt" \
  --arg created "$created" --arg make "$make" --arg model "$model" \
  --arg software "$soft" --arg mime "$mime" \
  --arg w "$w" --arg h "$h" --arg dur "$dur" \
  --argjson count "${count:-0}" \
  '{
     verb:"exif", format:"json",
     payload:{
       summary: $summary,
       gps: (if ($lat|length)>0 and ($lng|length)>0
             then ({lat:($lat|tonumber), lng:($lng|tonumber)}
                   + (if ($alt|length)>0 then {altitude:($alt|tonumber)} else {} end))
             else null end),
       created: (if ($created|length)>0 then $created else null end),
       make: (if ($make|length)>0 then $make else null end),
       model: (if ($model|length)>0 then $model else null end),
       software: (if ($software|length)>0 then $software else null end),
       mime: (if ($mime|length)>0 then $mime else null end),
       dimensions: (if ($w|length)>0 and ($h|length)>0 then ($w+"x"+$h) else null end),
       duration: (if ($dur|length)>0 then ($dur|tonumber) else null end),
       tags: $count
     },
     media:{ref:$ref},
     meta:{provider:"exiftool"},
     state:"ready"
   }'
