#!/usr/bin/env bash
# overcast source provider: youtube (yt-dlp). No API key.
# Default binding for `source add youtube:<ref>`; enumerated by scan/monitor,
# fetched by capture. Implements the exec source contract:
#   <this> enumerate --query <ref> [--limit N]   -> scan.hit JSON array on stdout
#   <this> fetch     --url <u> --out <path>       -> capture record JSON on stdout
#   <this> init | describe
#
# Refs: search:"pier 9" | @handle | playlist:<id> | a full youtube URL | keyword
set -uo pipefail

# yt-dlp is required. Surface a clear, actionable message if it's missing so the
# user knows exactly how to install it (exit 13 = needs setup; overcast maps the
# stderr into the record's error).
need_ytdlp() {
  if ! command -v yt-dlp >/dev/null 2>&1; then
    cat >&2 <<'MSG'
youtube source requires `yt-dlp` (not found on PATH). Install one of:
  • brew install yt-dlp
  • pipx install yt-dlp   (or: pip3 install --user yt-dlp)
  • https://github.com/yt-dlp/yt-dlp#installation
Then re-run, or bind your own: overcast source add youtube:<ref>
MSG
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true

# translate an overcast youtube ref into a yt-dlp target
ref_to_target() {
  local ref="$1" limit="$2"
  case "$ref" in
    search:*)   echo "ytsearch${limit}:${ref#search:}" ;;
    @*)         echo "https://www.youtube.com/${ref}/videos" ;;
    playlist:*) echo "https://www.youtube.com/playlist?list=${ref#playlist:}" ;;
    http*://*)  echo "$ref" ;;
    *)          echo "ytsearch${limit}:${ref}" ;;  # bare keyword
  esac
}

case "$op" in
  init)     need_ytdlp; exit 0 ;;
  describe) echo '{"source":"youtube","emits":"scan.hit","needs":["yt-dlp"]}'; exit 0 ;;

  enumerate)
    need_ytdlp
    query=""; limit=10; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      --since) since="$2"; shift 2 ;;
      *) shift ;;
    esac; done
    target="$(ref_to_target "$query" "$limit")"
    # --flat-playlist keeps it fast (no per-video extraction); dump one JSON/line.
    flat="--flat-playlist"; date_args=""
    if [ -n "$since" ]; then
      # honor --since: map to yt-dlp --dateafter. Date-granular, so sub-day units
      # (minutes/hours) collapse to today/yesterday. Drop --flat-playlist so
      # upload_date is extracted and the filter actually applies.
      case "$since" in
        *[0-9]m)                     da="today" ;;       # minutes → today's uploads
        *[0-9]h)                     hrs="${since%h}"; days=$(( hrs / 24 ));
                                     [ "$days" -le 0 ] && da="today" || da="today-${days}days" ;;
        *[0-9]d)                     da="today-${since%d}days" ;;
        *[0-9]w)                     da="today-$(( ${since%w} * 7 ))days" ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) da="$(printf '%s' "$since" | tr -d -)" ;;
        *)                           da="$since" ;;
      esac
      flat=""; date_args="--dateafter $da"
    fi
    # shellcheck disable=SC2086
    yt-dlp $flat $date_args --dump-json --playlist-end "$limit" "$target" 2>/dev/null \
      | jq -sc '[ .[] | {
          title: (.title // .id),
          url: (.url // .webpage_url // ("https://youtu.be/"+.id)),
          source: "youtube",
          published: (.upload_date // null),
          snippet: (.description // (.uploader // "") ),
          media: { ref: (.url // .webpage_url // ("https://youtu.be/"+.id)) }
        } ]'
    ;;

  fetch)
    need_ytdlp
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      *) shift ;;
    esac; done
    # cap resolution to keep downloads small; merge to mp4. Honor yt-dlp's exit
    # status — a failed download must surface as an error, not a stale success.
    if ! yt-dlp -f "best[height<=720]/best" -o "$out" "$url" >&2; then
      echo "youtube fetch failed for $url" >&2; exit 1
    fi
    # yt-dlp may add an extension; resolve the actual file (newest match first)
    real="$out"; [ -f "$out" ] || real="$(ls -t "${out%.*}".* 2>/dev/null | head -1)"
    if [ -z "$real" ] || [ ! -s "$real" ]; then
      echo "youtube fetch produced no file for $url" >&2; exit 1
    fi
    echo "{\"kind\":\"video\",\"path\":\"$real\",\"source\":\"youtube\",\"url\":\"$url\"}"
    ;;

  *) echo "{}" ;;
esac
