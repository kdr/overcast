#!/usr/bin/env bash
# overcast source provider: shodan (host / service / banner intelligence via the
# Shodan REST API). Search the internet's exposed hosts by org, network, product,
# port, TLS cert, hostname, country, … or look up a single IP's full service map.
#
# ⚠️  Authorized recon only. Shodan surfaces exposed services, banners, and known
# vulnerabilities of real hosts. Use only against infrastructure you are permitted
# to investigate. Never a default binding — you must bind it.
#
# ⚠️⚠️  SENSITIVE, OPT-IN media extraction. With OVERCAST_SHODAN_SCREENSHOTS set to
# an affirmative value (1/true/yes/on), this provider ALSO materializes the
# SCREENSHOTS Shodan captures from exposed RDP/VNC/X11/HTTP/camera services into the
# case media dir (so `see`/`face`/`crop` can analyze them) and surfaces RTSP
# (port 554) stream endpoints in `payload.stream`. These are the live/near-live
# screens and camera views of REAL, unwitting hosts — pulling them raises serious
# privacy, ToS, and legal considerations. Enabling the flag is your explicit
# acknowledgement that you are authorized to do so. It is OFF by default; without
# it, hits carry only metadata + the shodan.io host page.
#
# Bind with:  overcast source add 'shodan:org:"Example Corp" port:22'
#             overcast source add 'shodan:8.8.8.8'           # single-host lookup
#             overcast scan --source shodan --pull
#             overcast monitor --source shodan --every 6h    # standing exposure watch
#             OVERCAST_SHODAN_SCREENSHOTS=1 overcast scan --source shodan \
#               --query 'has_screenshot:true product:VNC' --pull   # opt-in screenshots
# Refs / queries:
#   <search query>   — Shodan search filters (org: net: ssl: hostname: product:
#                      port: has_screenshot: screenshot.label: …). Bills 1 query
#                      credit per 100 results.
#   <ip>             — a bare IPv4/IPv6 → full host lookup (one hit per service).
# Key: SHODAN_API_KEY (https://account.shodan.io).
# Each hit's media.ref is the shodan.io host report page (or, with the opt-in flag,
# a materialized screenshot); the host intel itself rides in the loose payload.
# Implements: enumerate --query <q> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail

SHODAN="${SHODAN_API_KEY:-}"
API="https://api.shodan.io"

need() {
  if [ -z "$SHODAN" ]; then
    echo "shodan source needs a key: set SHODAN_API_KEY (https://account.shodan.io)" >&2
    exit 13
  fi
}

