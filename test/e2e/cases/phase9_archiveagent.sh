#!/usr/bin/env bash
# Archive verb through the AGENT surface: a headless pi agent (overcast -p, the
# overcast extension + Cloudglue brain) drives the archive TOOL against a
# pre-seeded bucket, and we verify the effects deterministically via the CLI.
# Like phase1_agent this self-skips without a brain key (the rest of the
# offline suite stays cred-free); kept to two short completions for cost.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

if [ -z "${CLOUDGLUE_API_KEY:-}" ]; then
  k="$(jq -r '.services.cloudglue // .apiKeys.cloudglue // empty' "$HOME/.tinycloud/config.json" 2>/dev/null)"
  [ -n "$k" ] && export CLOUDGLUE_API_KEY="$k"
fi
if [ -z "${CLOUDGLUE_API_KEY:-}" ]; then
  ok "archiveagent.skipped" "CLOUDGLUE_API_KEY unavailable; archive agent-mode case skipped"
  return 0 2>/dev/null || exit 0
fi

export OVERCAST_HOME="$SMOKE_DIR/archiveagent_home"
mkdir -p "$OVERCAST_HOME"
casedir="$SMOKE_DIR/case_archiveagent"; mkdir -p "$casedir"

# seed a bucket + one item on the VERB side so the agent has real state to read
clip="$SMOKE_DIR/archiveagent_clip.mp4"; printf 'fake-agent-video' >"$clip"
$OVERCAST archive init agent-refs --case "$casedir" --json >/dev/null 2>&1
$OVERCAST archive add "$clip" --to agent-refs --tags seeded --case "$casedir" --json >/dev/null 2>&1
seeded="$($OVERCAST archive show agent-refs --case "$casedir" --json 2>/dev/null | jq -r '.payload.total_items')"
assert_eq "archiveagent.seeded" "1" "$seeded" "bucket seeded via the verb surface"

# 1) the agent READS archive state through the tool (list) and names the bucket
cond "headless agent lists archive buckets via the archive tool"
out="$(cd "$casedir" && oc_timeout "${OVERCAST_AGENT_TIMEOUT:-120}" $OVERCAST -p "Use the archive tool with action list to list the global archive buckets. Reply in one line naming each bucket." \
        --mode json --model cloudglue/tinycloud:advanced 2>"$SMOKE_DIR/phase9_archiveagent.err")"
rc=$?
capture_cmd "overcast -p 'Use the archive tool with action list …' --mode json" "$out"
if [ "$rc" = "142" ]; then
  fail "archiveagent.timeout" "headless agent exceeded ${OVERCAST_AGENT_TIMEOUT:-120}s (cloud hang) — see phase9_archiveagent.err"
  return 0 2>/dev/null || exit 0
fi
save_json "phase9_archiveagent_list" "$out" >/dev/null
assert_eq "archiveagent.exit_zero" "0" "$rc" "headless agent exit code"
if grep -q "agent-refs" <<<"$out"; then
  ok "archiveagent.names_bucket" "agent output names the seeded bucket"
else
  fail "archiveagent.names_bucket" "agent output never mentioned agent-refs"
fi

# 2) the agent WRITES through the tool (add) — verified via the CLI, not its prose
cond "headless agent archives a file via the archive tool (CLI-verified)"
item2="$SMOKE_DIR/archiveagent_item2.mp4"; printf 'fake-agent-video-2' >"$item2"
(cd "$casedir" && oc_timeout "${OVERCAST_AGENT_TIMEOUT:-120}" $OVERCAST -p "Use the archive tool to add the file $item2 to the archive bucket agent-refs with the tag agent-added. Then reply DONE." \
        --mode json --model cloudglue/tinycloud:advanced >/dev/null 2>>"$SMOKE_DIR/phase9_archiveagent.err")
show="$($OVERCAST archive show agent-refs --case "$casedir" --json 2>/dev/null)"
save_json "phase9_archiveagent_show" "$show" >/dev/null
after="$(jq -r '.payload.total_items' <<<"$show")"
tagged="$(jq -r '[.payload.items[]|select((.tags // [])|index("agent-added"))]|length' <<<"$show")"
if [ "${after:-0}" -ge 2 ] && [ "${tagged:-0}" -ge 1 ]; then
  ok "archiveagent.add_verified" "agent's archive add landed in the bucket (items=$after, tag agent-added present)"
else
  fail "archiveagent.add_verified" "agent add not verified (items=$after, tagged=$tagged)"
fi
