#!/usr/bin/env bash
# overcast source provider: dl (generic yt-dlp downloader). No API key.
# A CAPTURE-ONLY source: it can't search/enumerate an open-ended host, so
# `enumerate` is a no-op that returns zero hits. Its job is `fetch` — download
# any of yt-dlp's ~1800 supported sites (Rumble/BitChute/Odysee/VK/Bilibili/
# Vimeo/Dailymotion/Reddit/Facebook/Twitch/Kick/…) that lack a dedicated source.
#
# You rarely bind `dl` directly: overcast auto-routes an ad-hoc
# `overcast capture <url>` to `dl` when the host is a known video site
# (hostSourceType, src/verbs/osint.ts), and a scan.hit stamped source:dl
# captures back through here. You CAN bind a single URL if you like:
#   overcast source add dl:https://rumble.com/v123-clip.html   (ref carried, ignored by enumerate)
#
# Implements the exec source contract:
#   <this> enumerate ...                    -> [] (capture-only)
#   <this> fetch --url <u> --out <path>     -> capture record JSON on stdout
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
    # capture-only: there is nothing to search. Emit a clean empty result (NOT an
    # error and NOT a non-zero exit) so `scan --source dl` reads as "no hits",
    # per the exec contract. All real work happens in fetch.
    echo '[]'
    exit 0 ;;

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
    jq -nc --arg p "$real" --arg u "$url" '{kind:"video",path:$p,source:"dl",url:$u}'
    ;;

  *) echo "dl source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
