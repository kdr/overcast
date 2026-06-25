#!/usr/bin/env bash
# Phase 4 e2e: reading a large record field through the CLI (offline). Seeds a
# big-content watch record, then exercises `case memory get` — the manifest and
# deterministic `--field --offset --limit` paging that replace head/tail-ing the
# raw jsonl (the "skipped middle" bug this verb fixes).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_pageread"; mkdir -p "$casedir"
RID="rec_page0001"

# seed one record with a deterministic multi-page content field (fixed id)
node --import tsx -e "
import {openCase} from '$REPO/src/case.ts'; import {makeRecord} from '$REPO/src/record.ts';
const c=openCase('$casedir'); c.ensure();
const content=Array.from({length:80},(_,i)=>'scene '+i+' — land-use designation walkthrough line').join('\n');
c.writeRecord(makeRecord({id:'$RID',verb:'watch',format:'json',payload:{content,transcript:'',detailed:{segments:[1,2,3]}},media:{ref:'workshop.mp4'}}));
" 2>"$SMOKE_DIR/phase4_pageread_seed.err"

# (1) manifest: each field with type + chars (no --field)
man="$($OVERCAST case memory get "$RID" --json --case "$casedir" 2>/dev/null)"
save_json "phase4_pageread_manifest" "$man" >/dev/null
assert_eq "page.manifest.record" "$RID" "$(jq -r '.payload.record' <<<"$man")" "manifest names the record"
ctype="$(jq -r '.payload.fields[]|select(.name=="content").type' <<<"$man")"
assert_eq "page.manifest.content_type" "string" "$ctype" "content field typed as string"
cchars="$(jq -r '.payload.fields[]|select(.name=="content").chars' <<<"$man")"
[ "${cchars:-0}" -gt 200 ] && ok "page.manifest.chars" "manifest reports content length ($cchars chars)" || fail "page.manifest.chars" "expected >200 got ${cchars:-0}"

# (2) page 1: offset 0, limit 100
p1="$($OVERCAST case memory get "$RID" --field content --offset 0 --limit 100 --json --case "$casedir" 2>/dev/null)"
save_json "phase4_pageread_p1" "$p1" >/dev/null
assert_eq "page.p1.field" "content" "$(jq -r '.payload.field' <<<"$p1")" "page 1 field is content"
assert_eq "page.p1.returned" "100" "$(jq -r '.payload.returned' <<<"$p1")" "page 1 returned 100 chars"
assert_eq "page.p1.has_more" "true" "$(jq -r '.payload.has_more' <<<"$p1")" "page 1 has_more"
assert_eq "page.p1.next_offset" "100" "$(jq -r '.payload.next_offset' <<<"$p1")" "page 1 next_offset"
# manifest chars === paging total (no bytes-vs-chars drift)
assert_eq "page.chars_eq_total" "$cchars" "$(jq -r '.payload.total' <<<"$p1")" "manifest chars matches paging total"

# (3) page 2: continue from next_offset
p2="$($OVERCAST case memory get "$RID" --field content --offset 100 --limit 100 --json --case "$casedir" 2>/dev/null)"
save_json "phase4_pageread_p2" "$p2" >/dev/null
assert_eq "page.p2.offset" "100" "$(jq -r '.payload.offset' <<<"$p2")" "page 2 starts at next_offset"

# (4) whole field, then prove continuity — page1+page2 reconstruct content[0:200]
whole="$($OVERCAST case memory get "$RID" --field content --offset 0 --limit 1000000 --json --case "$casedir" 2>/dev/null)"
save_json "phase4_pageread_whole" "$whole" >/dev/null
assert_eq "page.whole.has_more" "false" "$(jq -r '.payload.has_more' <<<"$whole")" "full read reports no more"
if node -e '
const fs=require("fs");
const rd=f=>JSON.parse(fs.readFileSync(f,"utf8")).payload.chunk;
const p1=rd(process.argv[1]),p2=rd(process.argv[2]),w=rd(process.argv[3]);
process.exit(w.startsWith(p1) && w.slice(100,200)===p2 ? 0 : 1);
' "$SMOKE_DIR/phase4_pageread_p1.json" "$SMOKE_DIR/phase4_pageread_p2.json" "$SMOKE_DIR/phase4_pageread_whole.json"; then
  ok "page.continuity" "page1+page2 reconstruct the field with no gap (no skipped middle)"
else
  fail "page.continuity" "paged chunks do not line up with the full field"
fi

# (5) missing field is a structured error, not a throw
miss="$($OVERCAST case memory get "$RID" --field nope --json --case "$casedir" 2>/dev/null)"
assert_eq "page.missing_field" "error" "$(jq -r '.state' <<<"$miss")" "missing field errors cleanly"
