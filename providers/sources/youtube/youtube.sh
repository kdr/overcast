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

# yt-dlp is required. Every invocation goes through run_ytdlp so two env knobs
# apply uniformly: OVERCAST_YTDLP_CMD overrides the binary/wrapper (e.g. a pipx
# or standalone-binary install shadowed on PATH by an older brew one), and
# OVERCAST_YTDLP_ARGS injects extra flags into EVERY call (e.g. "--referer
# https://embedding-site/ --impersonate chrome" for domain-restricted embeds on
# TLS-fingerprinting hosts). Both are whitespace-split via `read -a` — never an
# unquoted expansion, so a glob char in a referer/UA token (?, *) stays literal
# instead of pathname-expanding against the cwd. Script-set flags come AFTER
# the extras, so on a CONFLICT the artifact contract (-o/-f/--dump-json) wins;
# but a flag this script deliberately OMITS (e.g. --flat-playlist is dropped on
# --since recency scans so --dateafter sees upload_date) CAN be reintroduced by
# ARGS — keep it to request-shaping flags (referer/impersonate/proxy/cookies).
run_ytdlp() {
  local -a ytcmd ytargs
  read -r -a ytcmd <<<"${OVERCAST_YTDLP_CMD:-yt-dlp}"
  read -r -a ytargs <<<"${OVERCAST_YTDLP_ARGS:-}"
  # ${arr[@]+…} guards the empty-array expansion (bash 3.2 + set -u errors on it)
  "${ytcmd[@]}" ${ytargs[@]+"${ytargs[@]}"} "$@"
}

