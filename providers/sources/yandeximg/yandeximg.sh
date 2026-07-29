#!/usr/bin/env bash
# overcast source provider: yandeximg (Yandex reverse image search via Apify).
# Yandex is the strongest reverse-image engine for faces/places, so this fills
# the gap where only `lens` (Google) exists.
# Bind with:  overcast source add yandeximg:https://example.com/photo.jpg
#             overcast scan --source yandeximg --query ./crops/face_01.jpg
# Key: APIFY_TOKEN (same account as the lens/tiktok sources). The query/ref is an
# image URL or a local image path — relative paths resolve against the cwd, then
# $OVERCAST_MEDIA_DIR, then $OVERCAST_CASE_DIR — and local files are uploaded to
# an Apify key-value store (`overcast-yandeximg`) so the actor can fetch them.
# Emits one hit per matched page, each with `match` ("exact"|"visual"), the
# matched page (`payload.url`), and a thumbnail/page `media.ref` (a base64
# thumbnail is materialized into $OVERCAST_MEDIA_DIR when set; a plain image URL
# is passed straight through for `capture`). --limit caps hits (default 8);
# --since is ignored (reverse-image search has no recency filter).
#
# DEFAULT actor = johnvc/yandex-reverse-image-search on Apify (pay-per-result; its
# image input key is `image_url`). Both the actor AND the image-input key are plain
# overridable constants so any other Yandex reverse-image actor can be swapped in
# without editing the script — no .env entry required for the built-in default:
#   OVERCAST_YANDEX_ACTOR      = <user~actor | actor id>       (default below)
#   OVERCAST_YANDEX_IMAGE_KEY  = <input field for the image url> (default image_url)
# Output field extraction is intentionally defensive (schemas differ by author): it
# tries several common field names for the matched page / title / thumbnail.
# Implements: enumerate --query <image> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
# shared outbound-fetch guard (scheme pinning, bounded redirects, private-address
# refusal on the FINAL hop) — see providers/engines/net/guarded-fetch.sh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../engines/net/guarded-fetch.sh
. "$here/../../engines/net/guarded-fetch.sh"

ACTOR="${OVERCAST_YANDEX_ACTOR:-johnvc~yandex-reverse-image-search}"
IMAGE_KEY="${OVERCAST_YANDEX_IMAGE_KEY:-image_url}"
op="${1:-enumerate}"; shift || true

