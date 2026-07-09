#!/usr/bin/env bash
# overcast source provider: shodan (host / service / banner intelligence via the
# Shodan REST API). Search the internet's exposed hosts by org, network, product,
# port, TLS cert, hostname, country, … or look up a single IP's full service map.
#
# ⚠️  Authorized recon only. Shodan surfaces exposed services, banners, and known
# vulnerabilities of real hosts. Use only against infrastructure you are permitted
# to investigate. Never a default binding — you must bind it.
#
# Bind with:  overcast source add shodan:'org:"Example Corp" port:22'
#             overcast source add shodan:8.8.8.8            # single-host lookup
#             overcast scan --source shodan --pull
#             overcast monitor --source shodan --every 6h   # standing exposure watch
# Refs / queries:
#   <search query>   — Shodan search filters (org: net: ssl: hostname: product:
#                      port: country: …). Bills 1 query credit per 100 results.
#   <ip>             — a bare IPv4/IPv6 → full host lookup (one hit per service).
# Key: SHODAN_API_KEY (https://account.shodan.io).
# Each hit's media.ref is the shodan.io host report page, so `capture`/--pull
# stores a real evidence page (host intel itself rides in the loose payload).
# Implements: enumerate --query <q> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail

SHODAN="${SHODAN_API_KEY:-}"

need() {
  if [ -z "$SHODAN" ]; then
    echo "shodan source needs a key: set SHODAN_API_KEY (https://account.shodan.io)" >&2
    exit 13
  fi
}

op="${1:-enumerate}"; shift || true
case "$op" in
  init)     need; exit 0 ;;
  describe) echo '{"source":"shodan","emits":"scan.hit","needs":["SHODAN_API_KEY"]}'; exit 0 ;;
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
      if ! resp="$(curl -fsS -m 30 "https://api.shodan.io/shodan/host/${query}?key=${SHODAN}")"; then
        echo "shodan host lookup failed for '$query' (unknown host or bad key)" >&2; exit 1
      fi
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
      if ! resp="$(curl -fsS -m 30 "https://api.shodan.io/shodan/host/search?key=${SHODAN}&query=${q}")"; then
        echo "shodan search failed for '$query' (check filters / query credits)" >&2; exit 1
      fi
      arr="$(printf '%s' "$resp" | jq -c '[ (.matches // [])[] ]' 2>/dev/null)"
    fi
    # A non-JSON / error body (e.g. {"error":"..."}) leaves arr empty → surface it
    # rather than a silent zero-result scan.
    [ -n "$arr" ] || { echo "shodan: unexpected response: $(printf '%s' "$resp" | head -c 200)" >&2; exit 1; }

    printf '%s' "$arr" | jq -c --argjson n "$limit" '[ .[] | {
        title: (((.ip_str // "") + ":" + ((.port // 0)|tostring)) + (if (.org // "") != "" then "  " + .org else "" end)),
        url: ("https://www.shodan.io/host/" + (.ip_str // "")),
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
        media: { ref: ("https://www.shodan.io/host/" + (.ip_str // "")) }
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