# Surface a clear, actionable message if yt-dlp is missing so the user knows
# exactly how to install it (exit 13 = needs setup; overcast maps the stderr
# into the record's error). Lead with channels that carry curl_cffi
# impersonation — brew/apt builds lack it, and TLS-fingerprinting hosts
# (e.g. domain-restricted Vimeo embeds) 401 without it.
need_ytdlp() {
  read -r -a ytcmd <<<"${OVERCAST_YTDLP_CMD:-yt-dlp}"
  if ! command -v "${ytcmd[0]}" >/dev/null 2>&1; then
    cat >&2 <<'MSG'
youtube source requires `yt-dlp` (not found on PATH). Install one of:
  • pipx install "yt-dlp[default,curl-cffi]"   (or: pip3 install --user -U "yt-dlp[default,curl-cffi]")
  • a standalone release binary (bundles impersonation, self-updates via `yt-dlp -U`):
    https://github.com/yt-dlp/yt-dlp#installation
  • brew install yt-dlp   (works, but lacks curl_cffi impersonation — TLS-fingerprinting
    hosts like Vimeo embeds will fail)
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
    playlists:*|shorts:*|streams:*) # channel TABS — one shared normalization:
      # bare handle → @handle; URL → append the tab, tolerating a URL that
      # already ends with it (no …/playlists/playlists double-append). A
      # browser-copied URL's ?query/#fragment is dropped — it only tweaks the
      # tab's sort/view and would defeat the suffix handling downstream.
      local tab="${ref%%:*}" ch="${ref#*:}"
      case "$ch" in
        http*://*)
          ch="${ch%%\#*}"; ch="${ch%%\?*}"
          ch="${ch%/}"; ch="${ch%"/$tab"}"; echo "$ch/$tab" ;;
        @*)        echo "https://www.youtube.com/${ch}/$tab" ;;
        *)         echo "https://www.youtube.com/@${ch}/$tab" ;;
      esac ;;
    @*)          echo "https://www.youtube.com/${ref}/videos" ;;
    playlist:*)  echo "https://www.youtube.com/playlist?list=${ref#playlist:}" ;;
    http*://*)
      # a bare channel-ROOT url normalizes to its /videos tab, exactly like
      # the @handle shorthand — so mode detection and the uncapped recency
      # bound (--break-on-reject) treat both spellings identically. Anything
      # deeper (a tab, a video slug, watch/playlist urls) passes through.
      local u="${ref%%\#*}"; u="${u%%\?*}"; u="${u%/}"
      case "$u" in
        *youtube.com/@*/*|*youtube.com/c/*/*|*youtube.com/channel/*/*|*youtube.com/user/*/*)
          echo "$ref" ;;   # already a tab or deeper path
        *youtube.com/@*|*youtube.com/c/*|*youtube.com/channel/*|*youtube.com/user/*)
          echo "$u/videos" ;;
        *) echo "$ref" ;;
      esac ;;
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
    # playlists mode keys off the RESOLVED target, so a raw
    # https://…/@handle/playlists URL gets the same kind/playlist_ref treatment
    # as the playlists: ref form (otherwise --pull would error each hit at the
    # fetch guard instead of emitting the pull_skip promote hint). Matching
    # ignores ?query/#fragment — a browser-copied tab URL carries sort/view
    # params that must not defeat the suffix check.
    tpath="${target%%\#*}"; tpath="${tpath%%\?*}"; tpath="${tpath%/}"
    mode="videos"; case "$tpath" in */playlists) mode="playlists" ;; esac
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
      # an UNCAPPED (--limit 0) recency scan of a channel TAB would otherwise
      # crawl the entire channel non-flat just to date-filter it. Channel tabs
      # enumerate newest-first, so --break-on-reject stops the crawl at the
      # first too-old upload — bounded work for "everything since X". Playlists
      # are arbitrary-order, so they never get the break (full scan is honest).
      # Matched on the query-stripped path like `mode` above.
      case "$tpath" in
        */videos|*/shorts|*/streams) [ "$limit" -eq 0 ] && date_args="$date_args --break-on-reject" ;;
      esac
    fi
    # capture yt-dlp explicitly so a failure (network, age-restriction, etc.)
    # surfaces as an enumerate ERROR (exit 1 → scan error record), not an empty
    # hit list that reads like a clean zero-result scan. Keep stderr SEPARATE from
    # the --dump-json stdout, so routine yt-dlp warnings don't corrupt the JSON.
    errf="$(mktemp)"
    # shellcheck disable=SC2086
    raw="$(run_ytdlp $flat $date_args --dump-json $end_args "$target" 2>"$errf")"; code=$?
    # exit 101 is yt-dlp's "stopped by --break-*/--max-downloads" code — the
    # success path ONLY when THIS script passed --break-on-reject (the bounded
    # recency scan). A user/global yt-dlp config tripping 101 on its own
    # (--max-downloads etc.) is a truncated listing and stays an error.
    case "$date_args" in *--break-on-reject*) [ "$code" -eq 101 ] && code=0 ;; esac
    # ANY OTHER non-zero yt-dlp exit is a failure (network, auth, unavailable,
    # partial), even with no "ERROR" line or some JSON already printed — surface
    # it as an enumerate error rather than a clean/partial scan. A successful
    # run that simply found nothing exits 0 with empty stdout (handled below).
    if [ "$code" -ne 0 ]; then
      echo "youtube enumerate failed (yt-dlp exit $code): $(tail -3 "$errf" | tr '\n' ' ')" >&2
      rm -f "$errf"; exit 1
    fi
    rm -f "$errf"
    # exit 0 + empty stdout = legitimate ZERO-result search/playlist.
    [ -z "$raw" ] && { echo '[]'; exit 0; }
    # playlists-tab hits additionally carry the playlist id + the youtube:playlist:
    # ref, so a hit can be promoted straight to a standing source.
    # url fallback is MODE-aware: a playlists-tab entry's id is a playlist id,
    # so the fallback must be a playlist URL, never a bogus youtu.be watch link
    printf '%s\n' "$raw" \
      | jq -sc --arg mode "$mode" '[ .[]
        | (.url // .webpage_url
           // (if $mode == "playlists"
               then ("https://www.youtube.com/playlist?list=" + .id)
               else ("https://youtu.be/" + .id) end)) as $u
        | {
          title: (.title // .id),
          url: $u,
          source: "youtube",
          published: (.upload_date // null),
          snippet: (.description // (.uploader // "") ),
          author: (.uploader // .channel // null),
          views: (.view_count // null),
          duration: (.duration // null),
          thumb: (((.thumbnails // []) | last | .url?) // .thumbnail // null),
          media: { ref: $u }
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
        # All sidecars land in a SCRATCH dir and only the chosen artifact is
        # moved into place: --out is stable per URL (uniqueName), so cleaning up
        # "$tbase".* on a failed RETRY would delete the artifact a previous
        # successful capture of the same video still points at.
        workdir="$(mktemp -d)"; wbase="$workdir/cap"
        run_ytdlp --skip-download --no-playlist --write-subs --write-auto-subs \
          --sub-langs "${lang},${lang}-orig" --sub-format vtt \
          --write-info-json -o "$wbase" "$url" >&2
        ytcode=$?
        info="$wbase.info.json"
        if [ ! -s "$info" ]; then
          rm -rf "$workdir"
          echo "youtube transcript fetch failed for $url (yt-dlp exit $ytcode)" >&2; exit 1
        fi
        # pick the best caption track: exact lang > original-audio auto > any
        vtt=""
        for cand in "$wbase.$lang.vtt" "$wbase.$lang-orig.vtt"; do
          [ -s "$cand" ] && { vtt="$cand"; break; }
        done
        [ -z "$vtt" ] && vtt="$(ls -t "$wbase".*.vtt 2>/dev/null | head -1)"
        # a nonzero yt-dlp exit with NO caption track is a FAILURE, not an
        # uncaptioned video — every subtitle request may have been rate-limited
        # (HTTP 429), and reporting "no captions" would silently drop real ones
        # from a playlist-wide pull. Tolerate nonzero only once a track landed.
        if [ "$ytcode" -ne 0 ] && [ -z "$vtt" ]; then
          rm -rf "$workdir"
          echo "youtube transcript fetch failed for $url (yt-dlp exit $ytcode, no caption track retrieved)" >&2; exit 1
        fi
        # VTT → plain text: strip cue timings/headers/inline karaoke tags, drop
        # the rolling duplicate lines auto-captions emit, cap at 200KB (the full
        # VTT stays as the file artifact). The tag strip is a single MARK-STACK
        # pass, mirroring stripCueTags in the tinycloud watch mapper (same
        # caption text, same semantics): each `<` marks the kept-piece index and
        # the matching `>` rewinds to it, so nesting is handled in ONE traversal.
        # It works over an ARRAY of characters (printf the kept ones) rather than
        # string ops: `out = out c` copies the growing string, and even
        # `substr($0, i, 1)` per character rescans, so either makes a long
        # provider-controlled caption line quadratic while the nesting logic
        # stays single-pass. Measured: 800KB in one line went 11.2s → 0.73s, and
        # time now doubles with size instead of quadrupling.
        #
        # Empty-separator `split` fills that array in one linear step, but it is
        # a gawk/mawk/BWK extension rather than POSIX, so BEGIN probes for it and
        # falls back to a per-character substr walk on an awk that lacks it. The
        # fallback is quadratic on a pathological single line — correct output
        # everywhere, fast where the extension exists.
        # A `sed` fixed-point loop peels one layer per pass (quadratic on deep
        # nesting); a plain depth counter swallows the rest of a cue after a lone
        # `<`. A bracket is markup only when it PAIRS, so spoken "x < y" and
        # "2 > 1" survive. \r is stripped FIRST so CRLF VTTs
        # anchor like LF ones. A digit-only line is removed ONLY when the next
        # line is a cue TIMING (id + "-->" line = a VTT cue identifier), and
        # only real timing lines (with the arrow) are dropped — spoken numbers
        # ("2026") and spoken times ("12:30 news") are captions and survive.
        txf="$(mktemp)"
        if [ -n "$vtt" ] && [ -s "$vtt" ]; then
          sed -E 's/\r$//' "$vtt" \
            | awk 'BEGIN { SPLIT_CHARS = (split("ab", probe_, "") == 2) }
                   { if (SPLIT_CHARS) m = split($0, ch, "")
                     else { m = length($0); for (i = 1; i <= m; i++) ch[i] = substr($0, i, 1) }
                     k = 0; top = 0
                     for (i = 1; i <= m; i++) {
                       c = ch[i]
                       if (c == "<") { mark[++top] = k; out[++k] = c }
                       else if (c == ">" && top > 0) { k = mark[top--] }
                       else { out[++k] = c }
                     }
                     for (i = 1; i <= k; i++) printf "%s", out[i]
                     printf "\n" }' \
            | awk 'NR > 1 { if (!(prev ~ /^[0-9]+$/ && $0 ~ /^[0-9][0-9]:[0-9][0-9](:[0-9][0-9])?[.,][0-9][0-9][0-9] --> /)) print prev } { prev = $0 } END { if (NR > 0) print prev }' \
            | grep -Ev '^WEBVTT|^Kind:|^Language:|^NOTE( |$)|^[0-9]{2}:[0-9]{2}(:[0-9]{2})?[.,][0-9]{3} -->' \
            | awk 'NF' | awk '$0 != prev { print; prev = $0 }' \
            | head -c 200000 > "$txf"
        fi
        truncated="false"
        [ -s "$txf" ] && [ "$(wc -c < "$txf")" -ge 200000 ] && truncated="true"
        # uncaptioned video (clean yt-dlp exit, no track) → metadata-only .txt
        # artifact (title + description), a ready record with a note — not an
        # error, so playlist-wide pulls don't fail-storm on captionless uploads.
        # EVERY artifact (vtt AND txt) is staged in the scratch dir and only
        # moved onto the stable --out base after the record builds — a failed
        # record build must never overwrite a prior successful artifact.
        akind="transcript"; staged=""
        if [ ! -s "$txf" ]; then
          akind="meta"; staged="$wbase.txt"; artifact="$tbase.txt"
          { jq -r '.title // ""' "$info"; echo; jq -r '.description // ""' "$info"; } > "$staged"
        else
          staged="$vtt"; artifact="$tbase${vtt#"$wbase"}"
        fi
        # label the track we actually KEPT: only the exact-lang file can be the
        # manual track (and only when info.json lists manual subs for the lang);
        # a surviving -orig or other variant is auto-generated — a partial fetch
        # must not report "manual" for an auto track. transcript_lang likewise
        # reflects the kept FILE's language token (e.g. a fallback fr track is
        # labeled fr, not the requested lang; -orig maps to its base language).
        tsrc="auto"
        if [ "$vtt" = "$wbase.$lang.vtt" ]; then
          tsrc="$(jq -r --arg l "$lang" 'if ((.subtitles // {}) | has($l)) then "manual" else "auto" end' "$info")"
        fi
        keptlang="$lang"
        if [ -n "$vtt" ]; then
          keptlang="${vtt#"$wbase".}"; keptlang="${keptlang%.vtt}"; keptlang="${keptlang%-orig}"
        fi
        # build the record BEFORE moving the artifact or cleaning scratch, and
        # honor jq's exit status — a trailing rm would otherwise mask a jq
        # failure as exit 0 with empty stdout (a generic missing-file error
        # instead of the real parse one).
        record="$(jq -c --rawfile tx "$txf" --arg p "$artifact" --arg u "$url" --arg k "$akind" \
              --arg lang "$keptlang" --arg tsrc "$tsrc" --argjson trunc "$truncated" '
          ($tx | rtrimstr("\n")) as $text |
          { kind: $k, path: $p, source: "youtube", url: $u,
            title: (.title // null), description: (.description // null),
            published: (.upload_date // null), author: (.uploader // .channel // null),
            duration: (.duration // null), views: (.view_count // null) }
          + (if $text == ""
             then { transcript: null, transcript_note: "no captions available" }
             else { transcript: $text, transcript_lang: $lang, transcript_source: $tsrc }
                  + (if $trunc then { transcript_truncated: true } else {} end)
             end)' "$info")" || {
          rm -rf "$workdir" "$txf"
          echo "youtube transcript fetch: building the capture record failed for $url" >&2; exit 1
        }
        mv -f "$staged" "$artifact"
        rm -rf "$workdir" "$txf"
        printf '%s\n' "$record"
        ;;
      thumb)
        # thumbnail image only, NO media download (webp→jpg needs ffmpeg — an
        # overcast prereq; without it yt-dlp keeps the original format). Same
        # scratch-dir lifecycle as transcript: only the final image reaches the
        # stable --out base, so a failed retry can't disturb prior artifacts.
        workdir="$(mktemp -d)"; wbase="$workdir/cap"
        if ! run_ytdlp --skip-download --no-playlist --write-thumbnail \
              --convert-thumbnails jpg -o "$wbase" "$url" >&2; then
          rm -rf "$workdir"
          echo "youtube thumbnail fetch failed for $url" >&2; exit 1
        fi
        got="$(ls -t "$wbase".jpg "$wbase".*.jpg "$wbase".webp "$wbase".png 2>/dev/null | head -1)"
        if [ -z "$got" ] || [ ! -s "$got" ]; then
          rm -rf "$workdir"
          echo "youtube thumbnail fetch produced no file for $url" >&2; exit 1
        fi
        real="$tbase${got#"$wbase"}"
        mv -f "$got" "$real"
        rm -rf "$workdir"
        jq -nc --arg p "$real" --arg u "$url" '{kind:"image",path:$p,source:"youtube",url:$u}'
        ;;
      *)
        # cap resolution to keep downloads small; merge to mp4. Honor yt-dlp's exit
        # status — a failed download must surface as an error, not a stale success.
        # --no-playlist like the other kinds: a watch?v=…&list=… SHARE link slips
        # past the pure-playlist guard above, and without it yt-dlp would download
        # the entire list over one --out base.
        if ! run_ytdlp --no-playlist -f "best[height<=720]/best" -o "$out" "$url" >&2; then
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
