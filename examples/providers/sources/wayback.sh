#!/usr/bin/env bash
# overcast source provider: wayback (Internet Archive Wayback Machine — recover
# deleted pages/posts and surface "secret changes" over time). No API key.
#
# Named `wayback`, NOT `archive` — `archive` is overcast's global media-bucket
# verb + `archive:<bucket>/<item>` ref scheme; a source named `archive` would
# collide with it.
#
# Bind with:  overcast source add wayback:https://example.com/page
#             overcast scan   --source wayback --pull        # capture each snapshot
#             overcast monitor --source wayback --every 6h   # watch a page for changes
# Refs / queries: a URL (or bare host/path). enumerate returns one hit per
# DISTINCT archived capture (collapse=digest → only versions that actually
# changed), newest first; each hit's media.ref is the snapshot URL so `capture`
# downloads the archived page.
# Implements: enumerate --query <url> [--limit N] [--since S] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
CDX="https://web.archive.org/cdx/search/cdx"

op="${1:-enumerate}"; shift || true

case "$op" in
  init)     exit 0 ;;  # no credentials to check
  describe) echo '{"source":"wayback","emits":"scan.hit","needs":[]}'; exit 0 ;;

  enumerate)
    query=""; limit=20; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    # trim surrounding whitespace so a padded URL still classifies as http(s) and the
    # CDX `url=` param isn't offset by a leading space (a whitespace-only query then
    # trips the empty check) — consistent with the other sources.
    query="${query#"${query%%[![:space:]]*}"}"; query="${query%"${query##*[![:space:]]}"}"
    if [ -z "$query" ]; then
      echo "wayback enumerate needs a url: bind wayback:<url> or pass --query" >&2
      exit 1
    fi
    # sane bounds; the CDX server can return thousands of rows for a busy URL.
    case "$limit" in ''|*[!0-9]*) limit=20 ;; esac
    [ "$limit" -gt 500 ] 2>/dev/null && limit=500
    [ "$limit" -lt 1 ] 2>/dev/null && limit=1

    # honor --since → &from=YYYYMMDDHHMMSS (UTC). Portable epoch→stamp:
    # BSD date uses `-r <epoch>`, GNU date uses `-d @<epoch>` (mirrors gdelttv.sh).
    fromparam=""
    if [ -n "$since" ]; then
      now="$(date -u +%s)"; cutepoch=""
      case "$since" in
        *[0-9]s) cutepoch=$(( now - 10#${since%s} )) ;;
        *[0-9]m) cutepoch=$(( now - 10#${since%m} * 60 )) ;;
        *[0-9]h) cutepoch=$(( now - 10#${since%h} * 3600 )) ;;
        *[0-9]d) cutepoch=$(( now - 10#${since%d} * 86400 )) ;;
        *[0-9]w) cutepoch=$(( now - 10#${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cutepoch="$(date -u -d "$since" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d' "$since" +%s 2>/dev/null || echo '')" ;;
        # an unparseable --since is a hard error (fail closed): don't silently
        # widen to the full history, returning far older snapshots than requested.
        *) echo "wayback: could not parse --since '$since' (use Ns/Nm/Nh/Nd/Nw or YYYY-MM-DD)" >&2; exit 1 ;;
      esac
      [ -n "$cutepoch" ] || { echo "wayback: could not parse --since '$since'" >&2; exit 1; }
      stamp="$(date -u -r "$cutepoch" +%Y%m%d%H%M%S 2>/dev/null || date -u -d "@$cutepoch" +%Y%m%d%H%M%S 2>/dev/null || echo '')"
      [ -n "$stamp" ] || { echo "wayback: could not format --since '$since' into a CDX timestamp" >&2; exit 1; }
      fromparam="&from=$stamp"
    fi

    q="$(jq -rn --arg q "$query" '$q|@uri')"
    # collapse=digest → only captures whose content digest changed (the "secret
    # changes" view). limit=-N → the LAST N matches (most recent). fl fixes the
    # column order so we can index rows positionally.
    url="$CDX?url=$q&output=json&fl=timestamp,original,mimetype,statuscode,digest&collapse=digest&limit=-$limit$fromparam"
    if ! run="$(curl -fsS -m 60 "$url")"; then
      echo "wayback enumerate request failed for '$query'" >&2; exit 1
    fi
    # CDX returns a JSON array: row 0 is the field header, rows 1.. are captures;
    # ZERO matches come back as `[]` (no header) → maps to []. A non-array body
    # (e.g. an HTML error page) is a failure.
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "wayback enumerate: unexpected response: $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    printf '%s' "$run" | jq -c '
      if (length > 1) then
        [ .[1:][]
          | { ts: .[0], original: .[1], mimetype: .[2], status: .[3], digest: .[4] }
        ] | reverse | map(
          (.ts) as $ts
          | ($ts[0:4] + "-" + $ts[4:6] + "-" + $ts[6:8] + "T" + $ts[8:10] + ":" + $ts[10:12] + ":" + $ts[12:14] + "Z") as $iso
          | ("https://web.archive.org/web/" + $ts + "/" + .original) as $snap
          | {
              title: (.original + " @ " + ($iso[0:10])),
              url: $snap,
              source: "wayback",
              published: $iso,
              snippet: ("HTTP " + (.status // "?") + " · " + (.mimetype // "")),
              status: (.status // null),
              mimetype: (.mimetype // null),
              digest: (.digest // null),
              timestamp: $ts,
              media: { ref: $snap }
            }
        )
      else [] end'
    ;;

  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$url" ] || { echo "wayback fetch needs --url" >&2; exit 1; }
    # a hit's ref is a Wayback snapshot URL — usually an archived HTML page, but a
    # snapshot can also be an image/pdf. Follow redirects (Wayback redirects to the
    # exact capture) and report the kind by content type (overcast sniffs a missing
    # extension). No -f: an archived 404/500 page is still evidence worth keeping.
    if ! ct="$(curl -sSL -m 180 -o "$out" -w '%{content_type}' "$url")" || [ ! -s "$out" ]; then
      echo "wayback fetch failed for $url" >&2; rm -f "$out"; exit 1
    fi
    case "$ct" in
      image/*)          kind="image" ;;
      video/*)          kind="video" ;;
      text/html*|"")    kind="page" ;;
      *)                kind="file" ;;
    esac
    jq -nc --arg p "$out" --arg k "$kind" --arg u "$url" '{kind:$k,path:$p,source:"wayback",url:$u}'
    ;;

  *) echo "wayback source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