# OPT-IN gate for the sensitive screenshot / RTSP media extraction (see header).
# OFF unless the operator sets an affirmative value — their acknowledgement that
# they are authorized to pull media from real exposed hosts.
shots_enabled() {
  case "$(printf '%s' "${OVERCAST_SHODAN_SCREENSHOTS:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# Surface a Shodan error body ({"error":"…"}) that arrives with a 2xx status (e.g.
# insufficient query credits) — `curl -f` only catches non-2xx, so without this an
# error JSON would be mapped to zero hits and exit 0 as a fake-clean empty scan.
check_api_error() { # <response-json>
  local e
  e="$(printf '%s' "$1" | jq -r '.error // empty' 2>/dev/null)"
  [ -z "$e" ] || { echo "shodan API error: $e" >&2; exit 1; }
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"shodan","emits":"scan.hit","needs":["SHODAN_API_KEY"],"optional_env":["OVERCAST_SHODAN_SCREENSHOTS (opt-in: materialize exposed-host screenshots + RTSP endpoints — sensitive)"]}'; exit 0 ;;
esac

case "$op" in
  enumerate)
    query=""; limit=10
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) limit="${2:-}"; shift 2 2>/dev/null || shift ;;
      --since) shift 2 2>/dev/null || shift ;;   # Shodan search has no recency filter
      *) shift ;;
    esac; done
    need
    [ -n "$query" ] || { echo "shodan enumerate needs a query: bind shodan:'<search query>' or shodan:<ip>" >&2; exit 1; }

    # A bare IP (no spaces) → host lookup; anything else → search. IPv4 = digits
    # and dots only; IPv6 = hex and colons with ≥2 colons (so a `port:22`-style
    # single-colon filter is NOT mistaken for a host).
    is_ip=0
    case "$query" in
      *' '*) : ;;
      *.*.*.*) case "$query" in *[!0-9.]*) : ;; *) is_ip=1 ;; esac ;;
      *:*:*)   case "$query" in *[!0-9A-Fa-f:]*) : ;; *) is_ip=1 ;; esac ;;
    esac

    if [ "$is_ip" -eq 1 ]; then
      # URL-encode the IP for the path segment — an IPv6's colons must not ride raw
      # into the request path (@uri leaves an IPv4's dots untouched).
      ipenc="$(jq -rn --arg v "$query" '$v|@uri')"
      if ! resp="$(curl -fsS -m 30 "$API/shodan/host/${ipenc}?key=${SHODAN}")"; then
        echo "shodan host lookup failed for '$query' (unknown host or bad key)" >&2; exit 1
      fi
      check_api_error "$resp"
      # host lookup: top-level host fields + a .data[] of services. Fold the
      # host-level context into each service so both paths feed one shared mapper.
      arr="$(printf '%s' "$resp" | jq -c '. as $h
        | [ (.data // [])[]
            | . + { ip_str:$h.ip_str, org:$h.org, isp:$h.isp, asn:$h.asn,
                    hostnames:$h.hostnames, domains:$h.domains,
                    os:(.os // $h.os), vulns:(.vulns // $h.vulns),
                    location:{ country_name:$h.country_name, city:$h.city,
                               latitude:$h.latitude, longitude:$h.longitude } } ]' 2>/dev/null)"
    else
      q="$(jq -rn --arg q "$query" '$q|@uri')"
      if ! resp="$(curl -fsS -m 30 "$API/shodan/host/search?key=${SHODAN}&query=${q}")"; then
        echo "shodan search failed for '$query' (check filters / query credits)" >&2; exit 1
      fi
      check_api_error "$resp"
      arr="$(printf '%s' "$resp" | jq -c '[ (.matches // [])[] ]' 2>/dev/null)"
    fi
    # A non-JSON body leaves arr empty → surface it rather than a silent zero-result
    # scan. (A genuine empty result is a valid "[]" and maps to zero hits.)
    [ -n "$arr" ] || { echo "shodan: unexpected response: $(printf '%s' "$resp" | head -c 200)" >&2; exit 1; }

    # Bound all downstream work to the requested count up front — a search can
    # return 100 matches, and (with screenshots on) we must not decode 100 images to
    # serve a --limit 5. The mapper's trailing .[0:$n] then becomes a no-op.
    arr="$(printf '%s' "$arr" | jq -c --argjson n "$limit" '.[0:$n]')"

    # OPT-IN, SENSITIVE (see header): decode each service's SCREENSHOT into the case
    # media dir and tag RTSP stream endpoints. Only runs when the operator has set
    # OVERCAST_SHODAN_SCREENSHOTS — their acknowledgement that these are real
    # exposed hosts. Screenshot DECODING (bash) is kept separate from the JSON
    # ENRICHMENT (a single jq pass over the whole list), so a decode/transform hiccup
    # can never silently drop a hit: the worst case is a screenshot-less (metadata)
    # hit, never a lost one. The heavy base64 is dropped so records stay lean.
    if shots_enabled; then
      echo "shodan: screenshot/RTSP extraction ENABLED — materializing media from REAL exposed hosts; authorized use only" >&2
      shotdir="${OVERCAST_MEDIA_DIR:-$PWD}/shodan-shots"
      mkdir -p "$shotdir" 2>/dev/null || true
      # 1) decode screenshots → a JSON map of "<ip>_<port>" → local jpg path. Iterate
      #    ONLY services that carry screenshot data (@tsv is safe — base64 has no tabs).
      shotmap="{}"
      while IFS="$(printf '\t')" read -r ip port data; do
        [ -n "$data" ] || continue
        safe="$(printf '%s' "${ip}_${port}" | tr -c 'A-Za-z0-9._-' '_')"
        f="$shotdir/${safe}.jpg"
        if printf '%s' "$data" | base64 -d > "$f" 2>/dev/null && [ -s "$f" ]; then
          shotmap="$(jq -cn --argjson m "$shotmap" --arg k "${ip}_${port}" --arg v "$f" '$m + {($k):$v}' 2>/dev/null || printf '%s' "$shotmap")"
        fi
      done < <(printf '%s' "$arr" | jq -r '.[]
                 | select((.screenshot.data // .opts.screenshot.data) != null)
                 | [(.ip_str // "host"), ((.port // 0)|tostring),
                    ((.screenshot.data // .opts.screenshot.data)|gsub("\\s";""))] | @tsv')
      # 2) ONE jq pass over the FULL list: attach the decoded path (if any), labels,
      #    and rtsp stream; drop the heavy base64. This never drops an element. If the
      #    pass somehow fails (empty output), keep the metadata list rather than
      #    losing hits — screenshots are best-effort, the host intel is not.
      enriched="$(printf '%s' "$arr" | jq -c --argjson map "$shotmap" '[ .[]
        | ("\(.ip_str // "host")_\(.port // 0)") as $k
        | .shot_path = ($map[$k] // null)
        | .screenshot_labels = ((.screenshot.labels // .opts.screenshot.labels) // [])
        | .stream = (if (.port == 554) then ("rtsp://" + (.ip_str // "") + ":554") else null end)
        | del(.screenshot) | del(.opts.screenshot) ]' 2>/dev/null)"
      if [ -n "$enriched" ]; then
        arr="$enriched"
      else
        echo "shodan: screenshot enrichment failed; continuing with metadata-only hits" >&2
      fi
    fi

    # Map to hits. media.ref/url carry a `#<port>` fragment so every SERVICE on a
    # host is a distinct record (else all ports on one IP collapse to one dedup key,
    # and monitor would miss newly exposed ports). The fragment is client-only, so
    # `fetch` still curls the clean host page. With the opt-in flag, a decoded
    # screenshot becomes media.ref (image evidence for see/face/crop) and RTSP
    # endpoints surface in payload.stream.
    printf '%s' "$arr" | jq -c --argjson n "$limit" '[ .[]
      | (("https://www.shodan.io/host/" + (.ip_str // ""))) as $page
      | ($page + (if (.port != null) then ("#" + (.port|tostring) + (if (.transport // "") != "" then "-" + .transport else "" end)) else "" end)) as $ref
      | {
        title: (((.ip_str // "") + ":" + ((.port // 0)|tostring)) + (if (.org // "") != "" then "  " + .org else "" end)),
        url: $ref,
        source: "shodan",
        published: (.timestamp // null),
        snippet: (([(.product // ""), ((.version // "")|tostring), (.transport // "")] | map(select(. != "")) | join(" "))
                  + (if (.data // "") != "" then " — " + (((.data)|tostring)|split("\n")[0]) else "" end)),
        ip: (.ip_str // null),
        port: (.port // null),
        transport: (.transport // null),
        org: (.org // null),
        isp: (.isp // null),
        asn: (.asn // null),
        product: (.product // null),
        hostnames: (.hostnames // []),
        domains: (.domains // []),
        os: (.os // null),
        cpe: (.cpe // .cpe23 // []),
        country: (.location.country_name // null),
        city: (.location.city // null),
        lat: (.location.latitude // null),
        lng: (.location.longitude // null),
        vulns: ((.vulns // {}) | if type == "object" then keys else . end),
        screenshot: ((.shot_path // null) != null),
        screenshot_labels: (.screenshot_labels // []),
        stream: (.stream // null),
        host_page: $page,
        media: { ref: (if (.shot_path // null) != null then .shot_path else $ref end) }
      } | select(.ip != null) ] | .[0:$n]'
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in --url) url="${2:-}"; shift 2 2>/dev/null || shift ;; --out) out="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done
    [ -n "$url" ] || { echo "shodan fetch needs --url" >&2; exit 1; }
    # capture the host report page as evidence. shodan.io host pages may be
    # login-gated / rate-limited; a non-2xx is a real fetch error, not a
    # fake-clean capture. Don't double the suffix when --out already ends in html.
    page="${out}.html"
    case "$out" in *.html|*.htm) page="$out" ;; esac
    if curl -fsSL -m 60 -o "$page" "$url"; then
      jq -nc --arg p "$page" --arg u "$url" '{kind:"page",path:$p,source:"shodan",url:$u}'
    else
      echo "shodan fetch failed for $url (host page may require login)" >&2
      rm -f "$page"
      exit 1
    fi
    ;;
  *) echo "shodan source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
