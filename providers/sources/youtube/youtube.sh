#!/usr/bin/env bash
# overcast source provider: youtube (yt-dlp). No API key.
# Default binding for `source add youtube:<ref>`; enumerated by scan/monitor,
# fetched by capture. Implements the exec source contract:
#   <this> enumerate --query <ref> [--limit N]   -> scan.hit JSON array on stdout
#   <this> fetch     --url <u> --out <path> [--kind video|transcript|thumb]
#                    [--lang <code>]             -> capture record JSON on stdout
#   <this> init | describe
#
# Refs: search:"pier 9" | @handle | playlist:<id> | playlists:@handle (channel's
#       playlists tab) | shorts:@handle | streams:@handle | a full youtube URL |
#       keyword. `--limit 0` = uncapped (whole channel/playlist/tab).
# Fetch kinds (no video download): `transcript` pulls captions + full metadata
# (manual subs preferred over auto; metadata-only fallback when uncaptioned),
# `thumb` pulls the thumbnail image. Default `video` downloads as before.
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
  local ref="$1" limit="${2:-}"
  # search refs embed the cap in the target; limit 0 = every result
  local n="$limit"; [ "$n" = "0" ] && n="all"
  case "$ref" in
    search:*)    echo "ytsearch${n}:${ref#search:}" ;;
    playlists:*) # the channel's playlists TAB — one hit per playlist
      local ch="${ref#playlists:}"
      case "$ch" in
        http*://*) echo "${ch%/}/playlists" ;;
        @*)        echo "https://www.youtube.com/${ch}/playlists" ;;
        *)         echo "https://www.youtube.com/@${ch}/playlists" ;;
      esac ;;
    shorts:@*)   echo "https://www.youtube.com/${ref#shorts:}/shorts" ;;
    streams:@*)  echo "https://www.youtube.com/${ref#streams:}/streams" ;;
    @*)          echo "https://www.youtube.com/${ref}/videos" ;;
    playlist:*)  echo "https://www.youtube.com/playlist?list=${ref#playlist:}" ;;
    http*://*)   echo "$ref" ;;
    *)           echo "ytsearch${n}:${ref}" ;;  # bare keyword
  esac
}

