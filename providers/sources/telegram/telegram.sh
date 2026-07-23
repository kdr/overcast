#!/usr/bin/env bash
# overcast source provider: telegram (Apify — public channel scraper). Public
# channels only, no login/phone.
# Bind with:  overcast source add telegram:durov
#             overcast source add telegram:https://t.me/some_channel
#             OVERCAST_SOURCE_TELEGRAM_CMD="bash providers/sources/telegram.sh"
# Refs: <channel> | @channel | https://t.me/<channel>
# Actor override: OVERCAST_TELEGRAM_ACTOR
#   (default webfinity~telegram-channel-content-media-scraper-v2 — input:
#    {channels, maxPosts, daysRange, includeText, mediaOnly}).
# Implements: enumerate --query <ref> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
#
# Each post's stable url is t.me/<channel>/<id> (good for monitor dedup);
# media.ref is the post's first media asset (or the post url as a fallback).
# Strong monitor fit: `overcast monitor --source telegram --every 15m`.
set -euo pipefail
op="${1:-enumerate}"; shift || true
ACTOR="${OVERCAST_TELEGRAM_ACTOR:-webfinity~telegram-channel-content-media-scraper-v2}"

# yt-dlp post-page fetches honor OVERCAST_YTDLP_CMD (binary/wrapper override) and
# OVERCAST_YTDLP_ARGS (extra flags for every call, e.g. --referer/--impersonate
# for TLS-fingerprinting hosts). Both word-split on purpose; script-set flags
# come after the extras so the -o artifact contract always wins.
run_ytdlp() {
  # shellcheck disable=SC2086
  ${OVERCAST_YTDLP_CMD:-yt-dlp} ${OVERCAST_YTDLP_ARGS:-} "$@"
}
have_ytdlp() {
  read -r -a ytcmd <<<"${OVERCAST_YTDLP_CMD:-yt-dlp}"
  command -v "${ytcmd[0]}" >/dev/null 2>&1
}

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"telegram","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=20; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    [ -n "$query" ] || { echo "telegram enumerate requires a channel ref (<channel>, @channel, or a t.me URL)" >&2; exit 1; }
    # normalize the ref to a bare channel username: strip @, or pull the first
    # path segment out of a t.me URL (handles t.me/<ch>, t.me/s/<ch> preview, and
    # rejects t.me/c/<id> private-channel links the public scraper can't reach —
    # otherwise the naive parse would target the literal channel "c").
    channel="$query"
    case "$query" in
      http*://*)
        path="$(printf '%s' "$query" | sed -E 's#^https?://[^/]+/##; s/[?#].*$//')"
        case "$path" in
          s/*) channel="${path#s/}"; channel="${channel%%/*}" ;;
          c/*) echo "telegram: private-channel links (t.me/c/<id>) are not supported by the public scraper" >&2; exit 1 ;;
          *)   channel="${path%%/*}" ;;
        esac ;;
      @*) channel="${query#@}" ;;
    esac
    [ -n "$channel" ] || { echo "telegram: could not parse a channel from '$query'" >&2; exit 1; }
    # --since → daysRange (whole days; sub-day windows round up to 1). The actor
    # caps the lookback at 30 days, so clamp there.
    days=""
    if [ -n "$since" ]; then
      case "$since" in
        *[0-9]m|*[0-9]h) days=1 ;;
        *[0-9]d) days="${since%d}" ;;
        *[0-9]w) days=$(( ${since%w} * 7 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          # absolute calendar date → whole days back from now (BSD/GNU date)
          now="$(date -u +%s)"
          d="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$since 00:00:00" +%s 2>/dev/null || echo '')"
          if [ -n "$d" ]; then days=$(( (now - d) / 86400 )); [ "$days" -lt 1 ] && days=1; fi ;;
        *) days="" ;;
      esac
      # clamp to the actor's 1–30 day range: a 0-day window (--since 0d/0w) must
      # not forward daysRange:0.
      [ -n "$days" ] && [ "$days" -gt 30 ] 2>/dev/null && days=30
      [ -n "$days" ] && [ "$days" -lt 1 ] 2>/dev/null && days=1
    fi
    input="$(jq -nc --arg c "$channel" --argjson n "$limit" --arg d "$days" \
      '{channels:$c, maxPosts:$n, includeText:true}
       + (if $d != "" then {daysRange:($d|tonumber)} else {} end)')"
    if ! run=$(curl -fsS -m 280 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input"); then
      echo "telegram enumerate request failed for '$channel'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "telegram enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map posts → hits. Drop the actor's "No posts found in the selected period."
    # padding item (empty postUrl). media.ref prefers the first media asset.
    jq -c --argjson n "$limit" '
      [ .[]
        | select(((.postUrl // "") | length) > 0)
        | ((.mediaUrls // []) | map(select(type == "string" and length > 0))) as $media
        | {
            title: (((.text // "") | gsub("\\s+"; " ") | .[0:120])
                    | if . == "" then (.channelTitle // "telegram post") else . end),
            url: .postUrl,
            source: "telegram",
            published: (.date // null),
            snippet: (.text // ""),
            author: (.channel // .channelTitle // null),
            views: (.views // null),
            channel_title: (.channelTitle // null),
            has_media: (.hasMedia // false),
            media_types: (.mediaTypes // []),
            media: { ref: (($media[0]) // .postUrl) }
          } ] | .[0:$n]' <<<"$run" ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "telegram fetch needs --url" >&2; exit 1; }
    case "$url" in
      *://t.me/*)
        # a post page URL (no direct media asset) — yt-dlp handles t.me embeds
        if ! have_ytdlp; then
          echo "telegram fetch of a post page needs yt-dlp on PATH" >&2; exit 13
        fi
        if run_ytdlp -o "$out" "$url" >&2; then
          real="$out"; [ -f "$out" ] || real="$(ls -t "${out%.*}".* 2>/dev/null | head -1)"
          [ -n "$real" ] && [ -s "$real" ] || { echo "telegram fetch produced no file for $url" >&2; exit 1; }
          case "$(printf '%s' "${real##*.}" | tr '[:upper:]' '[:lower:]')" in
            mp3|m4a|aac|wav|flac|ogg|oga|opus) kind="audio" ;;
            jpg|jpeg|png|webp|gif|heic|avif)   kind="image" ;;
            *)                                 kind="video" ;;
          esac
          jq -nc --arg p "$real" --arg k "$kind" '{kind:$k,path:$p,source:"telegram"}'
        else
          echo "telegram fetch failed for $url" >&2; exit 1
        fi ;;
      *)
        # a direct media asset — plain download, kind by content type
        if ! ct="$(curl -fsSL -m 180 -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
          echo "telegram fetch failed for $url" >&2; rm -f "$out"; exit 1
        fi
        case "$ct" in
          image/*) kind="image" ;;
          video/*) kind="video" ;;
          audio/*) kind="audio" ;;
          *)       kind="file" ;;
        esac
        jq -nc --arg p "$out" --arg k "$kind" '{kind:$k,path:$p,source:"telegram"}' ;;
    esac ;;
  *) echo "telegram source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
