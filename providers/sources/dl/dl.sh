#!/usr/bin/env bash
# overcast source provider: dl (generic yt-dlp downloader). No API key.
# Downloads any of yt-dlp's ~1800 supported sites (Rumble/BitChute/Odysee/VK/
# Bilibili/Vimeo/Dailymotion/Reddit/Facebook/Twitch/Kick/…) that lack a dedicated
# source. `enumerate` flat-lists a channel/playlist/user URL (yt-dlp
# --flat-playlist) so scan/monitor can stake out any yt-dlp host; a single-video
# URL stays capture-only (returns []). `fetch` does the actual download.
#
# You rarely bind `dl` directly: overcast auto-routes an ad-hoc
# `overcast capture <url>` to `dl` when the host is a known video site
# (hostSourceType, src/verbs/osint.ts), and a scan.hit stamped source:dl
# captures back through here. You CAN bind a listing to scan, or a single URL:
#   overcast source add dl:https://rumble.com/c/Rumble          (channel → enumerable)
#   overcast source add dl:https://rumble.com/v123-clip.html    (single video → [], capture-only)
#
# Implements the exec source contract:
#   <this> enumerate --query <url> [--limit N] [--since D]  -> scan.hit JSON array
#                                                             (channel/playlist URL;
#                                                              [] for a single video)
#   <this> fetch --url <u> --out <path>                     -> capture record JSON on stdout
#   <this> init | describe
set -uo pipefail

