#!/usr/bin/env bash
# overcast source provider: username (social/forum account discovery via Apify —
# Maigret, ntriqpro/maigret-actor). Given a username, find where it is registered
# across 3000+ sites (social networks, forums, dev platforms) and pull each
# profile URL + any name/bio/avatar the site exposes. The username-OSINT twin of
# `facesearch` (finds a face) and `lens` (finds an image).
#
# ⚠️  OPT-IN / SENSITIVE. Account discovery aggregates a real person's online
# footprint. Use only with authorization, on subjects you are permitted to
# investigate. Not enabled by any default; you must bind it.
#
# Bind with:  overcast source add username:johndoe
#             overcast scan --source username --query janedoe --pull
# Key: APIFY_TOKEN. Ref/query is a bare username (a leading @ is stripped).
# Actor override: OVERCAST_MAIGRET_ACTOR (default ntriqpro~maigret-actor).
# Breadth:  OVERCAST_MAIGRET_TOPSITES (default 500; 0 = all 3000+ sites, slower).
# `--limit` caps the number of FOUND accounts returned; `--since` is ignored
# (account discovery has no recency axis).
# Implements: enumerate --query <username> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
ACTOR="${OVERCAST_MAIGRET_ACTOR:-ntriqpro~maigret-actor}"
TOPSITES="${OVERCAST_MAIGRET_TOPSITES:-500}"

need() {
  if [ -z "${APIFY_TOKEN:-}" ]; then
    echo "username source needs an Apify token: set APIFY_TOKEN (https://apify.com)" >&2
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"username","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""; limit=25
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) shift 2 2>/dev/null || shift ;;   # account discovery has no recency filter
      *) shift ;;
    esac; done
    need
    query="${query#@}"   # tolerate a leading @
    [ -n "$query" ] || { echo "username enumerate needs a username: bind username:<handle> or pass --query" >&2; exit 1; }
    input="$(jq -nc --arg u "$query" --argjson top "$TOPSITES" '{username:$u, topSites:$top}')"
    if ! run="$(curl -fsS -m 280 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "username enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "username enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map found accounts → hits. Field names vary across Maigret actor versions, so
    # extract defensively. Keep only CLAIMED/found accounts carrying a profile URL
    # (drop the actor's "Not Found"/"Unknown"/"available" probe rows). media.ref is
    # the profile page so `capture`/--pull banks it as evidence. Each hit carries a
    # person-OSINT caveat.
    jq -c --argjson n "$limit" '
      [ .[]
        | (.profileUrl // .url // .link // "") as $url
        | ((.status // .statusText // "claimed") | tostring) as $st
        | select(($url | length) > 0)
        # drop only EXACT negative statuses — anchored so "unavailable" is not caught
        # by "available", nor "no_error" by "error" (keep everything else, incl. claimed)
        | select(($st | ascii_downcase) | test("^(not.?found|unknown|error|available)$") | not)
        | {
            title: ((.siteName // .site // .name // "account") | tostring | .[0:120]),
            url: $url,
            source: "username",
            published: null,
            snippet: ((.bio // .description // "") | tostring | gsub("\\s+"; " ") | .[0:200]),
            author: (.fullName // .name // null),
            site: (.siteName // .site // null),
            account_status: $st,
            location: (.location // null),
            image: (.image // .avatar // null),
            tags: (.tags // null),
            caveat: "person OSINT — social/footprint aggregation; corroborate identity before acting; authorized use only",
            media: { ref: $url }
          } ] | .[0:$n]' <<<"$run"
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    [ -n "$url" ] || { echo "username fetch needs --url" >&2; exit 1; }
    # bank the profile page as evidence; a non-2xx is a real fetch error, not a
    # fake-clean capture. Don't double the suffix when --out already ends in html.
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"username",url:$u}'
    else
      echo "username fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;
  *) echo "username source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
