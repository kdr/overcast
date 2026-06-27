#!/usr/bin/env bash
# Phase 4 e2e: clearing a case is a two-step reset. A dry run summarizes what
# would be lost and does not mutate the store; --yes clears resettable state
# without writing a new case-history record.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_clear"; mkdir -p "$casedir"
RID="rec_clear0001"

record_lines() {
  find "$casedir/.overcast/records" -name '*.jsonl' -type f -exec cat {} + 2>/dev/null | wc -l | tr -d ' '
}

node --import tsx -e "
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCase } from '$REPO/src/case.ts';
import { makeRecord } from '$REPO/src/record.ts';
const c = openCase('$casedir'); c.ensure();
c.writeRecord(makeRecord({ id: '$RID', verb: 'watch', payload: { content: 'clear me' }, media: { ref: 'clip.mp4' } }));
writeFileSync(c.sourcesFile, JSON.stringify({ sources: [{ id: 'src_1', type: 'fixture' }] }));
writeFileSync(c.targetFile, JSON.stringify({ targets: [{ id: 'target_1', name: 'pier' }] }));
writeFileSync(join(c.mediaDir, 'clip.txt'), 'media');
mkdirSync(c.indexDir, { recursive: true });
writeFileSync(join(c.indexDir, 'idx.txt'), 'index');
" 2>"$SMOKE_DIR/phase4_caseclear_seed.err"

preview="$($OVERCAST case clear --json --case "$casedir" 2>/dev/null)"
save_json "phase4_caseclear_preview" "$preview" >/dev/null
assert_eq "clear.preview_state" "pending" "$(jq -r '.state' <<<"$preview")" "dry run requires confirmation"
assert_eq "clear.preview_records" "1" "$(jq -r '.payload.will_lose.records' <<<"$preview")" "dry run reports one record"
assert_eq "clear.preview_confirm" "true" "$(jq -r '.payload.confirmation_required' <<<"$preview")" "dry run reports confirmation requirement"

assert_eq "clear.preview_preserves_records" "1" "$(record_lines)" "dry run leaves records intact"
if [ -f "$casedir/.overcast/sources.json" ]; then
  ok "clear.preview_preserves_state" "dry run leaves state files intact"
else
  fail "clear.preview_preserves_state" "sources.json was removed"
fi

confirmed="$($OVERCAST case clear --yes --json --case "$casedir" 2>/dev/null)"
save_json "phase4_caseclear_confirmed" "$confirmed" >/dev/null
assert_eq "clear.confirmed" "true" "$(jq -r '.payload.cleared' <<<"$confirmed")" "--yes clears the case"
assert_eq "clear.confirmed_lost_records" "1" "$(jq -r '.payload.lost.records' <<<"$confirmed")" "--yes reports lost record count"

assert_eq "clear.records_empty" "0" "$(record_lines)" "records are empty after clear"
assert_eq "clear.case_preserved" "true" "$([ -f "$casedir/.overcast/case.json" ] && echo true || echo false)" "case remains initialized"

if [ ! -f "$casedir/.overcast/sources.json" ]; then
  ok "clear.state_removed" "state file removed"
else
  fail "clear.state_removed" "sources.json still exists"
fi
if [ ! -f "$casedir/.overcast/media/clip.txt" ]; then
  ok "clear.media_removed" "media file removed"
else
  fail "clear.media_removed" "media file still exists"
fi
if [ ! -d "$casedir/.overcast/index" ]; then
  ok "clear.index_removed" "index directory removed"
else
  fail "clear.index_removed" "index directory still exists"
fi
