#!/usr/bin/env bash
# overcast source provider: firms (NASA FIRMS active-fire / thermal-anomaly
# hotspots — satellite-detected fires as geolocated case records that plot on
# `overcast map`). FREE map key (no cost): https://firms.modaps.eosdis.nasa.gov/api/
#
# Bind with:  overcast source add 'firms:-124.5,32.5,-114.0,42.0'   # bbox: W,S,E,N
#             overcast source add 'firms:2.0,48.5,2.6,49.0@MODIS_NRT' # pick a sensor
#             overcast scan    --source firms --since 3d --limit 200
#             overcast map     --no-open
#             overcast monitor --source firms --every 6h
# Refs / queries (enumerate --query):
#   <west,south,east,north>   — an area (bbox) CSV query (FIRMS is area-only; there
#                               is no country endpoint — query a country by its bbox)
#   append @<SENSOR>          — override the default source (VIIRS_SNPP_NRT)
# Each detection row becomes one hit carrying top-level gps:{lat,lng} + an ISO
# `published` (acq_date+acq_time, UTC) so the scan record plots on `map`;
# media.ref is a FIRMS fire-map deep link centered on the point.
# Implements: enumerate --query <q> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
# shared outbound-fetch guard (scheme pinning, bounded redirects, private-address
# refusal on the FINAL hop) — see providers/engines/net/guarded-fetch.sh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../engines/net/guarded-fetch.sh
. "$here/../../engines/net/guarded-fetch.sh"

API="https://firms.modaps.eosdis.nasa.gov/api"
KEY="${FIRMS_MAP_KEY:-}"
DEFAULT_SOURCE="VIIRS_SNPP_NRT"

