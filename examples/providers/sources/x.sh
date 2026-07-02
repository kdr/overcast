#!/usr/bin/env bash
# overcast source provider: x / twitter (Apify tweet-scraper actors).
# Bind with:  overcast source add x:@handle | x:#tag | "x:<advanced query>"
#             OVERCAST_SOURCE_X_CMD="bash examples/providers/sources/x.sh"
# Implements: enumerate --query <ref> [--limit N] [--since <s>]
#             fetch --url <u> --out <p>  |  init | describe
#
# Refs: @handle        — a profile's posts (translated to a `from:` search)
#       video:<query>  — only posts with native video (media targeting)
#       image:<query>  — only posts with images
#       #tag / <query> — X advanced search (supports from:, filter:native_video,
#                        min_faves:, -filter:retweets, …)
#       https://x.com/… — a post/profile/search/list URL (actor startUrls)
#
# Hits carry the post page URL; media.ref prefers the direct CDN asset (highest-
# bitrate mp4 variant, else photo URL) so `capture` downloads without X auth.
# Default actor = kaitoeasyapi's pay-per-result tweet scraper (works on any Apify
# plan against platform credit; pads empty results with `mock_tweet` items the
# mapper drops). Override with OVERCAST_X_ACTOR — e.g. `apidojo~tweet-scraper`
# (same schema, faster, but RENTAL: a free/unrented account gets only
# `noResults`/`demo` placeholders, which map to zero hits here). Media targeting
# and --since are applied as advanced-search operators (filter:…, since:…) so
# they hold across actors. Actors bill per result with a small per-query
# minimum — prefer fewer, broader queries over many narrow ones.
set -euo pipefail
op="${1:-enumerate}"; shift || true
ACTOR="${OVERCAST_X_ACTOR:-kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest}"