# yt-dlp is required for fetch. Surface a clear, actionable message if missing so
# the user knows how to install it (exit 13 = needs setup; overcast maps the
# stderr into the record's error).
need_ytdlp() {
  if ! command -v yt-dlp >/dev/null 2>&1; then
    cat >&2 <<'MSG'
dl source requires `yt-dlp` (not found on PATH). Install one of:
  • brew install yt-dlp
  • pipx install yt-dlp   (or: pip3 install --user yt-dlp)
  • https://github.com/yt-dlp/yt-dlp#installation
MSG
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true

case "$op" in
  init)     need_ytdlp; exit 0 ;;
  describe) echo '{"source":"dl","emits":"capture","capture_only":true,"needs":["yt-dlp"]}'; exit 0 ;;

  enumerate)
    query=""; limit=10; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # a non-numeric limit falls back to the default cap; 0 = uncapped (whole
    # channel/playlist — the manifest declares uncappedLimit so the seam
    # forwards the 0)
    case "$limit" in ''|*[!0-9]*) limit=10 ;; esac
    # dl refs are raw URLs. yt-dlp flat mode on a SINGLE video URL yields exactly one
    # entry and wastes a network call, and the settled contract keeps single URLs
    # capture-only. Best-effort heuristic (host quirks are a long tail — the policy is
    # generic-or-`[]`, never per-host branches): treat the ref as an enumerable
    # LISTING only when the URL looks like a channel / playlist / user page; anything
    # else (a plain video URL, or a host we can't classify) echoes a clean `[]` and
    # exits 0, preserving today's capture-only behavior. A wrong `[]` is a no-op scan,
    # never a failure. Classify FIRST, then require yt-dlp only on the listing path so
    # the `[]` fast-path stays dependency-free (a single-video URL never needs yt-dlp).
    # The `@handle` case is a listing ONLY when the handle is the LAST path segment
    # (a channel root, e.g. youtube.com/@handle, /@handle/, /@handle?si=x) or is
    # followed only by a known channel tab (videos/streams/shorts/playlists/live) —
    # NOT when an arbitrary video slug follows (Odysee's /@chan:c/video-title:d, which
    # must stay capture-only).
    is_listing=""
    case "$query" in
      */c/*|*/channel/*|*/user/*|*/playlist*|*'?list='*) is_listing=1 ;;  # enumerable listing
    esac
    if [ -z "$is_listing" ] && printf '%s' "$query" | grep -qE '/@[^/]+/?([?].*)?$|/@[^/]+/(videos|streams|shorts|playlists|live)/?([?].*)?$'; then
      is_listing=1  # @handle channel root or a known channel tab → enumerable listing
    fi
    [ -n "$is_listing" ] || { echo '[]'; exit 0; }  # single video / unknown → capture-only
    need_ytdlp   # only the listing path calls yt-dlp; the `[]` fast-path needs nothing
    target="$query"   # dl refs are already URLs — no ref translation
    # --flat-playlist keeps it fast (no per-video extraction); dump one JSON/line.
    flat="--flat-playlist"; date_args=""
    if [ -n "$since" ]; then
      # honor --since: map to yt-dlp --dateafter. Date-granular, so sub-day units
      # (minutes/hours) collapse to today/yesterday. Drop --flat-playlist so
      # upload_date is extracted and the filter actually applies (slower — non-flat
      # extraction is the only way --dateafter sees dates; inherited from youtube.sh).
      case "$since" in
        *[0-9]m)                     da="today" ;;       # minutes → today's uploads
        *[0-9]h)                     hrs="${since%h}"; days=$(( 10#$hrs / 24 ));  # 10# forces base-10 (a leading-zero token like 08 is NOT octal)
                                     [ "$days" -le 0 ] && da="today" || da="today-${days}days" ;;
        *[0-9]d)                     da="today-${since%d}days" ;;
        *[0-9]w)                     da="today-$(( 10#${since%w} * 7 ))days" ;;  # 10# forces base-10 (08w must not parse as octal)
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) da="$(printf '%s' "$since" | tr -d -)" ;;
        *)                           da="$since" ;;
      esac
      flat=""; date_args="--dateafter $da"
      # an UNCAPPED (--limit 0) recency scan of a CHANNEL/USER page would
      # otherwise crawl the whole listing non-flat just to date-filter it —
      # uploads pages enumerate newest-first across yt-dlp hosts, so
      # --break-on-reject stops at the first too-old entry (same policy as
      # youtube.sh tabs). Playlist-shaped URLs are arbitrary-order and never
      # get the break (a full scan is the honest behavior there).
      qpath="${query%%\#*}"; qpath="${qpath%%\?*}"
      case "$qpath" in
        *'/playlist'*) : ;;
        *) case "$query" in
             *'?list='*|*'&list='*) : ;;
             *) [ "$limit" -eq 0 ] && date_args="$date_args --break-on-reject" ;;
           esac ;;
      esac
    fi
    # capture yt-dlp explicitly so a failure (network, extractor, unsupported host)
    # surfaces as an enumerate ERROR (exit 1 → scan error record), not an empty hit
    # list that reads like a clean zero-result scan. Keep stderr SEPARATE from the
    # --dump-json stdout so routine yt-dlp warnings don't corrupt the JSON.
    errf="$(mktemp)"
    end_args="--playlist-end $limit"; [ "$limit" -eq 0 ] && end_args=""
    # shellcheck disable=SC2086
    raw="$(yt-dlp $flat $date_args --dump-json $end_args "$target" 2>"$errf")"; code=$?
    # exit 101 is yt-dlp's "stopped by --break-*" code — the success path ONLY
    # when THIS script passed --break-on-reject (the bounded recency scan); a
    # 101 from a user/global --max-downloads config is a truncated listing.
    case "$date_args" in *--break-on-reject*) [ "$code" -eq 101 ] && code=0 ;; esac
    # ANY OTHER non-zero yt-dlp exit is a failure (network, auth, unavailable,
    # partial), even with no "ERROR" line or some JSON already printed — surface
    # it as an enumerate error rather than a clean/partial scan. A successful
    # run that simply found nothing exits 0 with empty stdout (handled below).
    if [ "$code" -ne 0 ]; then
      echo "dl enumerate failed (yt-dlp exit $code): $(tail -3 "$errf" | tr '\n' ' ')" >&2
      rm -f "$errf"; exit 1
    fi
    rm -f "$errf"
    # exit 0 + empty stdout = legitimate ZERO-result listing.
    [ -z "$raw" ] && { echo '[]'; exit 0; }
    # Map flat entries to scan hits. Unlike youtube.sh we can't synthesize a URL from
    # an id (host id schemes vary), so the url falls back only url→webpage_url, and
    # entries with NEITHER are DROPPED — a hit without a stable url would break
    # seen-set identity in scan/monitor.
    printf '%s\n' "$raw" \
      | jq -sc '[ .[] | {
          title: (.title // .id),
          url: (.url // .webpage_url // ""),
          source: "dl",
          published: (.upload_date // null),
          snippet: (.description // (.uploader // "") ),
          author: (.uploader // .channel // null),
          views: (.view_count // null),
          duration: (.duration // null),
          thumb: (((.thumbnails // []) | last | .url?) // .thumbnail // null),
          media: { ref: (.url // .webpage_url // "") }
        } ] | map(select(.url != ""))'
    ;;

  fetch)
    need_ytdlp
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "dl fetch needs --url" >&2; exit 1; }
    # cap resolution to keep downloads small; fall back to best when a site has no
    # height metadata. Honor yt-dlp's exit status so a failed download surfaces as
    # an error, not a stale success.
    if ! yt-dlp -f "best[height<=720]/best" -o "$out" "$url" >&2; then
      echo "dl fetch failed for $url" >&2; exit 1
    fi
    # yt-dlp may append an extension; resolve the actual file written (newest
    # match first, so a stale sibling can't be picked over the fresh download).
    real="$out"; [ -f "$out" ] || real="$(ls -t "${out%.*}".* 2>/dev/null | head -1)"
    if [ -z "$real" ] || [ ! -s "$real" ]; then
      echo "dl fetch produced no file for $url" >&2; exit 1
    fi
    # yt-dlp may write audio-only (or an image) for some hosts — label by the
    # actual file extension so downstream doesn't trust a hardcoded "video".
    case "$(printf '%s' "${real##*.}" | tr '[:upper:]' '[:lower:]')" in
      mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aif|aiff) kind="audio" ;;
      jpg|jpeg|png|webp|gif|bmp|tif|tiff|heic|avif)   kind="image" ;;
      *)                                              kind="video" ;;
    esac
    jq -nc --arg p "$real" --arg u "$url" --arg k "$kind" '{kind:$k,path:$p,source:"dl",url:$u}'
    ;;

  *) echo "dl source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
