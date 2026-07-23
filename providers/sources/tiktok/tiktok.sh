#!/usr/bin/env bash
# overcast source provider: tiktok (Apify clockworks/tiktok-scraper).
# Bind with:  overcast source add tiktok:@user
#             OVERCAST_SOURCE_TIKTOK_CMD="bash providers/sources/tiktok.sh"
# Implements: enumerate --query <user|#tag> [--limit N]  |  fetch --url <u> --out <p>
set -euo pipefail
op="${1:-enumerate}"; shift || true
ACTOR="clockworks~tiktok-scraper"

# yt-dlp fetches honor OVERCAST_YTDLP_CMD (binary/wrapper override) and
# OVERCAST_YTDLP_ARGS (extra flags for every call, e.g. --referer/--impersonate
# for TLS-fingerprinting hosts). Both whitespace-split via `read -a` — never an
# unquoted expansion, so glob chars in a referer/UA token stay literal. Script
# flags come after the extras so the -o artifact contract wins on conflict.
run_ytdlp() {
  local -a ytcmd ytargs
  read -r -a ytcmd <<<"${OVERCAST_YTDLP_CMD:-yt-dlp}"
  read -r -a ytargs <<<"${OVERCAST_YTDLP_ARGS:-}"
  # ${arr[@]+…} guards the empty-array expansion (bash 3.2 + set -u errors on it)
  "${ytcmd[@]}" ${ytargs[@]+"${ytargs[@]}"} "$@"
}
have_ytdlp() {
  local -a ytcmd
  read -r -a ytcmd <<<"${OVERCAST_YTDLP_CMD:-yt-dlp}"
  # single token → `command -v` (no spawn); wrapper form ("bash /path/yt-dlp") →
  # execute `--version` so a bad script path fails the check instead of erroring
  # mid-fetch (a first-token check only proves the interpreter exists).
  if [ "${#ytcmd[@]}" -gt 1 ]; then
    "${ytcmd[@]}" --version >/dev/null 2>&1
  else
    command -v "${ytcmd[0]}" >/dev/null 2>&1
  fi
}

case "$op" in
  init)
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN (https://apify.com)" >&2; exit 13; }
    exit 0 ;;
  describe)
    echo '{"source":"tiktok","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
  enumerate)
    query=""; limit=20; since=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) since="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "${APIFY_TOKEN:-}" ] || { echo "set APIFY_TOKEN" >&2; exit 13; }
    # honor --since with a client-side cutoff (the actor has no portable date
    # param): cut = epoch before which posts are dropped. 0 = no filter.
    cut=0
    if [ -n "$since" ]; then
      now="$(date +%s)"
      # compute the cutoff in SECONDS so sub-day units (30m, 12h) aren't lost to
      # integer day division.
      case "$since" in
        *[0-9]m) cut=$(( now - ${since%m} * 60 )) ;;
        *[0-9]h) cut=$(( now - ${since%h} * 3600 )) ;;
        *[0-9]d) cut=$(( now - ${since%d} * 86400 )) ;;
        *[0-9]w) cut=$(( now - ${since%w} * 604800 )) ;;
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
          cut="$(date -d "$since" +%s 2>/dev/null || date -j -f '%Y-%m-%d %H:%M:%S' "$since 00:00:00" +%s 2>/dev/null || echo 0)" ;;
        *) cut=0 ;;
      esac
    fi
    # a `#tag` ref scrapes a hashtag (actor's `hashtags` field); otherwise a
    # profile/user. Strip a leading '#'/'@' for the field value.
    # build the body with jq so a query containing " or \ can't break the JSON
    case "$query" in
      \#*) input="$(jq -nc --arg t "${query#\#}" --argjson n "$limit" '{hashtags:[$t],resultsPerPage:$n}')" ;;
      *)   input="$(jq -nc --arg p "${query#@}" --argjson n "$limit" '{profiles:[$p],resultsPerPage:$n}')" ;;
    esac
    # -f fails the request on HTTP errors so Apify error JSON isn't parsed as
    # hits; -m stays under the harness's Apify run-sync budget (the endpoint
    # holds up to 300s) so a slow run fails here with a clear message.
    if ! run=$(curl -fsS -m 280 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input"); then
      echo "tiktok enumerate request failed for '$query'" >&2; exit 1
    fi
    # Apify returns a JSON array on success; anything else (an error object) is a failure
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "tiktok enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    jq -c --argjson cut "$cut" '[.[]
        | select($cut == 0 or (.createTime // 0) >= $cut)
        | {title:.text, url:.webVideoUrl, source:"tiktok",
           published:.createTimeISO, snippet:.text,
           author:(.authorMeta.name? // null),
           views:(.playCount // null),
           duration:(.videoMeta.duration? // null),
           thumb:(.videoMeta.coverUrl? // .covers.default? // null),
           media:{ref:.webVideoUrl}}]' <<<"$run" ;;
  fetch)
    # enumerate uses Apify, but fetch downloads with yt-dlp — verify it's present
    # so a capture fails clearly instead of erroring mid-download.
    if ! have_ytdlp; then
      echo "tiktok fetch needs yt-dlp on PATH (enumerate uses APIFY_TOKEN; fetch uses yt-dlp)" >&2
      exit 13
    fi
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    if run_ytdlp -o "$out" "$url" >&2; then
      # yt-dlp may append an extension; resolve the actual file written (newest
      # match first, so a stale sibling can't be picked over the fresh download)
      real="$out"; [ -f "$out" ] || real="$(ls -t "${out%.*}".* 2>/dev/null | head -1)"
      if [ -z "$real" ] || [ ! -s "$real" ]; then
        echo "tiktok fetch produced no file for $url" >&2; exit 1
      fi
      jq -nc --arg p "$real" '{kind:"video",path:$p,source:"tiktok"}'
    else
      echo "tiktok fetch failed for $url" >&2; exit 1
    fi ;;
  *) echo "tiktok source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
