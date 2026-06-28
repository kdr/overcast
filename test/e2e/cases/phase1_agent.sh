#!/usr/bin/env bash
# Phase 1 e2e: overcast in AGENT MODE, headless + JSON (pi print mode with the
# overcast extension + Cloudglue brain). Verifies the extension loads, the system
# prompt/verb cheatsheet is in effect, and overcast emits its own headless JSON.
# Kept light (no video describe) to control Cloudglue cost.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

if [ -z "${CLOUDGLUE_API_KEY:-}" ]; then
  k="$(jq -r '.services.cloudglue // .apiKeys.cloudglue // empty' "$HOME/.tinycloud/config.json" 2>/dev/null)"
  [ -n "$k" ] && export CLOUDGLUE_API_KEY="$k"
fi
if [ -z "${CLOUDGLUE_API_KEY:-}" ]; then
  fail "agent.no_key" "CLOUDGLUE_API_KEY unavailable; skipping agent-mode case"
  return 0 2>/dev/null || exit 0
fi

casedir="$SMOKE_DIR/case_agent"
mkdir -p "$casedir"

# Headless agent: no tool call needed — just confirm the agent runs under the
# overcast extension + Cloudglue brain and emits JSON we can parse.
# Wrapped in a timeout so a hung cloud call fails fast (never hangs the suite).
cond "headless JSON agent answers through the overcast extension"
out="$(cd "$casedir" && oc_timeout "${OVERCAST_AGENT_TIMEOUT:-90}" $OVERCAST -p "Name the overcast verb used to analyze a video. Answer with one word." \
        --mode json --model cloudglue/tinycloud:advanced 2>"$SMOKE_DIR/phase1_agent.err")"
rc=$?
capture_cmd "overcast -p 'Name the overcast verb used to analyze a video. Answer with one word.' --mode json --model cloudglue/tinycloud:advanced" "$out"
if [ "$rc" = "142" ]; then
  fail "agent.timeout" "headless agent exceeded ${OVERCAST_AGENT_TIMEOUT:-90}s (cloud hang) — see phase1_agent.err"
  return 0 2>/dev/null || exit 0
fi
save_json "phase1_agent" "$out" >/dev/null

# pi --mode json emits structured JSON; assert it's parseable and non-empty.
parseable="$(jq -e . >/dev/null 2>&1 <<<"$out" && echo true || echo false)"
assert_eq "agent.exit_zero" "0" "$rc" "headless agent exit code"
assert_eq "agent.json_parseable" "true" "$parseable" "agent emitted parseable JSON"

# The agent should mention "watch" somewhere in its output (system prompt works).
if grep -qi "watch" <<<"$out"; then
  ok "agent.mentions_watch" "agent output references the watch verb"
else
  fail "agent.mentions_watch" "agent output did not reference watch"
fi