# short content hash for stable, collision-resistant names (shasum on macOS,
# sha1sum on linux)
h8() { { shasum -a 1 2>/dev/null || sha1sum; } | cut -c1-8; }

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"yandeximg","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=8
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) shift 2 2>/dev/null || shift ;;   # reverse-image search has no recency filter
      *) shift ;;
    esac; done
    # trim surrounding whitespace so a padded URL/path still classifies correctly
    # (a whitespace-only query then trips the empty-query check below), like flights.
    query="${query#"${query%%[![:space:]]*}"}"; query="${query%"${query##*[![:space:]]}"}"
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    if [ -z "$query" ]; then
      echo "yandeximg enumerate needs an image: bind yandeximg:<image-url> or pass --query <url|local path>" >&2
      exit 1
    fi
    case "$limit" in ''|*[!0-9]*) limit=8 ;; esac
    # a non-URL query must resolve to a real image file: try it as given (cwd),
    # then against the case media dir and the case root (crop outputs etc. when
    # scan runs with --case from another cwd). Anything unresolved is an error —
    # never ship a bogus path to the actor as a "URL". URL schemes are
    # case-insensitive (RFC 3986), so match on a lowercased copy.
    case "$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]')" in
      http://*|https://*) : ;;
      *)
        if [ ! -f "$query" ]; then
          for base in "${OVERCAST_MEDIA_DIR:-}" "${OVERCAST_CASE_DIR:-}"; do
            if [ -n "$base" ] && [ -f "$base/$query" ]; then query="$base/$query"; break; fi
          done
        fi
        if [ ! -f "$query" ]; then
          echo "yandeximg: query is neither an existing image file nor an http(s) url: $query" >&2
          exit 1
        fi ;;
    esac
    uploaded=0
    if [ -f "$query" ]; then
      # local image → upload to the account's `overcast-yandeximg` key-value store
      # (get-or-create) under a content-hash key, so repeat scans of the same
      # image reuse one record. The actor fetches it by the public record URL.
      if ! store="$(curl -fsS -m 30 -X POST -H "Authorization: Bearer $APIFY_TOKEN" \
        "https://api.apify.com/v2/key-value-stores?name=overcast-yandeximg")"; then
        echo "yandeximg: could not open the overcast-yandeximg key-value store on Apify" >&2; exit 1
      fi
      sid="$(printf '%s' "$store" | jq -r '.data.id // empty')"
      [ -n "$sid" ] || { echo "yandeximg: unexpected key-value-store response from Apify" >&2; exit 1; }
      ext="$(printf '%s' "${query##*.}" | tr '[:upper:]' '[:lower:]')"
      case "$ext" in
        jpg|jpeg) ct="image/jpeg" ;;
        png)      ct="image/png" ;;
        webp)     ct="image/webp" ;;
        gif)      ct="image/gif" ;;
        *) echo "yandeximg: unsupported image type '.$ext' (jpg|jpeg|png|webp|gif)" >&2; exit 1 ;;
      esac
      key="img_$(h8 <"$query").$ext"
      if ! curl -fsS -m 60 -X PUT -H "Authorization: Bearer $APIFY_TOKEN" \
        "https://api.apify.com/v2/key-value-stores/$sid/records/$key" \
        -H "content-type: $ct" --data-binary @"$query" >/dev/null; then
        echo "yandeximg: image upload to Apify failed for $query" >&2; exit 1
      fi
      query="https://api.apify.com/v2/key-value-stores/$sid/records/$key"
      uploaded=1
    fi
    # send the image url under the actor's input key (IMAGE_KEY — default image_url
    # for the built-in actor; set OVERCAST_YANDEX_IMAGE_KEY for an actor that differs).
    input="$(jq -nc --arg u "$query" --arg k "$IMAGE_KEY" '{($k):$u}')"
    # -f fails the request on HTTP errors so Apify error JSON isn't parsed as hits
    if ! run="$(curl -fsS -m 240 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "yandeximg enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "yandeximg enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # normalize each dataset item defensively — try common field names for the
    # matched page url / title / thumbnail / match kind, and keep only items that
    # carry a real absolute http(s) page link (an actionable, fetchable hit).
    if ! items="$(printf '%s' "$run" | jq -c --argjson n "$limit" --arg self "$query" '
      def canon: (if type == "string" then . else "" end) | ascii_downcase | sub("^https?://";"") | sub("[?#].*$";"") | sub("/+$";"");
      [ .[]
        | ($self | canon) as $selfc
        # never echo the submitted query image back as a hit. Pick PAGE as the first
        # candidate field that is a real http URL AND does NOT canonically match the
        # probe — so if the actor echoes the probe in an early field (.url) but puts
        # the real match in a later one (.link/.pageUrl), we USE the real match rather
        # than dropping the whole row. Canonical compare is case-folded + scheme- and
        # trailing-slash-insensitive.
        | { page:  ([.url, .link, .pageUrl, .sourceUrl, .documentUrl, .href]
                    | map(select(type == "string" and (ascii_downcase | startswith("http")) and (canon != $selfc)))
                    | (.[0] // "")),
            title: (.title // .name // .description // ""),
            thumb: (.thumbnail // .thumbnailUrl // .img // ""),
            snippet: (.description // .snippet // .text // ""),
            match: (.matchType // .match // "visual"),
            site:  (.displayLink // .source // .domain // null) }
        # blank a THUMB (which becomes media.ref) that echoes the probe so
        # capture/--pull cannot fetch the query image back.
        | (if (.thumb | canon) == $selfc then .thumb = "" else . end)
        | select(.page != "") ]
      | .[0:$n]')"; then
      echo "yandeximg: failed to normalize actor output for '$query'" >&2
      exit 1
    fi
    n="$(printf '%s' "$items" | jq 'length')"
    hits="[]"
    i=0
    while [ "$i" -lt "$n" ]; do
      item="$(printf '%s' "$items" | jq -c ".[$i]")"
      thumb_src="$(printf '%s' "$item" | jq -r '.thumb // ""')"
      ref=""         # media.ref candidate — ONLY a probe-excluded http(s) thumb url
      thumb_file=""  # a materialized base64 preview — attached as thumbnail_path only
      case "$thumb_src" in
        data:image/*\;base64,*)
          # a base64 thumbnail is an inline preview the actor chose to embed; unlike a
          # url thumb it cannot be canon-compared to the probe, so it may be the query
          # image echoed back on an otherwise-real page. Materialize it for DISPLAY
          # (thumbnail_path) but NEVER promote it to media.ref: capture/--pull ingest
          # media.ref, and the submitted image must not become match evidence. media.ref
          # falls back to the (exclusion-checked) page url below.
          if [ -n "${OVERCAST_MEDIA_DIR:-}" ]; then
            mime="${thumb_src#data:image/}"; mime="${mime%%;*}"
            case "$mime" in jpeg) text="jpg" ;; *) text="$mime" ;; esac
            f="$OVERCAST_MEDIA_DIR/yandeximg_$(printf '%s' "$item" | jq -r '.page // ""' | h8).$text"
            if printf '%s' "${thumb_src#*base64,}" | base64 -d >"$f" 2>/dev/null && [ -s "$f" ]; then
              thumb_file="$f"
            else
              rm -f "$f"
            fi
          fi ;;
        http://*|https://*) ref="$thumb_src" ;;   # a plain image url, already probe-excluded → safe as media.ref
      esac
      hit="$(printf '%s' "$item" | jq -c --arg r "$ref" --arg tf "$thumb_file" '
        {title:.title, url:.page, source:"yandeximg", published:null,
         snippet:(if .snippet != "" then .snippet else "reverse image match" end),
         match:.match, site:.site}
        + (if $r != "" then {media:{ref:$r}} else {media:{ref:.page}} end)
        + (if $tf != "" then {thumbnail_path:$tf} else {} end)')"
      hits="$(printf '%s' "$hits" | jq -c --argjson h "$hit" '. + [$h]')"
      i=$((i + 1))
    done
    # a common failure mode: the actor could not FETCH the uploaded image because
    # the Apify account restricts key-value-store access — surface it as a hint
    # (mirrors the lens source) rather than a silent empty result.
    if [ "$uploaded" = "1" ] && printf '%s' "$hits" | jq -e 'length == 0' >/dev/null 2>&1; then
      echo "yandeximg: no matches — if your Apify account restricts storage access, the actor may not be able to fetch the uploaded image ($query)" >&2
    fi
    printf '%s\n' "$hits"
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # a yandeximg hit's ref is a matched page (or a direct image url) — download it
    # and report the kind by content type so pages get an .html name the sense
    # gate won't route to watch/listen.
    if ! ct="$(oc_guarded_fetch "$url" "$out" -m 120)" || [ ! -s "$out" ]; then
      echo "yandeximg fetch failed for $url" >&2
      rm -f "$out"
      exit 1
    fi
    case "$ct" in
      image/*)
        jq -nc --arg p "$out" --arg u "$url" '{kind:"image",path:$p,source:"yandeximg",url:$u}' ;;
      text/html*)
        # don't double the suffix when --out already ends in .html/.htm
        page="$out"
        case "$out" in *.html|*.htm) : ;; *) mv "$out" "${out}.html"; page="${out}.html" ;; esac
        jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"yandeximg",url:$u}' ;;
      *)
        jq -nc --arg p "$out" --arg u "$url" '{kind:"file",path:$p,source:"yandeximg",url:$u}' ;;
    esac
    ;;
  *) echo "yandeximg source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
