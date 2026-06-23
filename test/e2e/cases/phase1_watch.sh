#!/usr/bin/env bash
# Phase 1 e2e: the vertical slice — `overcast watch <input> --json` emits a valid
# video.analysis record AND persists it to the case store.
#
# This case binds `watch` to the committed FIXTURE provider (a real exec provider
# script echoing a captured tinycloud envelope) so it exercises the FULL overcast
# pipeline — CLI -> exec transport -> envelope map -> record -> persist -> output
# -> exit code — instantly and offline, on every cumulative run. The LIVE
# Cloudglue path is proven separately by phase1_watchlive.sh (gated), and the
# envelope-mapping itself is unit-tested against the same real fixture.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_watch"
mkdir -p "$casedir"

# A throwaway profile binding watch to the fixture exec provider.
ochome="$SMOKE_DIR/home_watch"
mkdir -p "$ochome/profiles"
fake="$REPO/test/fixtures/fake-watch.sh"
cat >"$ochome/profiles/fixture.json" <<JSON
{
  "name": "fixture",
  "providers": {
    "watch": { "type": "exec", "run": "bash $fake {{input}}" }
  }
}
JSON

out="$($OVERCAST watch "browse-hackernews.mp4" --json --case "$casedir" --home "$ochome" --profile fixture 2>"$SMOKE_DIR/phase1_watch.err")"
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

# persisted to the case store as JSONL, id matches emitted record
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
