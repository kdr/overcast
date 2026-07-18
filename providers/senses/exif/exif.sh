#!/usr/bin/env bash
# overcast `exif` provider — embedded metadata + GPS via ExifTool (system CLI,
# no API key). Default backend for the `exif` sense. Works on images AND video
# (MOV/MP4 carry capture time, device make/model, and sometimes GPS).
# Contract: init | describe | run --input <media>
# Emits an exif record: { summary, gps:{lat,lng[,altitude]}|null, created, make,
# model, software, serial, lens, mime, dimensions, duration, tags } — a compact,
# searchable summary; the full tag dump stays out of case memory by design.
set -uo pipefail

# Override the exiftool invocation (path or wrapper) for tests / custom installs;
# mirrors OVERCAST_FFMPEG / OVERCAST_TINYCLOUD_CMD. May carry args (e.g.
# "bash /path/fake-exiftool.sh"), so read it into an array.
read -r -a EXIFTOOL_CMD <<< "${OVERCAST_EXIFTOOL_CMD:-exiftool}"

need_exiftool() {
  command -v "${EXIFTOOL_CMD[0]}" >/dev/null 2>&1 || {
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
  describe) echo '{"verb":"exif","kind":"media.metadata","payload":["summary","gps","created","make","model","software","serial","lens"],"needs":["exiftool"]}'; exit 0 ;;
esac

input=""; input_set=0
while [ "$#" -gt 0 ]; do case "$1" in
  --input) input="${2:-}"; input_set=1; shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) [ "$input_set" = 1 ] || input="$1"; shift ;;
esac; done
need_exiftool
[ -f "$input" ] || { jq -nc --arg i "$input" '{verb:"exif",format:"json",payload:{error:("file not found: "+$i)},error:"file not found",state:"error"}'; exit 0; }
# A relative path beginning with '-' would be parsed by exiftool as an option
# (e.g. -tagsFromFile / -w); prefix ./ so it stays a positional file operand.
case "$input" in -*) input="./$input" ;; esac

# -n = numeric values (signed decimal GPS via the Composite group), -json = one
# object per file. Capture exiftool's exit status so a genuine failure (corrupt/
# unreadable file) surfaces as an ERROR record rather than a ready "no metadata"
# result. A valid file with no interesting tags still exits 0 with a minimal object.
errf="$(mktemp)"
raw="$("${EXIFTOOL_CMD[@]}" -n -json "$input" 2>"$errf")"; code=$?
err="$(cat "$errf")"; rm -f "$errf"
if [ "$code" -ne 0 ]; then
  jq -nc --arg ref "$input" --arg e "$err" '{verb:"exif",format:"json",payload:{},media:{ref:$ref},error:("exiftool failed: "+($e|.[0:300])),state:"error"}'
  exit 0
fi
obj="$(printf '%s' "$raw" | jq -c '.[0] // {}')"
[ -n "$obj" ] || obj='{}'
# exiftool can exit 0 yet report a hard Error tag on a malformed file — surface
# that as an error too (a non-fatal Warning, e.g. a partial read, stays ready).
etErr="$(printf '%s' "$obj" | jq -r '.Error // empty')"
if [ -n "$etErr" ]; then
  jq -nc --arg ref "$input" --arg e "$etErr" '{verb:"exif",format:"json",payload:{},media:{ref:$ref},error:("exiftool: "+$e),state:"error"}'
  exit 0
fi

get() { printf '%s' "$obj" | jq -r --arg k "$1" '.[$k] // empty' 2>/dev/null; }
lat="$(get GPSLatitude)"; lng="$(get GPSLongitude)"; alt="$(get GPSAltitude)"
make="$(get Make)"; model="$(get Model)"; soft="$(get Software)"
serial="$(get SerialNumber)"; [ -n "$serial" ] || serial="$(get InternalSerialNumber)"; [ -n "$serial" ] || serial="$(get BodySerialNumber)"
lens="$(get LensModel)"; [ -n "$lens" ] || lens="$(get LensID)"; [ -n "$lens" ] || lens="$(get LensType)"
created="$(get DateTimeOriginal)"; [ -n "$created" ] || created="$(get CreateDate)"
[ -n "$created" ] || created="$(get MediaCreateDate)"
w="$(get ImageWidth)"; h="$(get ImageHeight)"
mime="$(get MIMEType)"; dur="$(get Duration)"
count="$(printf '%s' "$obj" | jq 'keys | length' 2>/dev/null)"; [ -n "$count" ] || count=0

# Classify the ExifTool lat/lng (obj carries them as numbers under -n), matching
# geo.ts gpsIssue: valid | range (both numeric, one outside WGS84) | malformed
# (missing axis / non-numeric) | absent. map + `exif --geocode` drop anything but
# `valid`, so suppress those here too — a stored payload.gps must be the same one
# the map would plot, and `ask`/memory must not cite a coordinate that never geolocates.
gps_state="$(printf '%s' "$obj" | jq -r '
  .GPSLatitude as $la | .GPSLongitude as $lo
  | if ($la == null and $lo == null) then "absent"
    elif (($la|type)=="number" and ($lo|type)=="number")
      then (if ($la>=-90 and $la<=90 and $lo>=-180 and $lo<=180) then "valid" else "range" end)
    else "malformed" end' 2>/dev/null)"
[ -n "$gps_state" ] || gps_state="absent"
gps_valid=0; [ "$gps_state" = "valid" ] && gps_valid=1

# human, searchable one-liner (indexed into case memory)
summary=""
add() { [ -n "$1" ] || return 0; if [ -n "$summary" ]; then summary="$summary · $1"; else summary="$1"; fi; }
case "$gps_state" in
  valid)     add "GPS ${lat},${lng}" ;;
  range)     add "GPS invalid (out of range)" ;;
  malformed) add "GPS malformed or incomplete" ;;
  *)         add "no GPS" ;;
esac
dev="$(printf '%s %s' "$make" "$model" | xargs 2>/dev/null || true)"
add "$dev"
add "$created"
[ -n "$soft" ] && add "sw:$soft"
[ -n "$lens" ] && add "lens:$lens"

jq -nc \
  --arg ref "$input" \
  --arg summary "$summary" \
  --arg lat "$lat" --arg lng "$lng" --arg alt "$alt" \
  --arg created "$created" --arg make "$make" --arg model "$model" \
  --arg software "$soft" --arg serial "$serial" --arg lens "$lens" --arg mime "$mime" \
  --arg w "$w" --arg h "$h" --arg dur "$dur" \
  --argjson count "${count:-0}" \
  --argjson gps_valid "${gps_valid:-0}" \
  '{
     verb:"exif", format:"json",
     payload:{
       summary: $summary,
       gps: (if $gps_valid == 1
             then ({lat:($lat|tonumber), lng:($lng|tonumber)}
                   + (if ($alt|length)>0 then {altitude:($alt|tonumber)} else {} end))
             else null end),
       created: (if ($created|length)>0 then $created else null end),
       make: (if ($make|length)>0 then $make else null end),
       model: (if ($model|length)>0 then $model else null end),
       software: (if ($software|length)>0 then $software else null end),
       serial: (if ($serial|length)>0 then $serial else null end),
       lens: (if ($lens|length)>0 then $lens else null end),
       mime: (if ($mime|length)>0 then $mime else null end),
       dimensions: (if ($w|length)>0 and ($h|length)>0 then ($w+"x"+$h) else null end),
       duration: (if ($dur|length)>0 then ($dur|tonumber) else null end),
       tags: $count
     },
     media:{ref:$ref},
     meta:{provider:"exiftool"},
     state:"ready"
   }'
