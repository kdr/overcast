#!/usr/bin/env bash
# overcast source provider: plate (license plate → vehicle spec via a bound Apify
# actor). Given a US plate (+ state), return the vehicle's VIN + year/make/model/
# spec. The plate→vehicle complement of `exif` device fingerprinting.
#
# ⚠️  OPT-IN / SENSITIVE — and DELIBERATELY UNBOUND BY DEFAULT. US plate→vehicle
# data is DPPA-restricted and there is NO reliable public Apify actor for it, so
# this source ships with no default actor: you must bind one yourself. Registered-
# OWNER lookup is legally restricted — expect vehicle SPEC only, not the owner.
# Use only with authorization. Never a default binding.
#
# Bind an actor (or a direct plate API), then bind the source:
#   OVERCAST_PLATE_ACTOR=<user>~<plate-actor>      # an Apify actor taking {plate,state}
#   #  …or a direct plate API (PlateToVIN/CarsXE/VehicleRegistrationAPI):
#   OVERCAST_SOURCE_PLATE_CMD="bash /path/to/your-plate-api.sh"
#   overcast source add plate:CA:7ABC123
#   overcast scan --source plate
# Key: APIFY_TOKEN (+ OVERCAST_PLATE_ACTOR). Ref/query is "<ST>:<plate>" (state
# optional: "plate:7ABC123" also works). The bound actor is called with
# {plate, state, maxItems}; output is parsed defensively (vin/make/model/year).
# `--limit`/`--since` are ignored (one plate → one vehicle).
# Implements: enumerate --query "<ST>:<plate>" | fetch --url <u> --out <p> | init | describe
set -uo pipefail
# shared outbound-fetch guard (scheme pinning, bounded redirects, private-address
# refusal on the FINAL hop) — see providers/engines/net/guarded-fetch.sh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../engines/net/guarded-fetch.sh
. "$here/../../engines/net/guarded-fetch.sh"

ACTOR="${OVERCAST_PLATE_ACTOR:-}"

need() {
  if [ -z "${APIFY_TOKEN:-}" ]; then
    echo "plate source needs an Apify token: set APIFY_TOKEN (https://apify.com)" >&2
    exit 13
  fi
  if [ -z "$ACTOR" ]; then
    cat >&2 <<'MSG'
plate source ships with NO default actor — US plate→vehicle data is DPPA-restricted
and no reliable public Apify actor exists. Bind one deliberately:
  • OVERCAST_PLATE_ACTOR=<user>~<plate-actor>   (an Apify actor taking {plate,state})
  • or OVERCAST_SOURCE_PLATE_CMD="…"            (a direct plate API, e.g. PlateToVIN)
Vehicle SPEC only — registered-owner lookup is legally restricted; do not expect it.
MSG
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"plate","emits":"scan.hit","needs":["APIFY_TOKEN","OVERCAST_PLATE_ACTOR"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""; limit=5
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) shift 2 2>/dev/null || shift ;;   # one plate → one vehicle
      *) shift ;;
    esac; done
    need
    [ -n "$query" ] || { echo "plate enumerate needs a plate: bind plate:<ST>:<plate> (or plate:<plate>) or pass --query" >&2; exit 1; }
    # "<ST>:<plate>" → state + plate; a bare "<plate>" leaves state empty. Only
    # treat the pre-colon prefix as a state when it's a valid 2-letter code (real
    # plates have no colon; a US/CA state is exactly two alpha chars) — so a ref like
    # `plate:12:34` keeps the whole value as the plate, not state 12 / plate 34.
    state=""; plate="$query"
    case "$query" in
      *:*)
        pfx="${query%%:*}"
        case "$pfx" in
          [A-Za-z][A-Za-z]) state="$pfx"; plate="${query#*:}" ;;
          *) plate="$query" ;;   # not a 2-letter state → colon belongs to the plate
        esac ;;
    esac
    state="$(printf '%s' "$state" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
    plate="$(printf '%s' "$plate" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
    [ -n "$plate" ] || { echo "plate: empty plate number in '$query'" >&2; exit 1; }
    input="$(jq -nc --arg p "$plate" --arg s "$state" --argjson n "$limit" '{plate:$p, state:$s, maxItems:$n}')"
    if ! run="$(curl -fsS -m 280 -X POST \
      -H "Authorization: Bearer $APIFY_TOKEN" \
      "https://api.apify.com/v2/acts/$ACTOR/run-sync-get-dataset-items" \
      -H 'content-type: application/json' -d "$input")"; then
      echo "plate enumerate request failed for '$query' (check OVERCAST_PLATE_ACTOR input shape)" >&2; exit 1
    fi
    if ! printf '%s' "$run" | jq -e 'type == "array"' >/dev/null 2>&1; then
      echo "plate enumerate: unexpected response (not an array): $(printf '%s' "$run" | head -c 200)" >&2
      exit 1
    fi
    # map → vehicle hits. Actor output shapes vary, so parse VIN/make/model/year
    # defensively. Require a vin/make/model (else it is not an actionable match).
    jq -c --argjson n "$limit" --arg plate "$plate" --arg state "$state" '
      [ .[]
        | ((.vin // .VIN // "") | tostring) as $vin
        | ((.make // .brand // .Make // "") | tostring) as $make
        # keep a vehicle identified by ANY of vin/make/model (not just vin-or-make),
        # so a spec-only actor row (make absent but model present) is not dropped
        | select(($vin | length) > 0 or ($make | length) > 0 or ((.model // .Model // "") | tostring | length) > 0)
        | ((.url // .source_url // "") | tostring) as $url
        | {
            title: ([ ((.year // .modelYear // .Year // "") | tostring), $make, ((.model // .Model // "") | tostring) ]
                    | map(select(. != "" and . != "null")) | join(" ")),
            url: $url,
            source: "plate",
            published: null,
            snippet: $vin,
            plate: (.plate // $plate),
            state: (.state // $state),
            vin: (if $vin != "" then $vin else null end),
            make: (if $make != "" then $make else null end),
            model: (.model // .Model // null),
            year: (.year // .modelYear // .Year // null),
            color: (.color // null),
            body_class: (.bodyClass // .body // null),
            caveat: "vehicle SPEC only — registered-owner data is DPPA-restricted and not returned; authorized use only"
          }
        | (.title |= (if . == "" then "vehicle" else . end))
        | (if $url != "" then . + {media:{ref:$url}} else . end)
      ] | .[0:$n]' <<<"$run"
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    [ -n "$url" ] || { echo "plate fetch needs --url" >&2; exit 1; }
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if oc_guarded_fetch "$url" "$page" -m 60 >/dev/null; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"plate",url:$u}'
    else
      echo "plate fetch failed for $url" >&2; rm -f "$page"; exit 1
    fi
    ;;
  *) echo "plate source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
