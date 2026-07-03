#!/usr/bin/env bash
# overcast source provider: facesearch (reverse FACE search via Apify —
# nkactors/face-search, a multi-engine face finder). Complements `lens` (which
# matches whole images) by finding where a PERSON's face appears online.
#
# ⚠️  OPT-IN / SENSITIVE. Face search queries third-party engines (which may
# include FaceCheck.ID / PimEyes-style indexes) and raises real privacy, ToS,
# and legal considerations. Use only with authorization, on subjects you are
# permitted to investigate. Not enabled by any default; you must bind it.
#
# Bind with:  overcast source add facesearch:https://example.com/face.jpg
#             overcast scan --source facesearch --query ./crops/face_01.jpg
# Key: APIFY_TOKEN. The query/ref is a face IMAGE — an http(s) URL or a local
# image path (relative paths resolve against cwd, then $OVERCAST_MEDIA_DIR, then
# $OVERCAST_CASE_DIR); local files are uploaded to the account's `overcast-lens`
# Apify key-value store so the actor can fetch them.
# Actor override: OVERCAST_FACE_SEARCH_ACTOR (default nkactors~face-search).
# Set OVERCAST_FACE_SEARCH_DEMO=1 for the actor's cheap DEBUG mode (scans only
# ~100k faces — for wiring tests, not real investigations).
# Implements: enumerate --query <image> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
ACTOR="${OVERCAST_FACE_SEARCH_ACTOR:-nkactors~face-search}"
op="${1:-enumerate}"; shift || true

h8() { { shasum -a 1 2>/dev/null || sha1sum; } | cut -c1-8; }

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"facesearch","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=10
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    [ -n "$query" ] || { echo "facesearch enumerate needs a face image: bind facesearch:<image-url> or pass --query <url|local path>" >&2; exit 1; }
    # a non-URL query must resolve to a real image file (cwd, then case media/root)
    case "$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]')" in
      http://*|https://*) : ;;
      *)
        if [ ! -f "$query" ]; then
          for base in "${OVERCAST_MEDIA_DIR:-}" "${OVERCAST_CASE_DIR:-}"; do
            if [ -n "$base" ] && [ -f "$base/$query" ]; then query="$base/$query"; break; fi
          done
        fi
        if [ ! -f "$query" ]; then
          echo "facesearch: query is neither an existing image file nor an http(s) url: $query" >&2
          exit 1
        fi ;;
    esac
    # local image → upload to the account's `overcast-lens` key-value store (shared
    # with the lens source) under a content-hash key; the actor fetches it by URL.
    if [ -f "$query" ]; then
      if ! store="$(curl -fsS -m 30 -X POST "https://api.apify.com/v2/key-value-stores?token=$APIFY_TOKEN&name=overcast-lens")"; then
        echo "facesearch: could not open the overcast-lens key-value store on Apify" >&2; exit 1
      fi
      sid="$(printf '%s' "$store" | jq -r '.data.id // empty')"
      [ -n "$sid" ] || { echo "facesearch: unexpected key-value-store response from Apify" >&2; exit 1; }
      ext="$(printf '%s' "${query##*.}" | tr '[:upper:]' '[:lower:]')"
      case "$ext" in
        jpg|jpeg) ct="image/jpeg" ;; png) ct="image/png" ;; webp) ct="image/webp" ;;
        *) echo "facesearch: unsupported image type '.$ext' (jpg|jpeg|png|webp)" >&2; exit 1 ;;
      esac
      key="face_$(h8 <"$query").$ext"
      if ! curl -fsS -m 60 -X PUT "https://api.apify.com/v2/key-value-stores/$sid/records/$key?token=$APIFY_TOKEN" \
        -H "content-type: $ct" --data-binary @"$query" >/dev/null; then
        echo "facesearch: image upload to Apify failed for $query" >&2; exit 1
      fi
      query="https://api.apify.com/v2/key-value-stores/$sid/records/$key"
    fi
    demo=false; [ "${OVERCAST_FACE_SEARCH_DEMO:-}" = "1" ] && demo=true
    input="$(jq -nc --arg u "$query" --argjson n "$limit" --argjson demo "$demo" \
      '{imageUrl:$u, maxResults:$n, demo:$demo}')"
    if ! run="$(curl -fsS -m 280 -X POST \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "facesearch enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "facesearch enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map matches → hits. Field names vary across face-search actor versions, so
    # extract defensively: page link, thumbnail, score/confidence, engine/source.
    # A match without any page/image link isn't actionable evidence — drop it.
    jq -c --argjson n "$limit" '
      [ .[]
        | (.url // .link // .pageUrl // .page_url // .sourceUrl // "") as $page
        | (.thumbnail // .image // .imageUrl // .thumb // "") as $thumb
        | select(($page | length) > 0 or ($thumb | length) > 0)
        | {
            title: ((.title // .name // "face match") | tostring | .[0:120]),
            url: (if ($page|length)>0 then $page else $thumb end),
            source: "facesearch",
            published: null,
            snippet: ("face match" + (if (.source // .engine // "") != "" then " via " + (.source // .engine) else "" end)),
            match: "face",
            score: (.score // .confidence // .similarity // null),
            engine: (.source // .engine // null),
            thumbnail: (if ($thumb|length)>0 then $thumb else null end),
            media: { ref: (if ($thumb|length)>0 then $thumb else $page end) }
          } ] | .[0:$n]' <<<"$run"
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "facesearch fetch needs --url" >&2; exit 1; }
    # download the match thumbnail/page and report kind by content type (an HTML
    # page gets a .html name so the sense gate won't route it to watch/listen).
    if ! ct="$(curl -fsSL -m 120 -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
      echo "facesearch fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*) jq -nc --arg p "$out" --arg u "$url" '{kind:"image",path:$p,source:"facesearch",url:$u}' ;;
      text/html*)
        page="$out"; case "$out" in *.html|*.htm) : ;; *) mv "$out" "${out}.html"; page="${out}.html" ;; esac
        jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"facesearch",url:$u}' ;;
      *) jq -nc --arg p "$out" --arg u "$url" '{kind:"file",path:$p,source:"facesearch",url:$u}' ;;
    esac
    ;;
  *) echo "facesearch source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