case "$op" in
  init)     need_ytdlp; exit 0 ;;
  describe) echo '{"source":"youtube","emits":"scan.hit","needs":["yt-dlp"],"fetch_kinds":["video","transcript","thumb"]}'; exit 0 ;;

  enumerate)
    need_ytdlp
    query=""; limit=10; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # a non-numeric limit falls back to the default cap; 0 = uncapped
    case "$limit" in ''|*[!0-9]*) limit=10 ;; esac
    target="$(ref_to_target "$query" "$limit")"
    mode="videos"; case "$query" in playlists:*) mode="playlists" ;; esac
    # --flat-playlist keeps it fast (no per-video extraction); dump one JSON/line.
    flat="--flat-playlist"; date_args=""
    end_args="--playlist-end $limit"; [ "$limit" -eq 0 ] && end_args=""
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
    # capture yt-dlp explicitly so a failure (network, age-restriction, etc.)
    # surfaces as an enumerate ERROR (exit 1 → scan error record), not an empty
    # hit list that reads like a clean zero-result scan. Keep stderr SEPARATE from
    # the --dump-json stdout, so routine yt-dlp warnings don't corrupt the JSON.
    errf="$(mktemp)"
    # shellcheck disable=SC2086
    raw="$(yt-dlp $flat $date_args --dump-json $end_args "$target" 2>"$errf")"; code=$?
    # ANY non-zero yt-dlp exit is a failure (network, auth, unavailable, partial),
    # even with no "ERROR" line or some JSON already printed — surface it as an
    # enumerate error rather than a clean/partial scan. A successful run that
    # simply found nothing exits 0 with empty stdout (handled below).
    if [ "$code" -ne 0 ]; then
      echo "youtube enumerate failed (yt-dlp exit $code): $(tail -3 "$errf" | tr '\n' ' ')" >&2
      rm -f "$errf"; exit 1
    fi
    rm -f "$errf"
    # exit 0 + empty stdout = legitimate ZERO-result search/playlist.
    [ -z "$raw" ] && { echo '[]'; exit 0; }
    # playlists-tab hits additionally carry the playlist id + the youtube:playlist:
    # ref, so a hit can be promoted straight to a standing source.
    printf '%s\n' "$raw" \
      | jq -sc --arg mode "$mode" '[ .[] | {
          title: (.title // .id),
          url: (.url // .webpage_url // ("https://youtu.be/"+.id)),
          source: "youtube",
          published: (.upload_date // null),
          snippet: (.description // (.uploader // "") ),
          author: (.uploader // .channel // null),
          views: (.view_count // null),
          duration: (.duration // null),
          thumb: (((.thumbnails // []) | last | .url?) // .thumbnail // null),
          media: { ref: (.url // .webpage_url // ("https://youtu.be/"+.id)) }
        } + (if $mode == "playlists"
             then { kind: "playlist", playlist_id: .id, playlist_ref: ("youtube:playlist:" + .id) }
             else {} end) ]'
    ;;

  fetch)
    need_ytdlp
    url=""; out=""; kind="video"; lang="en"
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      --kind) kind="${2:-}"; shift 2 2>/dev/null || shift ;;
      --lang) lang="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # a playlist CONTAINER url is not a video — refuse cleanly for every fetch
    # kind (a bare `yt-dlp <playlist>` would download the entire list over one
    # --out path; the --no-playlist transcript/thumb fetches would just error).
    case "$url" in
      *"/playlist?list="*)
        echo "youtube fetch: $url is a playlist, not a video — enumerate it (scan youtube:playlist:<id>) and pull its video hits instead" >&2
        exit 1 ;;
    esac
    # yt-dlp derives sidecar names (subs/info-json/thumbnail) from the -o base,
    # so strip a pre-existing extension off --out (dot in the BASENAME only —
    # `${out%.*}` alone would truncate a dotted parent dir).
    tbase="$out"
    case "$(basename "$out")" in *.*) tbase="${out%.*}" ;; esac

    case "$kind" in
      transcript)
        # captions + full metadata, NO media download. Manual + auto subs both
        # requested; --no-playlist pins a watch?v=…&list=… URL to the one video.
        # Request ONLY the target lang + the original-audio auto track — a broad
        # "${lang}.*" glob pulls every auto-TRANSLATED variant and trips
        # YouTube's per-video subtitle rate limit (HTTP 429) on tracks we'd
        # discard anyway.
        yt-dlp --skip-download --no-playlist --write-subs --write-auto-subs \
          --sub-langs "${lang},${lang}-orig" --sub-format vtt \
          --write-info-json -o "$tbase" "$url" >&2
        ytcode=$?
        info="$tbase.info.json"
        # tolerate a nonzero exit when the metadata landed (e.g. a 429 on one
        # subtitle variant after the primary track downloaded) — only fail when
        # there's nothing to build a record from, and leave no partial sidecars.
        if [ ! -s "$info" ]; then
          rm -f "$tbase".*.vtt "$info"
          echo "youtube transcript fetch failed for $url (yt-dlp exit $ytcode)" >&2; exit 1
        fi
        # pick the best caption track: exact lang > original-audio auto > any
        vtt=""
        for cand in "$tbase.$lang.vtt" "$tbase.$lang-orig.vtt"; do
          [ -s "$cand" ] && { vtt="$cand"; break; }
        done
        [ -z "$vtt" ] && vtt="$(ls -t "$tbase".*.vtt 2>/dev/null | head -1)"
        # drop the unchosen variant files so only ONE artifact lands in the case
        for f in "$tbase".*.vtt; do
          [ -e "$f" ] && [ "$f" != "$vtt" ] && rm -f "$f"
        done
        # VTT → plain text: strip cue timings/headers/inline karaoke tags, drop
        # the rolling duplicate lines auto-captions emit, cap at 200KB (the full
        # VTT stays as the file artifact). A digit-only line is removed ONLY when
        # the next line is a cue timing (a VTT cue identifier) — a spoken number
        # ("2026") is caption text and must survive into the transcript.
        txf="$(mktemp)"
        if [ -n "$vtt" ] && [ -s "$vtt" ]; then
          sed -E 's/<[^>]+>//g' "$vtt" \
            | awk 'NR > 1 { if (!(prev ~ /^[0-9]+$/ && $0 ~ /^[0-9][0-9]:[0-9][0-9]/)) print prev } { prev = $0 } END { if (NR > 0) print prev }' \
            | grep -Ev '^WEBVTT|^Kind:|^Language:|^NOTE( |$)|^[0-9]{2}:[0-9]{2}' \
            | awk 'NF' | awk '$0 != prev { print; prev = $0 }' \
            | head -c 200000 > "$txf"
        fi
        truncated="false"
        [ -s "$txf" ] && [ "$(wc -c < "$txf")" -ge 200000 ] && truncated="true"
        # uncaptioned video → metadata-only .txt artifact (title + description),
        # a ready record with a note — not an error, so playlist-wide transcript
        # pulls don't fail-storm on the odd captionless upload.
        artifact="$vtt"; akind="transcript"
        if [ ! -s "$txf" ]; then
          artifact="$tbase.txt"; akind="meta"
          { jq -r '.title // ""' "$info"; echo; jq -r '.description // ""' "$info"; } > "$artifact"
        fi
        # label the track we actually KEPT: only the exact-lang file can be the
        # manual track (and only when info.json lists manual subs for the lang);
        # a surviving -orig or other variant is auto-generated — a partial fetch
        # must not report "manual" for an auto track.
        tsrc="auto"
        if [ "$vtt" = "$tbase.$lang.vtt" ]; then
          tsrc="$(jq -r --arg l "$lang" 'if ((.subtitles // {}) | has($l)) then "manual" else "auto" end' "$info")"
        fi
        jq -c --rawfile tx "$txf" --arg p "$artifact" --arg u "$url" --arg k "$akind" \
              --arg lang "$lang" --arg tsrc "$tsrc" --argjson trunc "$truncated" '
          ($tx | rtrimstr("\n")) as $text |
          { kind: $k, path: $p, source: "youtube", url: $u,
            title: (.title // null), description: (.description // null),
            published: (.upload_date // null), author: (.uploader // .channel // null),
            duration: (.duration // null), views: (.view_count // null) }
          + (if $text == ""
             then { transcript: null, transcript_note: "no captions available" }
             else { transcript: $text, transcript_lang: $lang, transcript_source: $tsrc }
                  + (if $trunc then { transcript_truncated: true } else {} end)
             end)' "$info"
        rm -f "$info" "$txf"
        ;;
      thumb)
        # thumbnail image only, NO media download (webp→jpg needs ffmpeg — an
        # overcast prereq; without it yt-dlp keeps the original format).
        if ! yt-dlp --skip-download --no-playlist --write-thumbnail \
              --convert-thumbnails jpg -o "$tbase" "$url" >&2; then
          echo "youtube thumbnail fetch failed for $url" >&2; exit 1
        fi
        real="$(ls -t "$tbase".jpg "$tbase".*.jpg "$tbase".webp "$tbase".png 2>/dev/null | head -1)"
        if [ -z "$real" ] || [ ! -s "$real" ]; then
          echo "youtube thumbnail fetch produced no file for $url" >&2; exit 1
        fi
        jq -nc --arg p "$real" --arg u "$url" '{kind:"image",path:$p,source:"youtube",url:$u}'
        ;;
      *)
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
        jq -nc --arg p "$real" --arg u "$url" '{kind:"video",path:$p,source:"youtube",url:$u}'
        ;;
    esac
    ;;

  *) echo "youtube source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
