#!/usr/bin/env bash
# overcast source provider: phone (reverse phone / number OSINT via Apify —
# PhoneInfoga, datacach/phoneinfoga-phone-number-osint-scanner). Given a number,
# return the parsed number info (country / carrier guess / validity) plus a
# grouped web footprint (Google-dork URLs by category). The number→intel twin of
# `person` (name→records).
#
# ⚠️  OPT-IN / SENSITIVE. Number intelligence aggregates data about a real
# subscriber. It is NOT an FCRA consumer report. Accuracy is not guaranteed. Use
# only with authorization. Not enabled by any default; you must bind it.
#
# Bind with:  overcast source add phone:+14155551212
#             overcast scan --source phone
# Key: APIFY_TOKEN. Ref/query is a phone number in E.164 (e.g. +14155551212).
# Actor override: OVERCAST_PHONE_ACTOR
# (default datacach~phoneinfoga-phone-number-osint-scanner).
# `--limit` caps records (normally one number → one intel record); `--since` ignored.
# Implements: enumerate --query <e164> | fetch --url <u> --out <p> | init | describe
set -uo pipefail
ACTOR="${OVERCAST_PHONE_ACTOR:-datacach~phoneinfoga-phone-number-osint-scanner}"

need() {
  if [ -z "${APIFY_TOKEN:-}" ]; then
    echo "phone source needs an Apify token: set APIFY_TOKEN (https://apify.com)" >&2
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"phone","emits":"scan.hit","needs":["APIFY_TOKEN"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""; limit=10
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;   # normally 1 (one number → one record), but cap defensively
      --since) shift 2 2>/dev/null || shift ;;   # no recency axis
      *) shift ;;
    esac; done
    need
    [ -n "$query" ] || { echo "phone enumerate needs a number: bind phone:<E.164> (e.g. phone:+14155551212) or pass --query" >&2; exit 1; }
    input="$(jq -nc --arg p "$query" '{phoneNumbers:[$p], maxConcurrency:1}')"
    if ! run="$(curl -fsS -m 280 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "phone enumerate request failed for '$query'" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "phone enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map → one hit per scanned number. The offline libphonenumber parse lives under
    # .numberInfo / .local (country / carrier guess / validity); .googlesearch is the
    # grouped web footprint. There is no natural media for a phone record, so hits
    # carry no media.ref (metadata evidence). Field names vary across actor versions.
    # Capped to --limit like every other source (default 1 number → 1 record, but a
    # custom OVERCAST_PHONE_ACTOR could return more).
    jq -c --argjson n "$limit" '
      [ .[]
        | (.numberInfo // {}) as $ni
        | (.local // {}) as $lo
        | ((.phoneNumber // $ni.e164 // $ni.E164 // "") | tostring) as $num
        | select(($num | length) > 0)
        | {
            title: $num,
            url: "",
            source: "phone",
            published: null,
            snippet: ([ ($ni.carrier // ""),
                        ($ni.country // $ni.countryName // $lo.country // ($ni.countryCode // "" | tostring)) ]
                      | map(select(. != "" and . != null)) | join(" · ")),
            e164: ($ni.e164 // $ni.E164 // $num),
            carrier: ($ni.carrier // null),
            country: ($ni.country // $ni.countryName // $lo.country // null),
            country_code: ($ni.countryCode // null),
            valid: ($ni.valid // $lo.valid // null),
            local_format: ($ni.local // $ni.localFormat // $lo.localFormat // null),
            international_format: ($ni.international // $ni.internationalFormat // null),
            footprint: (.googlesearch // null),
            caveat: "phone OSINT — offline parse + public web footprint; NOT an FCRA report; corroborate before acting; authorized use only"
          } ] | .[0:$n]' <<<"$run"
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    [ -n "$url" ] || { echo "phone fetch needs --url" >&2; exit 1; }
    # phone hits carry no media by default; this fetch banks a footprint URL as a
    # page when one is captured manually. Non-2xx is a real error.
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"phone",url:$u}'
    else
      echo "phone fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;
  *) echo "phone source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
