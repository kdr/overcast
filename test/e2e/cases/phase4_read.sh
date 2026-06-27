#!/usr/bin/env bash
# Phase 4 e2e: read side (offline). Populate a case with records, then ask
# (retrieve + cite record.id + media.at) and brief (--export md/html).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_read"; mkdir -p "$casedir"

# seed records directly into the case store (deterministic, offline)
node --import tsx -e "
import {openCase} from '$REPO/src/case.ts'; import {makeRecord} from '$REPO/src/record.ts';
const c=openCase('$casedir'); c.ensure();
c.writeRecord(makeRecord({verb:'watch',payload:{content:'A white van parked near the docks at night, loading boxes.'},media:{ref:'a.mp4',at:[12,18]},meta:{time:'2026-06-20T10:00:00Z'}}));
c.writeRecord(makeRecord({verb:'watch',payload:{content:'Daytime footage of an empty warehouse.'},media:{ref:'b.mp4',at:5},meta:{time:'2026-06-21T10:00:00Z'}}));
c.writeRecord(makeRecord({verb:'scan',payload:{title:'dock cam feed',url:'http://x/feed'}}));
" 2>"$SMOKE_DIR/phase4_seed.err"

# human-authored notes are first-class case records: searchable, citable, and
# included in briefs. Anchor this one to the first watch record's media span.
watch_id="$(node --import tsx -e "import {openCase} from '$REPO/src/case.ts'; const c=openCase('$casedir'); console.log(c.records().find(r=>r.verb==='watch').id)")"
note="$($OVERCAST note 'Human observation: the white van has a missing rear plate' --ref "$watch_id" --at 13-16 --tag vehicle,plate --confidence high --json --case "$casedir" 2>/dev/null)"
save_json "phase4_note" "$note" >/dev/null
assert_eq "note.verb" "note" "$(jq -r '.verb' <<<"$note")" "note verb"
assert_eq "note.state" "ready" "$(jq -r '.state' <<<"$note")" "note ready"
assert_eq "note.media_at" "[13,16]" "$(jq -r '.media.at|tostring' <<<"$note")" "note carries media.at"
assert_eq "note.provider" "human" "$(jq -r '.meta.provider' <<<"$note")" "note marked human"

# ask cites the matching record by id + media.at
ask="$($OVERCAST ask 'white van at the docks' --json --case "$casedir" 2>/dev/null)"
save_json "phase4_ask" "$ask" >/dev/null
assert_eq "ask.verb" "ask" "$(jq -r '.verb' <<<"$ask")" "ask verb"
assert_eq "ask.state" "ready" "$(jq -r '.state' <<<"$ask")" "ask ready"
ncite="$(jq -r '.payload.citations|length' <<<"$ask")"
[ "${ncite:-0}" -ge 1 ] && ok "ask.has_citation" "ask returned $ncite citation(s)" || fail "ask.has_citation" "no citations"
top_at="$(jq -r '.payload.citations[0].at|tostring' <<<"$ask")"
assert_eq "ask.cites_media_at" "[12,18]" "$top_at" "top citation carries media.at"
if jq -e '.payload.text|test("white van";"i")' >/dev/null <<<"$ask"; then ok "ask.grounded" "answer text references the matched finding"; else fail "ask.grounded" "answer missed the finding"; fi

note_ask="$($OVERCAST ask 'missing rear plate' --json --case "$casedir" 2>/dev/null)"
save_json "phase4_note_ask" "$note_ask" >/dev/null
if jq -e '.payload.citations[]|select(.verb=="note")' >/dev/null <<<"$note_ask"; then ok "ask.cites_note" "ask cites the human note"; else fail "ask.cites_note" "ask did not cite note"; fi

# brief --export writes an html report containing the timeline
brief_html="$casedir/brief.html"
brief="$($OVERCAST brief --export "$brief_html" --json --case "$casedir" 2>/dev/null)"
save_json "phase4_brief" "$brief" >/dev/null
# >= 3 seeded records (the prior `ask` also persists its own answer record)
btotal="$(jq -r '.payload.total' <<<"$brief")"
[ "${btotal:-0}" -ge 3 ] && ok "brief.total" "brief covers the case records ($btotal)" || fail "brief.total" "expected >=3 got $btotal"
if [ -f "$brief_html" ] && grep -q "white van" "$brief_html" && grep -q "missing rear plate" "$brief_html" && grep -q "<h1>" "$brief_html"; then
  ok "brief.export_html" "exported html report with timeline"
else
  fail "brief.export_html" "export missing or incomplete"
fi

# verb surface now lists ask + brief + note
v="$($OVERCAST commands --json 2>/dev/null | jq -r '.verbs[].name')"
echo "$v" | grep -qx ask && echo "$v" | grep -qx brief && echo "$v" | grep -qx note && ok "read.verb_surface" "ask + brief + note listed" || fail "read.verb_surface" "ask/brief/note missing"
