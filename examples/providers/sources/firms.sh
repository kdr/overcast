#!/usr/bin/env bash
# overcast source provider: firms (NASA FIRMS active-fire / thermal-anomaly
# hotspots — satellite-detected fires as geolocated case records that plot on
# `overcast map`). FREE map key (no cost): https://firms.modaps.eosdis.nasa.gov/api/
#
# Bind with:  overcast source add 'firms:-124.5,32.5,-114.0,42.0'   # bbox: W,S,E,N
#             overcast source add 'firms:country:USA'                # ISO3 country
#             overcast source add 'firms:2.0,48.5,2.6,49.0@MODIS_NRT' # pick a sensor
#             overcast scan    --source firms --since 3d --limit 200
#             overcast map     --no-open
#             overcast monitor --source firms --every 6h
# Refs / queries (enumerate --query):
#   <west,south,east,north>   — an area (bbox) CSV query
#   country:<ISO3>            — a whole country (ISO3 code, e.g. USA / FRA / AUS)
#   append @<SENSOR>          — override the default source (VIIRS_SNPP_NRT)
# Each detection row becomes one hit carrying top-level gps:{lat,lng} + an ISO
# `published` (acq_date+acq_time, UTC) so the scan record plots on `map`;
# media.ref is a FIRMS fire-map deep link centered on the point.
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
API="https://firms.modaps.eosdis.nasa.gov/api"
KEY="${FIRMS_MAP_KEY:-}"
DEFAULT_SOURCE="VIIRS_SNPP_NRT"

need() {
  if [ -z "$KEY" ]; then
    echo "firms source needs a key: set FIRMS_MAP_KEY (free at https://firms.modaps.eosdis.nasa.gov/api/)" >&2
    exit 13
  fi
}

