#!/usr/bin/env bash
# Shared outbound-fetch guard for the shipped SOURCE providers.
#
# Why this exists: `captureRef`/`fetchSource` (src/verbs/osint.ts,
# src/providers/sources/index.ts) run the TypeScript SSRF guard
# (assertFetchHostAllowed) on the URL BEFORE spawning a provider — but the
# provider's own `curl -L` then follows redirects the guard never sees, so a
# public URL can 302 into loopback / RFC1918 / link-local (169.254.169.254 cloud
# metadata) and the body would be written into the case as evidence. curl has no
# "refuse private addresses" flag, so this helper:
#   1. pins the scheme on the initial request AND on every redirect hop
#      (--proto / --proto-redir), so no hop can escape to file:/ftp:/dict:/…
#   2. bounds the redirect chain (--max-redirs)
#   3. checks the address curl ACTUALLY connected to on the final hop
#      (%{remote_ip}) against the same blocked ranges as the TS guard, and
#      DELETES the downloaded body when it is private — so a redirected fetch
#      never becomes a capture record.
#
# The residual is honest and documented in SECURITY.md: the request to the
# private address is still issued (curl has already followed the redirect by the
# time we can inspect it); what this closes is the data reaching the case. Set
# OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow private targets, exactly like the TS
# guard's opt-out.
#
# Usage (source it, then call):
#   . "$here/../../engines/net/guarded-fetch.sh"
#   ct="$(oc_guarded_fetch "$url" "$out" -m 180)" || { ...; }
# Echoes the response Content-Type on stdout. Returns 1 on transport/HTTP
# failure, 2 when the final hop landed on a blocked address.

# Is a bare IPv4/IPv6 literal in a loopback/private/link-local/CGNAT range?
# Mirrors isBlockedIPv4 / isBlockedIPv6 in src/media/fetch.ts. curl always hands
# us a plain literal in %{remote_ip}, so no inet_aton shorthand parsing is needed
# here (that matters only for user-supplied strings, which the TS guard covers).
oc_ip_blocked() {
  # every temporary is `local`: this is sourced INTO provider scripts, so a bare
  # `ip`/`a`/`b`/`tail` would clobber the caller's variables of the same name.
  local ip lower tail a b _c _d
  ip="${1:-}"
  [ -n "$ip" ] || return 0   # unknown address → treat as blocked (fail closed)
  ip="${ip#[}"; ip="${ip%]}"
  case "$ip" in
    *:*)
      # IPv6. Normalize case; check the well-known private prefixes.
      lower="$(printf '%s' "$ip" | tr 'A-Z' 'a-z')"
      case "$lower" in
        ::|::1) return 0 ;;                       # unspecified / loopback
        fc??:*|fd??:*|fc::*|fd::*) return 0 ;;    # fc00::/7 unique-local
        fe8?:*|fe9?:*|fea?:*|feb?:*) return 0 ;;  # fe80::/10 link-local
        ::ffff:*|::0:*)
          # v4-mapped / v4-compatible: re-check the embedded dotted quad
          tail="${lower##*:}"
          case "$tail" in *.*.*.*) oc_ip_blocked "$tail"; return $? ;; esac
          return 1 ;;
        *) return 1 ;;
      esac
      ;;
    *.*.*.*)
      IFS=. read -r a b _c _d <<EOF
$ip
EOF
      case "$a" in ''|*[!0-9]*) return 0 ;; esac   # unparseable → fail closed
      case "$b" in ''|*[!0-9]*) return 0 ;; esac
      [ "$a" -eq 127 ] && return 0                 # loopback
      [ "$a" -eq 10 ] && return 0                  # private
      [ "$a" -eq 0 ] && return 0                   # this-host
      [ "$a" -ge 224 ] && return 0                 # multicast + reserved
      [ "$a" -eq 169 ] && [ "$b" -eq 254 ] && return 0   # link-local (cloud metadata)
      [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && return 0   # private
      [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
      [ "$a" -eq 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 0  # CGNAT
      [ "$a" -eq 192 ] && [ "$b" -eq 0 ] && return 0     # 192.0.0.0/24
      return 1
      ;;
    *) return 0 ;;   # not an address we can classify → fail closed
  esac
}

# Parse the HOST out of a URL — lowercased, userinfo and port stripped.
# Providers must never decide "is this my CDN?" with a `*://host/*` glob: that
# matches the string ANYWHERE, so https://evil.example/?x=://t.me/ passes. This
# parses the real authority instead.
oc_url_host() {
  local u="${1:-}"
  u="${u#*://}"          # drop scheme
  u="${u%%/*}"           # drop path
  u="${u%%\?*}"; u="${u%%#*}"
  u="${u##*@}"           # drop userinfo
  case "$u" in
    \[*\]*) u="${u#[}"; u="${u%%]*}" ;;   # bracketed IPv6 (drop the :port after ])
    *:*)    u="${u%%:*}" ;;               # host:port
  esac
  printf '%s' "$u" | tr 'A-Z' 'a-z'
}

# oc_host_allowed <host> <pattern…> — a pattern is either an exact host
# ("t.me") or a dot-prefixed suffix (".telesco.pe" = that domain or any
# subdomain of it). Never a substring match.
oc_host_allowed() {
  local host="${1:-}" pat
  shift 2>/dev/null || true
  [ -n "$host" ] || return 1
  for pat in "$@"; do
    case "$pat" in
      .*) [ "$host" = "${pat#.}" ] && return 0
          case "$host" in *"$pat") return 0 ;; esac ;;
      *)  [ "$host" = "$pat" ] && return 0 ;;
    esac
  done
  return 1
}

# Affirmative-only opt-out, matching envEnabled() in src/env.ts: `=0`/`=false`
# must NOT disable the guard.
oc_private_fetch_allowed() {
  case "${OVERCAST_ALLOW_PRIVATE_FETCH:-}" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

# oc_guarded_fetch <url> <outfile> [extra curl args…] → echoes Content-Type
oc_guarded_fetch() {
  local _oc_url _oc_out _oc_meta _oc_ct _oc_ip _oc_eff
  _oc_url="${1:-}"; _oc_out="${2:-}"; shift 2 2>/dev/null || true
  _oc_meta="$(curl -fsSL \
    --proto '=http,https' --proto-redir '=http,https' --max-redirs 5 \
    -o "$_oc_out" -w '%{content_type}\n%{remote_ip}\n%{url_effective}' \
    "$@" "$_oc_url")" || return 1
  _oc_ct="$(printf '%s\n' "$_oc_meta" | sed -n 1p)"
  _oc_ip="$(printf '%s\n' "$_oc_meta" | sed -n 2p)"
  _oc_eff="$(printf '%s\n' "$_oc_meta" | sed -n 3p)"
  if ! oc_private_fetch_allowed && oc_ip_blocked "$_oc_ip"; then
    rm -f "$_oc_out"
    echo "refusing a fetch that resolved to a private/loopback address ($_oc_ip via $_oc_eff); set OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow" >&2
    return 2
  fi
  printf '%s' "$_oc_ct"
}
