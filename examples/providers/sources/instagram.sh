#!/usr/bin/env bash
# overcast source provider: instagram (Apify apify/instagram-scraper). Public
# data only, no login.
# Bind with:  overcast source add instagram:@nasa
#             overcast source add instagram:#wildfire
#             OVERCAST_SOURCE_INSTAGRAM_CMD="bash examples/providers/sources/instagram.sh"
# Refs: @handle | handle — a profile's posts/reels
#       #tag              — a hashtag's posts
#       https://instagram.com/… — a profile/post/reel URL
# Actor override: OVERCAST_INSTAGRAM_ACTOR (default apify~instagram-scraper).
# Implements: enumerate --query <ref> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
#
# Hits' media.ref is the direct CDN asset (videoUrl for videos, else the image),
# so `capture` downloads it without login; the post page URL rides in payload.url.
# CDN URLs are short-lived — capture soon after scanning (scan --pull is ideal).
set -euo pipefail
op="${1:-enumerate}"; shift || true
ACTOR="${OVERCAST_INSTAGRAM_ACTOR:-apify~instagram-scraper}"

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"instagram","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=20; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    [ -n "$query" ] || { echo "instagram enumerate requires a ref (@handle, #tag, or an instagram URL)" >&2; exit 1; }
    # honor --since with a client-side epoch cutoff (the actor has no portable
    # date param). 0 = no filter.
    cut=0
    if [ -n "$since" ]; then
      now="$(date +%s)"
      case "$since" in
        *[0-9]m) cut=$(( now - ${since%m} * 60 )) ;;
        *[0-9]h) cut=$(( now - ${since%h} * 3600 )) ;;
        *[0-9]d) cut=$(( now - ${since%d} * 86400 )) ;;
        *[0-9]w) cut=$(( now - ${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cut="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d' "$since" +%s 2>/dev/null || echo 0)" ;;
        *) cut=0 ;;
      esac
    fi
    # translate the ref into a directUrls target for the actor
    case "$query" in
      \#*)       url="https://www.instagram.com/explore/tags/${query#\#}/" ;;
      http*://*) url="$query" ;;
      @*)        url="https://www.instagram.com/${query#@}/" ;;
      *)         url="https://www.instagram.com/${query}/" ;;
    esac
    input="$(jq -nc --arg u "$url" --argjson n "$limit" \
      '{directUrls:[$u], resultsType:"posts", resultsLimit:$n, addParentData:false}')"
    if ! run=$(curl -fsS -m 280 -X POST \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
      -H 'content-type: application/json' -d "$input"); then
      echo "instagram enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "instagram enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map posts → hits. ts from ISO timestamp; drop items with no url (the actor
    # can emit a profile-summary/error item without one). media.ref prefers the
    # direct video asset, then the first image, then the display image.
    jq -c --argjson cut "$cut" --argjson n "$limit" '
      def ts: (try (.timestamp | strptime("%Y-%m-%dT%H:%M:%S.000Z") | mktime) catch
               (try (.timestamp | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime) catch 0));
      [ .[]
        | select(((.url // "") | length) > 0)
        # Instagram timestamps are reliably ISO-8601, so under an active --since
        # cutoff a post whose timestamp fails to parse (ts == 0) is dropped, not
        # kept: a post that cannot be dated must not slip past the window.
        | select($cut == 0 or ts >= $cut)
        | (.videoUrl // (.images // [])[0] // .displayUrl // null) as $asset
        | {
            title: ((.caption // "") | gsub("\\s+"; " ") | .[0:120]),
            url: .url,
            source: "instagram",
            published: (.timestamp // null),
            snippet: (.caption // ""),
            author: (.ownerUsername // .ownerFullName // null),
            views: (.videoViewCount // .likesCount // null),
            post_type: (.type // null),
            thumb: (.displayUrl // null),
            media: { ref: ($asset // .url) }
          } ] | .[0:$n]' <<<"$run" ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "instagram fetch needs --url" >&2; exit 1; }
    case "$url" in
      *://www.instagram.com/*|*://instagram.com/*)
        # a post page URL — needs yt-dlp (and usually login for Instagram); the
        # enumerate media.ref points at the direct CDN asset instead, so this
        # branch is a fallback.
        if ! command -v yt-dlp >/dev/null 2>&1; then
          echo "instagram fetch of a post page needs yt-dlp; the direct CDN asset (media.ref) downloads with curl" >&2
          exit 13
        fi
        if yt-dlp -S "res:720" -o "$out" "$url" >&2; then
          real="$out"; [ -f "$out" ] || real="$(ls -t "${out%.*}".* 2>/dev/null | head -1)"
          [ -n "$real" ] && [ -s "$real" ] || { echo "instagram fetch produced no file for $url" >&2; exit 1; }
          case "$(printf '%s' "${real##*.}" | tr '[:upper:]' '[:lower:]')" in
            jpg|jpeg|png|webp|gif|heic|avif) kind="image" ;; *) kind="video" ;;
          esac
          jq -nc --arg p "$real" --arg k "$kind" '{kind:$k,path:$p,source:"instagram"}'
        else
          echo "instagram fetch failed for $url" >&2; exit 1
        fi ;;
      *)
        # direct CDN asset (image or video) — plain download, kind by content type
        if ! ct="$(curl -fsSL -m 180 -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
          echo "instagram fetch failed for $url" >&2; rm -f "$out"; exit 1
        fi
        case "$ct" in
          image/*) kind="image" ;;
          video/*) kind="video" ;;
          *)       kind="file" ;;
        esac
        jq -nc --arg p "$out" --arg k "$kind" '{kind:$k,path:$p,source:"instagram"}' ;;
    esac ;;
  *) echo "instagram source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
