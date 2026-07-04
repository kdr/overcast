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
    # honor --since via the actor's SERVER-SIDE date filter (onlyPostsNewerThan
    # accepts YYYY-MM-DD, ISO, or a relative phrase). This is far more reliable
    # than parsing ISO timestamps client-side across timezones and format variants.
    newer=""
    if [ -n "$since" ]; then
      case "$since" in
        *[0-9]m) newer="${since%m} minutes" ;;
        *[0-9]h) newer="${since%h} hours" ;;
        *[0-9]d) newer="${since%d} days" ;;
        *[0-9]w) newer="${since%w} weeks" ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) newer="$since" ;;
        *) newer="" ;;
      esac
      # an unrecognized --since must not silently disable the window
      [ -z "$newer" ] && echo "instagram: could not parse --since '$since'; no date filter applied" >&2
    fi
    # translate the ref into a directUrls target for the actor
    case "$query" in
      \#*)       url="https://www.instagram.com/explore/tags/${query#\#}/" ;;
      http*://*) url="$query" ;;
      @*)        url="https://www.instagram.com/${query#@}/" ;;
      *)         url="https://www.instagram.com/${query}/" ;;
    esac
    input="$(jq -nc --arg u "$url" --argjson n "$limit" --arg newer "$newer" \
      '{directUrls:[$u], resultsType:"posts", resultsLimit:$n, addParentData:false}
       + (if $newer != "" then {onlyPostsNewerThan:$newer} else {} end)')"
    if ! run=$(curl -fsS -m 280 -X POST \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
      -H 'content-type: application/json' -d "$input"); then
      echo "instagram enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "instagram enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map posts → hits. Date filtering is server-side (onlyPostsNewerThan); drop
    # items with no url (the actor can emit a profile-summary/error item without
    # one). media.ref prefers the direct video asset, then the first/display image.
    jq -c --argjson n "$limit" '
      [ .[]
        | select(((.url // "") | length) > 0)
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