# epoch seconds → YYYY-MM-DD (UTC). BSD date first (-r epoch), then GNU (-d @).
epoch_to_date() {
  date -u -r "$1" +%Y-%m-%d 2>/dev/null || date -u -d "@$1" +%Y-%m-%d 2>/dev/null || echo ""
}

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"x","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=20; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    [ -n "$query" ] || { echo "x enumerate requires a ref (@handle, #tag, video:<q>, image:<q>, or an advanced query)" >&2; exit 1; }
    # honor --since: the actor's `start` date filter only applies to searchTerms,
    # so ALSO keep a client-side epoch cutoff that covers handle/URL refs (and
    # sub-day precision the date-granular `start` can't express). 0 = no filter.
    cut=0; start_date=""
    if [ -n "$since" ]; then
      now="$(date +%s)"
      case "$since" in
        *[0-9]m) cut=$(( now - ${since%m} * 60 )) ;;
        *[0-9]h) cut=$(( now - ${since%h} * 3600 )) ;;
        *[0-9]d) cut=$(( now - ${since%d} * 86400 )) ;;
        *[0-9]w) cut=$(( now - ${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cut="$(date -d "$since" +%s 2>/dev/null || date -j -f '%Y-%m-%d' "$since" +%s 2>/dev/null || echo 0)" ;;
        *) cut=0 ;;
      esac
      [ "$cut" -gt 0 ] && start_date="$(epoch_to_date "$cut")"
    fi
    # translate the overcast ref into actor input fields. Handles become `from:`
    # searches and media targeting / since become advanced-search OPERATORS —
    # portable across tweet-scraper actors (the onlyVideo/onlyImage/start fields
    # are still set for actors that support them natively).
    terms=""; url=""; only=""
    case "$query" in
      video:*)   only="video"; terms="${query#video:}" ;;
      image:*)   only="image"; terms="${query#image:}" ;;
      http*://*) url="$query" ;;
      @*)        terms="from:${query#@}" ;;
      *)         terms="$query" ;;   # #tag and advanced-search queries pass through
    esac
    if [ -n "$terms" ]; then
      [ "$only" = "video" ] && terms="$terms filter:native_video"
      [ "$only" = "image" ] && terms="$terms filter:images"
      [ -n "$start_date" ] && terms="$terms since:$start_date"
    fi
    # build the body with jq so quotes/backslashes in a query can't break the JSON
    input="$(jq -nc --arg q "$terms" --arg u "$url" \
      --arg only "$only" --arg start "$start_date" --argjson n "$limit" '
      {maxItems: $n, sort: "Latest"}
      + (if $u != "" then {startUrls: [$u]} else {} end)
      + (if $q != "" then {searchTerms: [$q]} else {} end)
      + (if $q != "" and $start != "" then {start: $start} else {} end)
      + (if $only == "video" then {onlyVideo: true}
         elif $only == "image" then {onlyImage: true}
         else {} end)')"
    # -f fails the request on HTTP errors so Apify error JSON isn't parsed as hits
    if ! run=$(curl -fsS -X POST \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
      -H 'content-type: application/json' -d "$input"); then
      echo "x enumerate request failed for '$query'" >&2; exit 1
    fi
    # Apify returns a JSON array on success; anything else (an error object) is a failure
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "x enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map dataset items → scan hits. media.ref prefers the highest-bitrate mp4
    # variant, then the first photo, then the post URL. An unparseable createdAt
    # (ts == 0) is KEPT under a cutoff rather than silently dropped. Placeholder
    # items (kaito `mock_tweet`, apidojo `noResults`/`demo` padding) are dropped:
    # a real post always carries a url.
    jq -c --argjson cut "$cut" --argjson n "$limit" '
      def ts: (try (.createdAt | strptime("%a %b %d %H:%M:%S %z %Y") | mktime) catch 0);
      def media_list: (.extendedEntities.media // .entities.media // .media // [])
        | (if type == "array" then . else [] end);
      [ .[]
        | select((.type // "tweet") == "tweet")
        | select(((.url // .twitterUrl // "") | length) > 0)
        | select($cut == 0 or ts == 0 or ts >= $cut)
        | media_list as $m
        | ([$m[] | select(.type == "video" or .type == "animated_gif")
            | .video_info.variants[]? | select((.content_type // "") == "video/mp4")]
           | if length > 0 then (max_by(.bitrate // 0).url // null) else null end) as $vid
        | ([$m[] | select(.type == "photo") | (.media_url_https? // null)]
           | map(select(. != null)) | (.[0] // null)) as $img
        | ([$m[] | (.media_url_https? // null)] | map(select(. != null)) | (.[0] // null)) as $thumb
        | {
            title: ((.text // "") | gsub("\\s+"; " ") | .[0:120]),
            url: (.url // .twitterUrl // ""),
            source: "x",
            published: (.createdAt // null),
            snippet: (.text // ""),
            author: (.author.userName // null),
            views: (.viewCount // null),
            thumb: $thumb,
            media: { ref: ($vid // $img // .url // .twitterUrl // null) }
          } ][0:$n]' <<<"$run" ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    case "$url" in
      *://video.twimg.com/*|*://pbs.twimg.com/*)
        # direct CDN asset (the media.ref enumerate emits) — plain download, no
        # X auth. overcast sniffs/renames a missing extension after the fetch.
        if ! curl -fsSL -o "$out" "$url"; then
          echo "x fetch failed for $url" >&2; exit 1
        fi
        [ -s "$out" ] || { echo "x fetch produced an empty file for $url" >&2; exit 1; }
        kind="video"; case "$url" in *://pbs.twimg.com/*) kind="image" ;; esac
        jq -nc --arg p "$out" --arg k "$kind" '{kind:$k,path:$p,source:"x"}' ;;
      *)
        # a post page URL — yt-dlp extracts the video (photos have no yt-dlp path;
        # enumerate points photo hits at the pbs.twimg.com asset instead)
        if ! command -v yt-dlp >/dev/null 2>&1; then
          echo "x fetch needs yt-dlp on PATH for post URLs (direct twimg.com media downloads with curl)" >&2
          exit 13
        fi
        # cap resolution (X posts can carry very large HLS masters — a 19-min
        # post at full res is ~240MB; 720p keeps fetches inside the exec timeout)
        if yt-dlp -S "res:720" -o "$out" "$url" >&2; then
          # yt-dlp may append an extension; resolve the actual file written (newest
          # match first, so a stale sibling can't be picked over the fresh download)
          real="$out"; [ -f "$out" ] || real="$(ls -t "${out%.*}".* 2>/dev/null | head -1)"
          if [ -z "$real" ] || [ ! -s "$real" ]; then
            echo "x fetch produced no file for $url" >&2; exit 1
          fi
          jq -nc --arg p "$real" '{kind:"video",path:$p,source:"x"}'
        else
          echo "x fetch failed for $url" >&2; exit 1
        fi ;;
    esac ;;
  *) echo "x source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
