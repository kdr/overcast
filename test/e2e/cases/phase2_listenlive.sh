#!/usr/bin/env bash
# Phase 2 e2e (LIVE, gated): real tinycloud speech-only `listen` against a clip
# WITH audio. Gated behind OVERCAST_E2E_LIVE=1 (slow + costs credits). The listen
# mapper itself is unit-tested offline against a fixture envelope.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

if [ "${OVERCAST_E2E_LIVE:-}" != "1" ]; then
  ok "listenlive.skipped" "live Cloudglue listen skipped (set OVERCAST_E2E_LIVE=1)"
  return 0 2>/dev/null || exit 0
fi

# pick the smallest test clip that has an audio stream (browse-hackernews has none)
clip=""
for c in "$TEST_MEDIA"/video-willsmith-*.mp4 "$TEST_MEDIA"/bbq.mp4; do
  [ -f "$c" ] && { clip="$c"; break; }
done
if [ -z "$clip" ]; then
  fail "listenlive.clip" "no audio test clip found in $TEST_MEDIA"
  return 0 2>/dev/null || exit 0
fi
if [ -z "${CLOUDGLUE_API_KEY:-}" ]; then
  k="$(jq -r '.services.cloudglue // .apiKeys.cloudglue // empty' "$HOME/.tinycloud/config.json" 2>/dev/null)"
  [ -n "$k" ] && export CLOUDGLUE_API_KEY="$k"
fi

casedir="$SMOKE_DIR/case_listenlive"; mkdir -p "$casedir"
out="$($OVERCAST listen "$clip" --json --case "$casedir" 2>"$SMOKE_DIR/phase2_listenlive.err")"
save_json "phase2_listenlive" "$out" >/dev/null
assert_eq "listenlive.verb" "listen" "$(jq -r .verb <<<"$out")" "listen verb"
assert_eq "listenlive.state" "ready" "$(jq -r '.state // "ready"' <<<"$out")" "listen ready (real Cloudglue)"
