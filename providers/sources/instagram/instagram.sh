#!/usr/bin/env bash
# overcast source provider: instagram (Apify apify/instagram-scraper). Public
# data only, no login.
# Bind with:  overcast source add instagram:@nasa
#             overcast source add instagram:#wildfire
#             OVERCAST_SOURCE_INSTAGRAM_CMD="bash providers/sources/instagram.sh"
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
# shared outbound-fetch guard (scheme pinning, bounded redirects, private-address
# refusal on the FINAL hop) — see providers/engines/net/guarded-fetch.sh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../engines/net/guarded-fetch.sh
. "$here/../../engines/net/guarded-fetch.sh"

op="${1:-enumerate}"; shift || true
ACTOR="${OVERCAST_INSTAGRAM_ACTOR:-apify~instagram-scraper}"

# yt-dlp post-page fetches honor OVERCAST_YTDLP_CMD (binary/wrapper override) and
# OVERCAST_YTDLP_ARGS (extra flags for every call, e.g. --referer/--impersonate
# for TLS-fingerprinting hosts). Both whitespace-split via `read -a` — never an
# unquoted expansion, so glob chars in a referer/UA token stay literal. Script
# flags come after the extras so the -o/-S artifact contract wins on conflict.
run_ytdlp() {
  local -a ytcmd ytargs
  read -r -a ytcmd <<<"${OVERCAST_YTDLP_CMD:-yt-dlp}"
  read -r -a ytargs <<<"${OVERCAST_YTDLP_ARGS:-}"
  # ${arr[@]+…} guards the empty-array expansion (bash 3.2 + set -u errors on it)
  "${ytcmd[@]}" ${ytargs[@]+"${ytargs[@]}"} "$@"
}
have_ytdlp() {
  local -a ytcmd
  read -r -a ytcmd <<<"${OVERCAST_YTDLP_CMD:-yt-dlp}"
  # single token → `command -v` (no spawn); wrapper form ("bash /path/yt-dlp") →
  # execute `--version` so a bad script path fails the check instead of erroring
  # mid-fetch (a first-token check only proves the interpreter exists).
  if [ "${#ytcmd[@]}" -gt 1 ]; then
    "${ytcmd[@]}" --version >/dev/null 2>&1
  else
    command -v "${ytcmd[0]}" >/dev/null 2>&1
  fi
}

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
      # relative windows floor at 1 (so `0d`/`0w` don't forward a 0-length window)
      case "$since" in
        *[0-9]m) n="${since%m}"; [ "$n" -lt 1 ] 2>/dev/null && n=1; newer="${n} minutes" ;;
        *[0-9]h) n="${since%h}"; [ "$n" -lt 1 ] 2>/dev/null && n=1; newer="${n} hours" ;;
        *[0-9]d) n="${since%d}"; [ "$n" -lt 1 ] 2>/dev/null && n=1; newer="${n} days" ;;
        *[0-9]w) n="${since%w}"; [ "$n" -lt 1 ] 2>/dev/null && n=1; newer="${n} weeks" ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) newer="$since" ;;
        # an unparseable --since is a hard error (fail closed): don't silently
        # return a broader/older range than the user asked for.
        *) echo "instagram: could not parse --since '$since' (use Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
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
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
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
        if ! have_ytdlp; then
          echo "instagram fetch of a post page needs yt-dlp; the direct CDN asset (media.ref) downloads with curl" >&2
          exit 13
        fi
        if run_ytdlp -S "res:720" -o "$out" "$url" >&2; then
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
        if ! ct="$(oc_guarded_fetch "$url" "$out" -m 180)" || [ ! -s "$out" ]; then
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
