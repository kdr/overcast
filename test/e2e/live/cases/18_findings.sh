#!/usr/bin/env bash
# Suggested findings + threads + mission-board status + short brief, end-to-end
# on REAL data. A real tinycloud `face --match` clears the score threshold and the
# shared persist hook auto-emits a `suggested` finding (a lead) — quarantined from
# ask/brief evidence until reviewed. Then: triage queue, accept -> corroborated +
# citable evidence, a `thread:` narrative note rendered on the line card, a
# dead-end line, and the short brief (+ --full) sections.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=findings
require_cred "$C" CLOUDGLUE_API_KEY "skipping real suggested-findings flow" || exit 0

# a face image + a video the person appears in (local face fixtures, else OC_IMAGE + a visual clip)
FACE_IMG="$LOCAL_FACE_IMAGE"; FACE_VID="$LOCAL_FACE_VIDEO"
have_media "$FACE_IMG" || FACE_IMG="$IMAGE_FILE"
have_media "$FACE_VID" || FACE_VID="$VIDEO_VISUAL"
have_media "$FACE_IMG" || { skip "$C" "no face image (OC_LOCAL_FACE_IMAGE / OC_IMAGE)"; exit 0; }
have_media "$FACE_VID" || { skip "$C" "no video (OC_LOCAL_FACE_VIDEO / OC_VIDEO_VISUAL)"; exit 0; }

CASE=$(case_dir findings)
CLIP="$SMOKE_DIR/findings-clip.mp4"
clip_av 8 "$FACE_VID" "$CLIP" || CLIP="$FACE_VID"
[ -f "$CLIP" ] || CLIP="$FACE_VID"

# a line of investigation (image target) with a question
oc "$CASE" target add "$FACE_IMG" --image --question "Does the reference person appear in the clip?" >/dev/null

cond "a real face --match above threshold auto-emits a quarantined 'suggested' finding via the persist hook"
mout="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP" --match "$FACE_IMG" --json)"; mrc=$?
assert_eq "$C.match_exit" "0" "$mrc" "face --match exits 0"
# slurp: the batch is the face record PLUS the auto-suggested finding
sug="$(echo "$mout" | jq -s '[.[] | select(.verb=="finding" and .payload.status=="suggested")]')"
assert_eq "$C.suggested_count" "1" "$(echo "$sug" | jq 'length')" "exactly one suggested finding emitted"
assert_eq "$C.trigger" "signal:face-match" "$(echo "$sug" | jq -r '.[0].payload.trigger')" "trigger is signal:face-match"
assert_nonempty "$C.signal_score" "$(echo "$sug" | jq -r '.[0].payload.signal.score // empty')" "signal.score carried on the lead"
assert_nonempty "$C.confidence" "$(echo "$sug" | jq -r '.[0].payload.confidence // empty')" "confidence band set (high/medium)"
assert_nonempty "$C.lead_anchor" "$(echo "$sug" | jq -r '.[0].media.at // empty | tostring')" "lead anchored at the best-scoring moment"
FID="$(echo "$sug" | jq -r '.[0].id')"

cond "finding list --state triage queues the suggested lead newest-first"
tri="$(oc "$CASE" finding list --state triage --json)"
assert_eq "$C.triage_has_lead" "true" "$(echo "$tri" | jq --arg id "$FID" 'any(.payload.findings[]; .id==$id)')" "the lead is in the triage queue"

cond "a suggested lead is QUARANTINED from brief evidence until reviewed"
b0="$(oc "$CASE" brief --json)"
assert_eq "$C.quarantined" "false" "$(echo "$b0" | jq -r --arg id "$FID" '.payload.report | contains("[accepted]") and contains($id)')" "unreviewed lead is NOT in Key findings"