# CSV → hits mapper. Reads a FIRMS CSV on stdin, writes a JSON array on stdout.
# Factored out (columns resolved BY HEADER NAME, not fixed position) so it survives
# the sensor/endpoint differences (area vs country CSVs, VIIRS `bright_ti4` vs MODIS
# `brightness`) AND so the parse can be exercised with a fixture CSV and no live key.
# Args: $1 = sensor label (for the snippet). Env: none.
firms_csv_to_hits() { # <sensor-label>
  local sensor="${1:-}"
  # awk resolves the needed columns from the header row, then emits one tab-separated
  # record per data row in a FIXED field order — jq (below) does the typing + JSON
  # escaping, which awk does poorly. FIRMS CSV values are plain (no embedded commas),
  # so a comma split is safe.
  awk -F, '
    NR==1 {
      for (i=1;i<=NF;i++) { c=$i; gsub(/\r/,"",c); h[c]=i }
      next
    }
    {
      lat = (h["latitude"]  ? $(h["latitude"])  : "")
      lon = (h["longitude"] ? $(h["longitude"]) : "")
      if (lat=="" || lon=="") next
      ad   = (h["acq_date"]   ? $(h["acq_date"])   : "")
      at   = (h["acq_time"]   ? $(h["acq_time"])   : "")
      conf = (h["confidence"] ? $(h["confidence"]) : "")
      frp  = (h["frp"]        ? $(h["frp"])        : "")
      dn   = (h["daynight"]   ? $(h["daynight"])   : "")
      br   = (h["bright_ti4"] ? $(h["bright_ti4"]) : (h["brightness"] ? $(h["brightness"]) : ""))
      gsub(/\r/,"",dn); gsub(/\r/,"",br); gsub(/\r/,"",frp)
      print lat "\t" lon "\t" ad "\t" at "\t" conf "\t" frp "\t" dn "\t" br
    }' | jq -R -s --arg sensor "$sensor" '
      split("\n") | map(select(length > 0)) | map(
        (split("\t")) as $f
        | ($f[0] | tonumber?) as $lat
        | ($f[1] | tonumber?) as $lng
        | select($lat != null and $lng != null)
        | $f[2] as $date
        | ("0000" + ($f[3] // "")) as $padded
        | ($padded[($padded|length-4):]) as $hm         # zero-pad HHMM (FIRMS drops leading zeros)
        | ($f[4] // "") as $conf
        | ($f[5] // "") as $frpRaw
        | ($f[6] // "") as $dn
        | ($f[7] // "") as $bright
        | ($frpRaw | tonumber?) as $frp
        | (if ($date | length) == 10 then ($date + "T" + $hm[0:2] + ":" + $hm[2:4] + ":00Z") else null end) as $iso
        | {
            title: ("fire " + (if $conf != "" then $conf + " conf" else "detection" end)
                    + (if $frp != null then ", FRP " + ($frp|tostring) else "" end)
                    + (if $iso != null then " @ " + $date + " " + $hm[0:2] + ":" + $hm[2:4] else "" end)),
            url: ("https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@" + ($lng|tostring) + "," + ($lat|tostring) + ",10z"),
            source: "firms",
            published: $iso,
            snippet: (([ (if $conf != "" then "confidence " + $conf else empty end),
                         (if $frp != null then "FRP " + ($frp|tostring) else empty end),
                         (if $sensor != "" then $sensor else empty end),
                         (if $dn == "D" then "day" elif $dn == "N" then "night" else empty end) ]) | join(" · ")),
            gps: { lat: $lat, lng: $lng },
            frp: $frp,
            confidence: (if $conf != "" then $conf else null end),
            brightness: (if $bright != "" then ($bright | tonumber?) else null end),
            daynight: (if $dn != "" then $dn else null end),
            sensor: (if $sensor != "" then $sensor else null end),
            media: { ref: ("https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@" + ($lng|tostring) + "," + ($lat|tostring) + ",10z") }
          }
      )'
}

op="${1:-enumerate}"; shift || true

case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"firms","emits":"scan.hit","needs":["FIRMS_MAP_KEY"]}'; exit 0 ;;

  enumerate)
    query=""; limit=200; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    need
    [ -n "$query" ] || { echo "firms enumerate needs an area: bind firms:<W,S,E,N> or firms:country:<ISO3>" >&2; exit 1; }
    case "$limit" in ''|*[!0-9]*) limit=200 ;; esac
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1

    # optional @<SENSOR> suffix picks the FIRMS source (VIIRS_SNPP_NRT default;
    # MODIS_NRT / VIIRS_NOAA20_NRT / LANDSAT_NRT / … are the other layers).
    src="$DEFAULT_SOURCE"
    case "$query" in
      *@*) src="${query##*@}"; query="${query%@*}" ;;
    esac
    [ -n "$src" ] || src="$DEFAULT_SOURCE"

    # --since → FIRMS dayrange (1–10; default 1). Portable epoch math (BSD/GNU date)
    # then ceil to whole days; fail closed on an unparseable window (don't silently
    # widen to a different range than asked).
    dayrange=1
    if [ -n "$since" ]; then
      now="$(date -u +%s)"; cutepoch=""
      case "$since" in
        *[0-9]m) cutepoch=$(( now - ${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - ${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - ${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - ${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d' "$since" +%s 2>/dev/null || echo '')" ;;
        *) echo "firms: could not parse --since '$since' (use Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      [ -n "$cutepoch" ] || { echo "firms: could not parse --since '$since'" >&2; exit 1; }
      dayrange=$(( (now - cutepoch + 86399) / 86400 ))   # ceil to whole days
      [ "$dayrange" -lt 1 ] && dayrange=1
      [ "$dayrange" -gt 10 ] && dayrange=10
    fi

    # country:<ISO3> hits the country endpoint; anything else is a bbox (W,S,E,N).
    case "$query" in
      country:*)
        iso="${query#country:}"
        [ -n "$iso" ] || { echo "firms: empty country code (expected firms:country:<ISO3>)" >&2; exit 1; }
        isoenc="$(jq -rn --arg v "$iso" '$v|@uri')"
        srcenc="$(jq -rn --arg v "$src" '$v|@uri')"
        endpoint="$API/country/csv/$KEY/$srcenc/$isoenc/$dayrange"
        ;;
      *)
        # bbox: west,south,east,north (Overpass/Leaflet order). Require the 4 parts.
        case "$query" in
          *,*,*,*) : ;;
          *) echo "firms: bbox needs west,south,east,north (got '$query')" >&2; exit 1 ;;
        esac
        bboxenc="$(jq -rn --arg v "$query" '$v|@uri')"
        srcenc="$(jq -rn --arg v "$src" '$v|@uri')"
        endpoint="$API/area/csv/$KEY/$srcenc/$bboxenc/$dayrange"
        ;;
    esac

    if ! resp="$(curl -fsS -m 60 "$endpoint")"; then
      echo "firms enumerate request failed for '$query' (check bbox/ISO3 and key)" >&2; exit 1
    fi
    # A valid response is CSV whose header carries latitude/longitude. FIRMS reports
    # bad keys / bad params as an HTTP-200 TEXT body ("Invalid MAP_KEY…"), which
    # `curl -f` can't catch — so a body whose first line has no `latitude` is an
    # error, not a fake-clean empty scan. A header-only CSV (no fires) → [].
    if ! printf '%s\n' "$resp" | head -1 | grep -qi 'latitude'; then
      echo "firms enumerate: unexpected response: $(printf '%s' "$resp" | head -c 200)" >&2
      exit 1
    fi
    printf '%s' "$resp" | firms_csv_to_hits "$src" | jq -c --argjson n "$limit" '.[0:$n]'
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "firms fetch needs --url" >&2; exit 1; }
    # a hit's ref is a FIRMS fire-map page (an interactive HTML map centered on the
    # detection). curl it as evidence; report the kind by content type.
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"firms",url:$u}'
    else
      echo "firms fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;

  *) echo "firms source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
