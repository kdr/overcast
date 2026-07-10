#!/usr/bin/env bash
# overcast source provider: person (people-search / skip-trace via Apify —
# apivault_labs/skip-trace-people-finder). Given a name (and optional location),
# return public-records rollups: current + prior addresses, phone numbers, emails,
# aliases, relatives, and age. The name→records twin of `username`
# (username→accounts) and `phone` (number→footprint).
#
# ⚠️  OPT-IN / SENSITIVE. People-search aggregates a real person's public records.
# It is NOT an FCRA consumer report — do not use it for employment, credit,
# tenant, or insurance decisions. Accuracy is not guaranteed; corroborate before
# acting. Use only with authorization. Not enabled by any default; you must bind it.
#
# Bind with:  overcast source add 'person:Jane Doe'
#             overcast source add 'person:Jane Doe@Dallas, TX'   # location hint
#             overcast scan --source person --limit 5
# Key: APIFY_TOKEN. Ref/query is a full name, with an optional "@<location>" hint
# (a state, city+state, or full street address) to disambiguate.
# Actor override: OVERCAST_PERSON_ACTOR (default apivault_labs~skip-trace-people-finder).
# `--limit` caps records returned; `--since` is ignored (records have no recency axis).
# Implements: enumerate --query "<Full Name[@location]>" [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail
ACTOR="${OVERCAST_PERSON_ACTOR:-apivault_labs~skip-trace-people-finder}"

need() {
  if [ -z "${APIFY_TOKEN:-}" ]; then
    echo "person source needs an Apify token: set APIFY_TOKEN (https://apify.com)" >&2
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"person","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""; limit=10
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) shift 2 2>/dev/null || shift ;;   # public records have no recency filter
      *) shift ;;
    esac; done
    need
    [ -n "$query" ] || { echo "person enumerate needs a name: bind 'person:<Full Name>' (optional '@<location>') or pass --query" >&2; exit 1; }
    # split an optional "@<location>" hint (state / city+state / street address).
    loc=""; name="$query"
    case "$query" in *@*) loc="${query##*@}"; name="${query%@*}" ;; esac
    name="$(printf '%s' "$name" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    loc="$(printf '%s' "$loc" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$name" ] || { echo "person: empty name in '$query'" >&2; exit 1; }
    # actor input: name is an array of full-name strings; a location hint rides in
    # street_citystatezip; source:auto merges the actor's data sources.
    input="$(jq -nc --arg n "$name" --arg loc "$loc" --argjson max "$limit" \
      '{name:[$n], max_results:$max, source:"auto"} + (if $loc != "" then {street_citystatezip:[$loc]} else {} end)')"
    if ! run="$(curl -fsS -m 280 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "person enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "person enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map matched people → hits (one per person). The actor prepends non-person rows
    # (a compliance `notice`, a `review-request`) — drop anything whose recordType is
    # set, and require an identity (a name). Field names extracted defensively.
    jq -c --argjson n "$limit" '
      [ .[]
        | select((.recordType // null) == null)
        | ((.name // .fullName // "") | tostring) as $nm
        | select(($nm | length) > 0)
        | ((.profileUrl // .url // "") | tostring) as $url
        | {
            title: ($nm | .[0:120]),
            url: $url,
            source: "person",
            published: null,
            snippet: ([ (if (.age // null) != null then "age " + ((.age)|tostring) else "" end),
                        ((.currentAddress // "") | tostring) ]
                      | map(select(. != "")) | join(" · ")),
            full_name: $nm,
            age: (.age // null),
            born: (.born // null),
            phones: (.phones // .phonesE164 // []),
            best_phone: (.bestPhone // null),
            emails: (.emails // []),
            best_email: (.bestEmail // null),
            current_address: (.currentAddress // null),
            past_addresses: (.previousAddresses // .pastAddresses // []),
            aliases: (.aliases // []),
            relatives: (.relatives // []),
            confidence: (.confidence // .matchConfidence // null),
            caveat: "people-search / public records — NOT an FCRA report (no employment/credit/tenant use); accuracy not guaranteed; authorized use only"
          }
        | (if $url != "" then . + {media:{ref:$url}} else . end)
      ] | .[0:$n]' <<<"$run"
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    [ -n "$url" ] || { echo "person fetch needs --url" >&2; exit 1; }
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"person",url:$u}'
    else
      echo "person fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;
  *) echo "person source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