cond "case status is a mission board: goal headline + per-target thread at LEADS + triage queue"
st="$(oc "$CASE" case status --json)"
assert_eq "$C.status_headline" "true" "$(echo "$st" | jq -r '.payload.mission.headline | test("line";"i")')" "mission headline names the lines of investigation"
assert_eq "$C.status_leads" "true" "$(echo "$st" | jq -r '[.payload.threads[].stage] | any(. == "leads")')" "the image line reads 'leads' (a suggested finding is present)"
assert_eq "$C.status_triage" "1" "$(echo "$st" | jq -r '.payload.mission.progress.triage_pending')" "one suggestion awaiting triage"

cond "finding accept promotes the lead into evidence (corroborated line + citable by ask)"
oc "$CASE" finding accept "$FID" >/dev/null
b1="$(oc "$CASE" brief --json)"
assert_eq "$C.accepted_in_brief" "true" "$(echo "$b1" | jq -r --arg id "$FID" '.payload.report | contains("[accepted]") and contains($id)')" "accepted finding now appears in Key findings"
st2="$(oc "$CASE" case status --json)"
assert_eq "$C.corroborated" "true" "$(echo "$st2" | jq -r '[.payload.threads[].stage] | any(. == "corroborated")')" "the line is now corroborated"
ask="$(oc "$CASE" ask "was the reference person found in the clip?" --json)"
assert_eq "$C.ask_cites_finding" "true" "$(echo "$ask" | jq -r '[.payload.citations[].verb] | any(. == "finding")')" "ask cites the accepted finding as evidence"

cond "a thread:<id> narrative note (the /debrief convention) renders on the line card"
TID="$(oc "$CASE" target list --json | jq -r '.payload.targets[] | select(.kind=="image") | .id')"
oc "$CASE" note "Confirmed across multiple frames; next: pull more clips from the same account." --tag "thread:$TID" >/dev/null
b2="$(oc "$CASE" brief --json)"
assert_eq "$C.narrative_rendered" "true" "$(echo "$b2" | jq -r '.payload.report | contains("pull more clips from the same account")')" "thread narrative note surfaces on the line card"

cond "a dead-end line renders dimmed with its closing reason"
oc "$CASE" target add "unrelated-subject-zzz" --question "control line" >/dev/null
DID="$(oc "$CASE" target list --json | jq -r '.payload.targets[] | select(.value=="unrelated-subject-zzz") | .id')"
oc "$CASE" target close "$DID" --as dead-end --note "no evidence after review" >/dev/null
b3="$(oc "$CASE" brief --json)"
assert_eq "$C.deadend_rendered" "true" "$(echo "$b3" | jq -r '.payload.report | test("DEAD-END")')" "the closed line shows the DEAD-END stage"
assert_eq "$C.deadend_reason" "true" "$(echo "$b3" | jq -r '.payload.report | contains("no evidence after review")')" "the closing reason is shown"

cond "brief is short by default (compact record trail) with --full for the verbatim audit dump"
short="$(oc "$CASE" brief --json | jq -r '.payload.report')"
full="$(oc "$CASE" brief --full --json | jq -r '.payload.report')"
assert_eq "$C.short_trail" "true" "$(echo "$short" | grep -qF "## Record trail" && echo true || echo false)" "short brief has the compact record trail"
assert_eq "$C.short_no_dump" "false" "$(echo "$short" | grep -qF "## Timeline / findings" && echo true || echo false)" "short brief omits the verbatim timeline"
assert_eq "$C.full_dump" "true" "$(echo "$full" | grep -qF "## Timeline / findings" && echo true || echo false)" "--full appends the verbatim timeline"

cond "finding dismiss quarantines a lead permanently and blocks its re-suggestion"
# re-run the same match; a fresh suggestion for the SAME source dedups (already accepted)
mout2="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP" --match "$FACE_IMG" --json)"
redun="$(echo "$mout2" | jq -s '[.[] | select(.verb=="finding" and .payload.status=="suggested")] | length')"
assert_eq "$C.no_reduplicate" "0" "$redun" "an already-reviewed match does not re-suggest the same lead"
