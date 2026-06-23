#!/usr/bin/env bash
# Phase 1 e2e: the vertical slice — `overcast watch <clip> --json` emits a valid
# video.analysis record AND persists it to the case store. Hits Cloudglue via the
# tinycloud exec provider; uses the smallest smoke clip to control time + cost.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

clip="$(smoke_clip)"
if [ ! -f "$clip" ]; then
  fail "watch.clip_missing" "smoke clip not found: $clip"
  return 0 2>/dev/null || exit 0
fi
if [ -z "${CLOUDGLUE_API_KEY:-}" ]; then
  # fall back to the tinycloud config key so the provider can reach Cloudglue
  k="$(jq -r '.services.cloudglue // .apiKeys.cloudglue // empty' "$HOME/.tinycloud/config.json" 2>/dev/null)"
  [ -n "$k" ] && export CLOUDGLUE_API_KEY="$k"
fi

casedir="$SMOKE_DIR/case_watch"
mkdir -p "$casedir"

out="$($OVERCAST watch "$clip" --json --case "$casedir" 2>"$SMOKE_DIR/phase1_watch.err")"
rc=$?
save_json "phase1_watch" "$out" >/dev/null

verb="$(jq -r '.verb' <<<"$out" 2>/dev/null)"
state="$(jq -r '.state // "ready"' <<<"$out" 2>/dev/null)"
has_content="$(jq -r '(.payload.content // "") | length > 0' <<<"$out" 2>/dev/null)"
has_detailed="$(jq -r '(.payload.detailed != null)' <<<"$out" 2>/dev/null)"
media_ref="$(jq -r '.media.ref // ""' <<<"$out" 2>/dev/null)"

assert_eq "watch.exit_zero" "0" "$rc" "CLI exit code"
assert_eq "watch.verb" "watch" "$verb" "record.verb"
assert_eq "watch.state_ready" "ready" "$state" "record.state ready"
assert_eq "watch.has_content" "true" "$has_content" "payload.content non-empty"
assert_eq "watch.has_detailed" "true" "$has_detailed" "payload.detailed present"
assert_nonempty "watch.media_ref" "$media_ref" "media.ref set"

# persisted to the case store as JSONL
persisted="$casedir/.overcast/records/watch.jsonl"
if [ -f "$persisted" ]; then
  lines="$(wc -l <"$persisted" | tr -d ' ')"
  assert_eq "watch.persisted" "1" "$lines" "one record persisted to .overcast/records/watch.jsonl"
  pid="$(jq -r '.id' "$persisted")"
  oid="$(jq -r '.id' <<<"$out")"
  assert_eq "watch.persisted_id_matches" "$oid" "$pid" "persisted id matches emitted record"
else
  fail "watch.persisted" "no records/watch.jsonl written"
fi
