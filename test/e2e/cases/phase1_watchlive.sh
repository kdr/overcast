#!/usr/bin/env bash
# Phase 1 e2e (LIVE, gated): the real Cloudglue path via the default tinycloud
# exec provider. Gated behind OVERCAST_E2E_LIVE=1 because a full describe takes
# minutes and costs credits; the repeatable pipeline coverage lives in
# phase1_watch.sh (fixture-backed). Uses the smallest smoke clip + tinycloud's
# `light` profile to keep the cloud call as small as possible.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

if [ "${OVERCAST_E2E_LIVE:-}" != "1" ]; then
  ok "watchlive.skipped" "live Cloudglue watch skipped (set OVERCAST_E2E_LIVE=1 to enable)"
  return 0 2>/dev/null || exit 0
fi

clip="$(smoke_clip)"
if [ ! -f "$clip" ]; then
  fail "watchlive.clip_missing" "smoke clip not found: $clip"
  return 0 2>/dev/null || exit 0
fi
if [ -z "${CLOUDGLUE_API_KEY:-}" ]; then
  k="$(jq -r '.services.cloudglue // .apiKeys.cloudglue // empty' "$HOME/.tinycloud/config.json" 2>/dev/null)"
  [ -n "$k" ] && export CLOUDGLUE_API_KEY="$k"
fi

ochome="$SMOKE_DIR/home_live"; mkdir -p "$ochome/profiles"
cat >"$ochome/profiles/live.json" <<'JSON'
{ "name": "live", "providers": { "watch": { "type": "exec", "run": "tinycloud watch {{input}} --profile light --json" } } }
JSON

casedir="$SMOKE_DIR/case_watchlive"; mkdir -p "$casedir"
out="$($OVERCAST watch "$clip" --json --case "$casedir" --home "$ochome" --profile live 2>"$SMOKE_DIR/phase1_watchlive.err")"
rc=$?
save_json "phase1_watchlive" "$out" >/dev/null

verb="$(jq -r '.verb' <<<"$out" 2>/dev/null)"
state="$(jq -r '.state // "ready"' <<<"$out" 2>/dev/null)"
has_detailed="$(jq -r '(.payload.detailed != null)' <<<"$out" 2>/dev/null)"

assert_eq "watchlive.exit_zero" "0" "$rc" "live CLI exit code"
assert_eq "watchlive.verb" "watch" "$verb" "record.verb"
assert_eq "watchlive.state_ready" "ready" "$state" "record.state ready (real Cloudglue)"
assert_eq "watchlive.has_detailed" "true" "$has_detailed" "payload.detailed present from real describe"