# a numeric coordinate (digits, optional sign + decimal) — validates bbox parts so a
# non-numeric one fails fast with a clear message instead of a downstream API error.
is_coord() { [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; }

need() {
  if [ -z "$KEY" ]; then
    echo "firms source needs a key: set FIRMS_MAP_KEY (free at https://firms.modaps.eosdis.nasa.gov/api/)" >&2
    exit 13
  fi
}

# CSV → hits mapper. Reads a FIRMS CSV on stdin, writes a JSON array on stdout.
# Factored out (columns resolved BY HEADER NAME, not fixed position) so it survives
# the sensor differences (VIIRS `bright_ti4` vs MODIS
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
      # index columns by LOWERCASED header name — the enumerate header check is
      # case-insensitive, so a mixed-case FIRMS header must resolve here too (else
      # every row is skipped and a valid response looks like zero fires).
      for (i=1;i<=NF;i++) { c=tolower($i); gsub(/\r/,"",c); h[c]=i }
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
        # a monitor track needs a UNIQUE identity per detection: hitKey keys on
        # payload.url, so two detections sharing a coordinate+time+sensor must still
        # differ or the later is deduped. Fold capture time + sensor + the intensity
        # fields (frp, brightness) into the map-link fragment (inert to fetch -- curl
        # drops the #...), like shodan #<port> / flights #t;@lat,lng.
        | ("t:" + ($iso // ($date + $hm))
           + (if $sensor != "" then ";s:" + $sensor else "" end)
           + (if $frpRaw != "" then ";f:" + $frpRaw else "" end)
           + (if $bright != "" then ";b:" + $bright else "" end)) as $detkey
        | ("https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@" + ($lng|tostring) + "," + ($lat|tostring) + ",10z;" + $detkey) as $url
        | {
            title: ("fire " + (if $conf != "" then $conf + " conf" else "detection" end)
                    + (if $frp != null then ", FRP " + ($frp|tostring) else "" end)
                    + (if $iso != null then " @ " + $date + " " + $hm[0:2] + ":" + $hm[2:4] else "" end)),
            url: $url,
            source: "firms",
            published: $iso,
            # `map` ranks/filters by payload.created (fire ACQUISITION time here),
            # not the scan ingest time — so a detection sorts by when the fire
            # burned, not when we scanned it. Null date → map falls back to ingest.
            created: $iso,
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
            media: { ref: $url }
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
    # trim surrounding whitespace so a padded bbox ref still parses (a
    # whitespace-only query then trips the empty check) — consistent with the others.
    query="${query#"${query%%[![:space:]]*}"}"; query="${query%"${query##*[![:space:]]}"}"
    [ -n "$query" ] || { echo "firms enumerate needs an area: bind firms:<W,S,E,N> (west,south,east,north)" >&2; exit 1; }
    case "$limit" in ''|*[!0-9]*) limit=200 ;; esac
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1

    # optional @<SENSOR> suffix picks the FIRMS source (VIIRS_SNPP_NRT default;
    # MODIS_NRT / VIIRS_NOAA20_NRT / LANDSAT_NRT / … are the other layers).
    src="$DEFAULT_SOURCE"
    case "$query" in
      *@*) src="${query##*@}"; query="${query%@*}" ;;
    esac
    [ -n "$src" ] || src="$DEFAULT_SOURCE"
    srcenc="$(jq -rn --arg v "$src" '$v|@uri')"

    # --since → FIRMS dayrange (1–10; default 1). Portable epoch math (BSD/GNU date)
    # then ceil to whole days; fail closed on an unparseable window (don't silently
    # widen to a different range than asked). dayrange is COARSE (whole days), so a
    # sub-day window (6h/30m) rounds up to a full day — we then filter each detection
    # client-side by its acquisition time (cutiso) so `--since` is honored exactly,
    # like overpass's `(newer:)` / gdelttv's STARTDATETIME. A detection we can't date
    # is dropped under an active window (can't confirm it falls inside it).
    now="$(date -u +%s)"
    dayrange=1; cutiso=""; cutepoch=""; since_abs=""
    if [ -n "$since" ]; then
      case "$since" in
        *[0-9]s) cutepoch=$(( now - 10#${since%s} )) ;;
        *[0-9]m) cutepoch=$(( now - 10#${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - 10#${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - 10#${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - 10#${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          # an ABSOLUTE floor — must NOT be slid by the data-availability anchor below
          since_abs=1
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$since 00:00:00" +%s 2>/dev/null || echo '')" ;;
        *) echo "firms: could not parse --since '$since' (use Ns/Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      [ -n "$cutepoch" ] || { echo "firms: could not parse --since '$since'" >&2; exit 1; }
      cutiso="$(date -u -r "$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '')"
      [ -n "$cutiso" ] || { echo "firms: could not format --since '$since' into an ISO timestamp" >&2; exit 1; }
      dayrange=$(( (now - cutepoch + 86399) / 86400 ))   # ceil to whole days
      [ "$dayrange" -lt 1 ] && dayrange=1
      # FIRMS caps a single request at 10 days. A wider window can't be served, so
      # WARN (don't silently return a narrower range than asked) and cap the fetch;
      # cutiso still filters the returned rows precisely within the 10-day cap.
      if [ "$dayrange" -gt 10 ]; then
        echo "firms: --since '$since' exceeds the FIRMS 10-day maximum; returning only the most recent 10 days (older detections omitted)" >&2
        dayrange=10
      fi
    fi

    # Anchor the window to FIRMS's most-recent AVAILABLE date. NRT feeds lag the
    # wall clock by ~1–3 days, and the area API's dayrange counts back from TODAY
    # — so `--since 3d` asks for a window that mostly falls in the not-yet-
    # published gap and returns an empty CSV. Query data_availability for the
    # sensor's max_date and, when it trails now, pass it as the explicit end-date
    # (the API's `/<dayrange>/<date>` form) AND shift the client-side cutiso back
    # by the same amount, so `--since Nd` means "the N most recent PUBLISHED days".
    # Best-effort: any failure falls back to the implicit today-anchored query.
    enddate=""
    avail="$(curl -fsS -m 30 "$API/data_availability/csv/$KEY/$srcenc" 2>/dev/null || true)"
    maxdate="$(printf '%s' "$avail" | awk -F, -v s="$src" 'NR>1 && $1==s {gsub(/[[:space:]]/,"",$3); print $3; exit}')"
    case "$maxdate" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
        maxepoch="$(date -u -d "$maxdate 23:59:59" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$maxdate 23:59:59" +%s 2>/dev/null || echo '')"
        if [ -n "$maxepoch" ] && [ "$maxepoch" -lt "$now" ]; then
          enddate="$maxdate"
          # slide the client-side floor back by the same offset ONLY for a RELATIVE
          # window (Nd/Nh/…) — an absolute `--since YYYY-MM-DD` is a fixed floor and
          # must stay put (shifting it would admit detections older than requested).
          if [ -n "$cutepoch" ] && [ -z "$since_abs" ]; then
            cutepoch=$(( cutepoch - (now - maxepoch) ))
            cutiso="$(date -u -r "$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$cutepoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$cutiso")"
          fi
        fi ;;
    esac

    # bbox: west,south,east,north (Overpass/Leaflet order) — strip inner spaces then
    # require FOUR NUMERIC parts, so "-124, 32, -114, 42" is accepted and a
    # malformed/non-numeric ref fails fast (and never reaches the API). FIRMS has no
    # country endpoint (their API is area-only) — query a country by its bbox.
    bbox="${query// /}"
    IFS=, read -r fw fs fe fn fx <<<"$bbox"
    if [ -n "${fx:-}" ] || ! is_coord "$fw" || ! is_coord "$fs" || ! is_coord "$fe" || ! is_coord "$fn"; then
      echo "firms: bbox needs four numbers west,south,east,north (got '$query')" >&2; exit 1
    fi
    # bbox parts are already validated numeric (is_coord above), so the string is
    # URL-safe as-is — embed it RAW. The FIRMS area endpoint wants literal commas in
    # the path segment and returns HTTP 400 when they're %2C-encoded.
    endpoint="$API/area/csv/$KEY/$srcenc/$bbox/$dayrange"
    # explicit end-date (data-availability anchor) → the API's `/<dayrange>/<date>` form
    [ -n "$enddate" ] && endpoint="$endpoint/$enddate"

    if ! resp="$(curl -fsS -m 60 "$endpoint")"; then
      echo "firms enumerate request failed for '$query' (check bbox and key)" >&2; exit 1
    fi
    # A valid response is CSV whose header has `latitude` AND `longitude` as EXACT
    # comma-delimited columns. FIRMS reports bad keys / params as an HTTP-200 TEXT
    # body ("Invalid MAP_KEY…", "Invalid latitude…") that `curl -f` can't catch —
    # matching whole fields (not substrings) rejects prose like "Invalid latitude,
    # longitude out of range" that would otherwise map to a fake empty scan. A
    # header-only CSV (no fires) → [].
    have_lat=0; have_lng=0
    IFS=, read -ra _cols < <(printf '%s' "$resp" | head -1 | tr '[:upper:]' '[:lower:]')
    for _c in "${_cols[@]}"; do
      _c="${_c//[[:space:]]/}"
      [ "$_c" = "latitude" ] && have_lat=1
      [ "$_c" = "longitude" ] && have_lng=1
    done
    if [ "$have_lat" -ne 1 ] || [ "$have_lng" -ne 1 ]; then
      echo "firms enumerate: unexpected response: $(printf '%s' "$resp" | head -c 200)" >&2; exit 1
    fi
    # honor --since EXACTLY: drop detections whose acquisition time predates the
    # window (dayrange only bounds the fetch to whole days), sort NEWEST-first, THEN
    # apply --limit — the FIRMS area CSV is not ordered by time, so slicing raw rows
    # could keep older detections and drop the most recent ones in the window.
    # `.created // ""` sorts undated rows first → reverse puts them last (lowest
    # priority under the cap), so dated detections keep their recency ranking.
    printf '%s' "$resp" | firms_csv_to_hits "$src" \
      | jq -c --argjson n "$limit" --arg cutiso "$cutiso" \
          'map(select($cutiso == "" or (.created != null and .created >= $cutiso)))
           | sort_by(.created // "") | reverse | .[0:$n]'
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
    if oc_guarded_fetch "$url" "$page" -m 60 >/dev/null; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"firms",url:$u}'
    else
      echo "firms fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;

  *) echo "firms source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
