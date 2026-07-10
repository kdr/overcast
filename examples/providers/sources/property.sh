#!/usr/bin/env bash
# overcast source provider: property (address → county assessor / tax / recorder
# records via Apify — shelvick/county-property-records). Given a US street
# address, return the parcel rollup: owner, assessed / market value, tax history,
# sale history, and characteristics — normalized across many US counties from
# public government open-data. The address→records complement of `exif`/`map`
# (which geolocate media) and `devices` (which fingerprint cameras).
#
# ⚠️  OPT-IN / SENSITIVE. Property records tie an address to named owners. Public
# records, but privacy-relevant. Use only with authorization. Not enabled by any
# default; you must bind it.
#
# Bind with:  overcast source add 'property:1001 Preston St, Houston, TX 77002'
#             overcast scan --source property
# Key: APIFY_TOKEN. Ref/query is a US street address; include city + state (+ ZIP
# if known) for reliable county routing.
# Actor override: OVERCAST_PROPERTY_ACTOR (default shelvick~county-property-records).
# `--limit`/`--since` are ignored (one address → its parcel record(s)).
# Implements: enumerate --query "<street, city, ST zip>" | fetch --url <u> --out <p> | init | describe
set -uo pipefail
ACTOR="${OVERCAST_PROPERTY_ACTOR:-shelvick~county-property-records}"

need() {
  if [ -z "${APIFY_TOKEN:-}" ]; then
    echo "property source needs an Apify token: set APIFY_TOKEN (https://apify.com)" >&2
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"property","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) shift 2 2>/dev/null || shift ;;   # one address → its parcel record(s)
      --since) shift 2 2>/dev/null || shift ;;   # records have no recency axis
      *) shift ;;
    esac; done
    need
    [ -n "$query" ] || { echo "property enumerate needs an address: bind 'property:<street, city, ST zip>' or pass --query" >&2; exit 1; }
    input="$(jq -nc --arg a "$query" '{addresses:[$a]}')"
    if ! run="$(curl -fsS -m 280 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "property enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "property enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map resolved parcels → hits. Drop not_covered/failed rows and rows carrying an
    # error, and require an identity (owner OR an assessed value). Field names are
    # extracted defensively across county sources. media.ref is the source-of-record
    # page so `capture`/--pull banks it as evidence.
    jq -c '
      [ .[]
        | ((.status // "") | tostring | ascii_downcase) as $st
        | select($st | test("not_covered|failed|error") | not)
        | select(((.error // null) == null) or ((.error // "") == ""))
        | select(((.owner_name // .owner // "") | tostring | length) > 0 or (.assessed_value // null) != null)
        | ((.source_url // .url // "") | tostring) as $url
        | {
            title: ((.situs_address // .address // .owner_name // .owner // "property") | tostring | .[0:120]),
            url: $url,
            source: "property",
            published: null,
            snippet: ([ ("owner " + ((.owner_name // .owner // "?") | tostring)),
                        (if (.assessed_value // null) != null then "assessed " + ((.assessed_value)|tostring) else "" end),
                        (if (.last_sale_date // null) != null then "sold " + ((.last_sale_date)|tostring) else "" end) ]
                      | map(select(. != "" and . != "owner ?")) | join(" · ")),
            owner: (.owner_name // .owner // null),
            assessed_value: (.assessed_value // null),
            market_value: (.market_value // null),
            land_value: (.land_value // null),
            improvement_value: (.improvement_value // null),
            parcel_id: (.parcel_id // .apn // null),
            last_sale: (if (.last_sale_date // null) != null or (.last_sale_price // null) != null
                        then {date:(.last_sale_date // null), price:(.last_sale_price // null)} else null end),
            sale_history: (.sale_history // []),
            tax_year: (.tax_year // null),
            tax_history: (.tax_history // []),
            characteristics: (.characteristics // null),
            situs_address: (.situs_address // .address // null),
            mailing_address: (.mailing_address // null),
            county: (.county // null),
            state: (.state // null),
            caveat: "public property/assessor records; verify against the county source of record; authorized use only"
          }
        | (if $url != "" then . + {media:{ref:$url}} else . end)
      ]' <<<"$run"
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    [ -n "$url" ] || { echo "property fetch needs --url" >&2; exit 1; }
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"property",url:$u}'
    else
      echo "property fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;
  *) echo "property source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
