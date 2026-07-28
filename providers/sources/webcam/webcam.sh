#!/usr/bin/env bash
# overcast source provider: webcam (live public webcams via the Windy Webcams
# API — the successor to Webcams.travel, ~70k geolocated cams). Geolocated live
# camera feeds for real-time location monitoring.
# Bind with:  overcast source add webcam:48.8584,2.2945,25
#             overcast source add webcam:country:FR
#             OVERCAST_SOURCE_WEBCAM_CMD="bash providers/sources/webcam.sh"
# Refs / queries:
#   <lat>,<lng>[,<radiusKm>]  — cams near a point (radius default 25, the API max)
#   country:<ISO2>            — cams in a country (e.g. country:FR)
#   category:<slug>           — cams in a category
#   <webcamId>                — a single cam by id
# Key: WINDY_API_KEY (https://api.windy.com/webcams — free tier is enough for
# scan + still-image capture + monitor). Base override: OVERCAST_WEBCAM_API.
# Implements: enumerate --query <ref> [--limit N] | fetch --url <u> --out <p> | init | describe
#
# Each hit's media.ref is the cam's CURRENT still image (the free tier serves
# stills/timelapse, not a raw stream); tokened image URLs expire (~10 min free /
# 24 h pro), so capture soon after scanning (scan --pull / monitor). To grab a
# LIVE clip, open the cam's player page (payload.url) and capture with the `dl`
# source / yt-dlp. Strong monitor fit: `overcast monitor --source webcam --every 30m`.
set -uo pipefail
# shared outbound-fetch guard (scheme pinning, bounded redirects, private-address
# refusal on the FINAL hop) — see providers/engines/net/guarded-fetch.sh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../engines/net/guarded-fetch.sh
. "$here/../../engines/net/guarded-fetch.sh"

API="${OVERCAST_WEBCAM_API:-https://api.windy.com/webcams/api/v3}"
op="${1:-enumerate}"; shift || true

case "$op" in
  init)
    [ -n "${WINDY_API_KEY:-}" ] || { echo "set WINDY_API_KEY (https://api.windy.com/webcams)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"webcam","emits":"scan.hit","needs":["WINDY_API_KEY"]}'; exit 0 ;;
  enumerate)
    query=""; limit=20
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) shift 2 2>/dev/null || shift ;;   # webcams have no recency filter
      *) shift ;;
    esac; done
    [ -n "${WINDY_API_KEY:-}" ] || { echo "set WINDY_API_KEY" >&2; exit 13; }
    [ -n "$query" ] || { echo "webcam enumerate needs a ref (<lat>,<lng>[,<radius>], country:<ISO2>, category:<slug>, or a webcamId)" >&2; exit 1; }

    inc="include=location,images,urls"
    single=0
    case "$query" in
      country:*)  url="$API/webcams?countries=${query#country:}&limit=$limit&$inc" ;;
      category:*) url="$API/webcams?categories=${query#category:}&limit=$limit&$inc" ;;
      *,*)
        # lat,lng[,radius] — default radius 25km (the API max)
        lat="$(printf '%s' "$query" | cut -d, -f1 | tr -d ' ')"
        lng="$(printf '%s' "$query" | cut -d, -f2 | tr -d ' ')"
        rad="$(printf '%s' "$query" | cut -d, -f3 | tr -d ' ')"; [ -n "$rad" ] || rad=25
        url="$API/webcams?nearby=$lat,$lng,$rad&limit=$limit&$inc" ;;
      *[!0-9]*)
        echo "webcam: unrecognized ref '$query' (use <lat>,<lng>[,<radius>], country:<ISO2>, category:<slug>, or a numeric webcamId)" >&2
        exit 1 ;;
      *)          url="$API/webcams/$query?$inc"; single=1 ;;   # bare number = webcamId
    esac

    if ! run="$(curl -fsS -m 60 -H "x-windy-api-key: $WINDY_API_KEY" "$url")"; then
      echo "webcam enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "object"' >/dev/null 2>&1; then
      echo "webcam enumerate: unexpected response: $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # a list response wraps cams in .webcams; the single-cam endpoint returns the
    # cam object directly — normalize both to an array. `now` stamps each poll so
    # `monitor` re-captures the CURRENT still every pass (a cam page is stable but
    # its still image changes, and monitor dedups on the hit url via hitKey).
    now="$(date -u +%s)"
    printf '%s' "$run" | jq -c --argjson n "$limit" --argjson single "$single" --arg now "$now" '
      (if $single == 1 then [ . ] else (.webcams // []) end)
      | [ .[]
          | (.urls.detail // .url // ("https://www.windy.com/webcams/" + ((.webcamId // .id) | tostring))) as $detail
          | {
              title: (.title // ("webcam " + ((.webcamId // .id) | tostring))),
              url: $detail,
              # ephemeral: monitor re-captures the CURRENT still each pass but does
              # not persist this hit to the seen-set (which would grow unbounded).
              # url stays the clean cam page so provenance (source_url) is stable.
              recapture: true,
              snapshot_at: ($now | tonumber),
              source: "webcam",
              published: (.lastUpdatedOn // null),
              snippet: ([(.location.city // ""), (.location.region // ""), (.location.country // "")]
                        | map(select(. != "")) | join(", ")),
              webcam_id: (.webcamId // .id // null),
              status: (.status // null),
              lat: (.location.latitude // null),
              lng: (.location.longitude // null),
              city: (.location.city // null),
              country: (.location.country // null),
              player: (.player.day // .player.live // null),
              # the still ONLY — never the HTML cam page: a cam with no current
              # image yields a null ref and is dropped below (a page capture is
              # not a still and would be skipped by image-only auto_sense anyway).
              media: { ref: (.images.current.preview // .images.current.thumbnail // .images.current.icon // null) }
            }
          | select(.media.ref != null) ] | .[0:$n]'
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "webcam fetch needs --url" >&2; exit 1; }
    # download the current still image (or whatever the ref points at); kind by
    # content type. A detail/player PAGE (text/html) is saved as .html — it's not
    # senseable media, but keeps the evidence. For live video, use `dl`/yt-dlp on
    # the player URL instead.
    if ! ct="$(oc_guarded_fetch "$url" "$out" -m 120)" || [ ! -s "$out" ]; then
      echo "webcam fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*) jq -nc --arg p "$out" --arg u "$url" '{kind:"image",path:$p,source:"webcam",url:$u}' ;;
      video/*) jq -nc --arg p "$out" --arg u "$url" '{kind:"video",path:$p,source:"webcam",url:$u}' ;;
      text/html*)
        page="$out"; case "$out" in *.html|*.htm) : ;; *) mv "$out" "${out}.html"; page="${out}.html" ;; esac
        jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"webcam",url:$u}' ;;
      *) jq -nc --arg p "$out" --arg u "$url" '{kind:"file",path:$p,source:"webcam",url:$u}' ;;
    esac
    ;;
  *) echo "webcam source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
