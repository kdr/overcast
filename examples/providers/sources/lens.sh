#!/usr/bin/env bash
# overcast source provider: lens (Google Lens reverse image search via Apify).
# Bind with:  overcast source add lens:https://example.com/photo.jpg
#             overcast scan --source lens --query ./crops/face_01.jpg
# Key: APIFY_TOKEN (same account as the tiktok source). The query/ref is an
# image URL or a local image path — relative paths resolve against the cwd,
# then $OVERCAST_MEDIA_DIR, then $OVERCAST_CASE_DIR — and local files are
# uploaded to an Apify key-value store (`overcast-lens`) so the actor can
# fetch them.
# Emits one hit per matched page: exact matches (match:"exact", with the match
# thumbnail materialized into $OVERCAST_MEDIA_DIR when set) and visually
# similar pages (match:"visual"). --limit applies per match type (default 8).
# --since is ignored: Lens has no recency filter. Actor override:
# OVERCAST_LENS_ACTOR (default borderline~google-lens).
# Implements: enumerate --query <image> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
ACTOR="${OVERCAST_LENS_ACTOR:-borderline~google-lens}"
op="${1:-enumerate}"; shift || true

# short content hash for stable, collision-resistant names (shasum on macOS,
# sha1sum on linux)
h8() { { shasum -a 1 2>/dev/null || sha1sum; } | cut -c1-8; }

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"lens","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=8
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    if [ -z "$query" ]; then
      echo "lens enumerate needs an image: bind lens:<image-url> or pass --query <url|local path>" >&2
      exit 1
    fi
    # a non-URL query must resolve to a real image file: try it as given (cwd),
    # then against the case media dir and the case root (crop outputs etc. when
    # scan runs with --case from another cwd). Anything unresolved is an error —
    # never ship a bogus path to the actor as a "URL".
    case "$query" in
      http://*|https://*) : ;;
      *)
        if [ ! -f "$query" ]; then
          for base in "${OVERCAST_MEDIA_DIR:-}" "${OVERCAST_CASE_DIR:-}"; do
            if [ -n "$base" ] && [ -f "$base/$query" ]; then query="$base/$query"; break; fi
          done
        fi
        if [ ! -f "$query" ]; then
          echo "lens: query is neither an existing image file nor an http(s) url: $query" >&2
          exit 1
        fi ;;
    esac
    uploaded=0
    if [ -f "$query" ]; then
      # local image → upload to the account's `overcast-lens` key-value store
      # (get-or-create) under a content-hash key, so repeat scans of the same
      # image reuse one record. The actor fetches it by the public record URL.
      if ! store="$(curl -fsS -m 30 -X POST "https://api.apify.com/v2/key-value-stores?token=$APIFY_TOKEN&name=overcast-lens")"; then
        echo "lens: could not open the overcast-lens key-value store on Apify" >&2; exit 1
      fi
      sid="$(printf '%s' "$store" | jq -r '.data.id // empty')"
      [ -n "$sid" ] || { echo "lens: unexpected key-value-store response from Apify" >&2; exit 1; }
      ext="$(printf '%s' "${query##*.}" | tr '[:upper:]' '[:lower:]')"
      case "$ext" in
        jpg|jpeg) ct="image/jpeg" ;;
        png)      ct="image/png" ;;
        webp)     ct="image/webp" ;;
        gif)      ct="image/gif" ;;
        *) echo "lens: unsupported image type '.$ext' (jpg|jpeg|png|webp|gif)" >&2; exit 1 ;;
      esac
      key="img_$(h8 <"$query").$ext"
      if ! curl -fsS -m 60 -X PUT "https://api.apify.com/v2/key-value-stores/$sid/records/$key?token=$APIFY_TOKEN" \
        -H "content-type: $ct" --data-binary @"$query" >/dev/null; then
        echo "lens: image upload to Apify failed for $query" >&2; exit 1
      fi
      query="https://api.apify.com/v2/key-value-stores/$sid/records/$key"
      uploaded=1
    fi
    input="$(jq -nc --arg u "$query" '{searchTypes:["exact-match","visual-match"],imageUrls:[{url:$u}]}')"
    # -f fails the request on HTTP errors so Apify error JSON isn't parsed as hits
    if ! run="$(curl -fsS -m 240 -X POST \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "lens enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "lens enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # exact matches: identical-image pages. The actor inlines each match's
    # thumbnail as a base64 data URI — materialize it into the case media dir
    # (when the harness passes one) and point media.ref at the file, so the
    # record stays light and the matched image is real evidence on disk.
    # (the actor pads a matchless type with one all-empty item — a hit without
    # a page link isn't actionable evidence, so drop those)
    exact="$(printf '%s' "$run" | jq -c --argjson n "$limit" \
      '[.[]["exact-match"] | select(. != null) | .results[]
        | select((.link // "") != "")] | .[0:$n]')"
    exact_hits="[]"
    n="$(printf '%s' "$exact" | jq 'length')"
    i=0
    while [ "$i" -lt "$n" ]; do
      item="$(printf '%s' "$exact" | jq -c ".[$i]")"
      thumb=""
      if [ -n "${OVERCAST_MEDIA_DIR:-}" ]; then
        b64="$(printf '%s' "$item" | jq -r '.thumbnail // ""')"
        case "$b64" in
          data:image/*\;base64,*)
            mime="${b64#data:image/}"; mime="${mime%%;*}"
            case "$mime" in jpeg) text="jpg" ;; *) text="$mime" ;; esac
            f="$OVERCAST_MEDIA_DIR/lens_$(printf '%s' "$item" | jq -r '.link // ""' | h8).$text"
            if printf '%s' "${b64#*base64,}" | base64 -d >"$f" 2>/dev/null && [ -s "$f" ]; then
              thumb="$f"
            else
              rm -f "$f"
            fi ;;
        esac
      fi
      hit="$(printf '%s' "$item" | jq -c --arg t "$thumb" '
        {title:(.title // ""), url:(.link // ""), source:"lens", published:null,
         snippet:("exact image match" + (if (.source // "") != "" then " on " + .source else "" end)),
         match:"exact", site:(.source // null), position:(.position // null),
         image_size:(.imageSize // null), input_image:(.inputUrl // null)}
        + (if $t != "" then {thumbnail_path:$t, media:{ref:$t}}
           elif (.link // "") != "" then {media:{ref:.link}} else {} end)')"
      exact_hits="$(printf '%s' "$exact_hits" | jq -c --argjson h "$hit" '. + [$h]')"
      i=$((i + 1))
    done
    # visual matches: similar-but-not-identical pages. Drop relative Google
    # in-app links; keep only real webpage hrefs.
    visual_hits="$(printf '%s' "$run" | jq -c --argjson n "$limit" \
      '[.[]["visual-match"] | select(. != null) | .results[].search
        | select((.href // "") | startswith("http"))]
       | .[0:$n]
       | map({title:(.title // ""), url:.href, source:"lens", published:null,
              snippet:(.description // ""), match:"visual", media:{ref:.href}})')"
    hits="$(jq -nc --argjson e "$exact_hits" --argjson v "$visual_hits" '$e + $v')"
    if [ "$(printf '%s' "$hits" | jq 'length')" -eq 0 ] && [ "$uploaded" -eq 1 ]; then
      echo "lens: no matches — if your Apify account restricts storage access, the actor may not be able to fetch the uploaded image ($query)" >&2
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
    # a lens hit's ref is a matched page (or a direct image url) — download it
    # and report the kind by content type so pages get an .html name the sense
    # gate won't route to watch/listen.
    if ! ct="$(curl -fsSL -m 120 -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
      echo "lens fetch failed for $url" >&2
      rm -f "$out"
      exit 1
    fi
    case "$ct" in
      image/*)
        jq -nc --arg p "$out" --arg u "$url" '{kind:"image",path:$p,source:"lens",url:$u}' ;;
      text/html*)
        mv "$out" "${out}.html"
        jq -nc --arg p "${out}.html" --arg u "$url" '{kind:"page",path:$p,source:"lens",url:$u}' ;;
      *)
        jq -nc --arg p "$out" --arg u "$url" '{kind:"file",path:$p,source:"lens",url:$u}' ;;
    esac
    ;;
  *) echo "lens source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
