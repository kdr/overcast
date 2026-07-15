#!/usr/bin/env bash
# overcast source provider: browser (rendered-page capture via the shared
# screenshot engine — headless Chromium / Playwright). Each fetch renders the
# CURRENT state of the page to a PNG, so `monitor` becomes a page-watch:
# every pass re-captures the live render (webcam-style ephemeral hits).
# Bind with:  overcast source add browser:https://example.com/status
#             OVERCAST_SOURCE_BROWSER_CMD="bash providers/sources/browser.sh"
# Refs / queries:
#   <url>  — the page to render (https:// assumed when no scheme is given)
# Needs: node + the playwright optional dep + Chromium payload — see
# providers/engines/screenshot/screenshot.sh (missing deps exit 13). No API
# key. Private/loopback targets are refused by default
# (OVERCAST_ALLOW_PRIVATE_FETCH=1 to allow). One-shot captures are the
# `screenshot` verb's job; this source is the standing scan/monitor surface.
# Implements: enumerate --query <url> [--limit N] | fetch --url <u> --out <p> | init | describe
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="$here/../engines/screenshot/screenshot.sh"

op="${1:-enumerate}"; shift || true

case "$op" in
  init)
    exec bash "$engine" init ;;
  describe)
    echo '{"source":"browser","emits":"scan.hit","needs":["node","playwright","chromium"]}'; exit 0 ;;
  enumerate)
    query=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      --limit) shift 2 2>/dev/null || shift ;;   # a page ref is always one hit
      --since) shift 2 2>/dev/null || shift ;;   # a page render has no recency
      *) shift ;;
    esac; done
    [ -n "$query" ] || { echo "browser enumerate needs a ref (<url>)" >&2; exit 1; }
    case "$query" in
      http://*|https://*) : ;;
      *) query="https://$query" ;;   # scheme-less ref: assume https
    esac
    # ONE hit per ref: the page itself. media.ref is the page URL — the PNG is
    # produced at fetch time (scan --pull / monitor → captureRef → fetch below).
    # recapture:true = ephemeral (monitor re-renders every pass and does not
    # persist the hit to the seen-set); url stays the clean page so provenance
    # (source_url) is stable across passes.
    now="$(date -u +%s)"
    jq -nc --arg u "$query" --arg now "$now" '
      [{
        title: $u,
        url: $u,
        source: "browser",
        recapture: true,
        snapshot_at: ($now | tonumber),
        snippet: "rendered page snapshot (headless Chromium)",
        media: { ref: $u }
      }]'
    ;;
  fetch)
    # delegate to the shared engine's capture path: renders the page and emits
    # {kind:"image",path,source:"browser",url} for fetchSource to map.
    exec bash "$engine" fetch "$@" ;;
  *) echo "browser source: unknown op (expected enumerate|fetch|init|describe)" >&2; exit 2 ;;
esac
