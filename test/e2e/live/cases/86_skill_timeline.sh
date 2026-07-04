#!/usr/bin/env bash
# SKILL: overcast-timeline — "walk me through that night" (event reconstruction).
# Drives the skill's chain against REAL clips: sense multiple recordings of one
# event, cross-anchor shared moments with span notes, ask across the clips to
# order events and surface contradictions, and export one chronological brief.
#
# Needs Cloudglue + at least one real clip (a second clip makes the cross-anchor +
# contradiction legs real; otherwise the case degrades to one feed).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_timeline
SKILL_FILE="$PWD/skills/overcast-timeline/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE"; exit 0; }
require_cred "$C" CLOUDGLUE_API_KEY "timeline reconstruction needs a sense backend" || exit 0
have_media "$VIDEO_VISUAL" || { skip "$C" "no OC_VIDEO_VISUAL"; exit 0; }

CASE=$(case_dir skill_timeline)
CLIP1="$SMOKE_DIR/timeline_clip1.mp4"; clip_av 10 "$VIDEO_VISUAL" "$CLIP1"

# 1) skill step: sense every clip (watch the visual timeline)
cond "timeline skill: watch the first clip into the case"
w1="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP1" --json)"
W1="$(echo "$w1" | jq -r '.id // empty')"
assert_eq "$C.clip1" "ready" "$(echo "$w1" | jq -r '.state')" "clip 1 sensed"
assert_nonempty "$C.clip1_id" "$W1" "clip 1 record id"

# a second recording of the "event" — another video (watch) or the speech clip (listen)
W2=""
if have_media "$VIDEO_OBJECTS" && [ "$VIDEO_OBJECTS" != "$VIDEO_VISUAL" ]; then
  CLIP2="$SMOKE_DIR/timeline_clip2.mp4"; clip_av 10 "$VIDEO_OBJECTS" "$CLIP2"
  cond "timeline skill: a second real recording of the event joins the case"
  w2="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP2" --json)"
  W2="$(echo "$w2" | jq -r '.id // empty')"
  assert_eq "$C.clip2" "ready" "$(echo "$w2" | jq -r '.state')" "clip 2 sensed"
elif have_media "$VIDEO_SPEECH_SRC"; then
  CLIP2="$SMOKE_DIR/timeline_clip2.mp4"; clip_av 12 "$VIDEO_SPEECH_SRC" "$CLIP2"
  cond "timeline skill: a second recording (audio account) joins the case"
  w2="$(OC_TIMEOUT=300 oc "$CASE" listen "$CLIP2" --json)"
  W2="$(echo "$w2" | jq -r '.id // empty')"
  assert_eq "$C.clip2" "ready" "$(echo "$w2" | jq -r '.state')" "clip 2 sensed (listen)"
else
  skip "$C.clip2" "only one clip available — cross-anchor runs on a single feed"
fi

# 2) skill step: cross-anchor shared moments with span notes
cond "timeline skill: span notes anchor moments so clips can be lined up on one timeline"
oc "$CASE" note "anchor: event start on clip 1" --ref "$W1" --at 1-4 --tag anchor --json >/dev/null
[ -n "$W2" ] && oc "$CASE" note "anchor: corresponding moment on clip 2" --ref "$W2" --at 0-3 --tag anchor --json >/dev/null
anchors="$(cat "$CASE/.overcast/records/note.jsonl" 2>/dev/null | jq -s '[.[]|select((.payload.tags // [])|index("anchor"))]|length')"
assert_nonempty "$C.anchors" "$([ "${anchors:-0}" -ge 1 ] && echo "$anchors")" "$anchors anchor note(s) persisted"

# 3) skill step: ask across the clips to order events + surface contradictions
cond "timeline skill: ask orders the events across clips and flags conflicts"
ask="$(OC_TIMEOUT=180 oc "$CASE" ask "order the events across all clips with timestamps; where do the accounts agree or conflict? cite record.id + media.at" --json)"
save_json "86_ask" "$ask" >/dev/null
assert_eq "$C.ask_state" "ready" "$(echo "$ask" | jq -r '.state')" "cross-clip ask ready"
ans="$(echo "$ask" | jq -r '(.payload.answer // .payload.text // .payload.summary // "")')"
assert_nonempty "$C.ask_answer" "$ans" "ask returned a cited chronological answer"

# 4) skill step: turn a REAL cross-clip contradiction into a finding — only when the
# answer actually reports one (the skill says flag real conflicts, not invent one
# every run); the chronological brief is the deliverable regardless.
# STRIP the negation/agreement phrases first, THEN look for a conflict keyword in
# what's left. This way an answer that reports BOTH alignment AND a real conflict
# ("the clips align on the arrival but conflict on the shout order") still trips the
# finding — a plain negation-first check would have suppressed it.
low="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
stripped="$(printf '%s' "$low" | sed -E \
  -e 's/no ([a-z]+ ){0,3}(conflict|contradiction|disagree|discrepanc|mismatch|inconsisten)//g' \
  -e 's/without (a )?(conflict|contradiction|discrepanc)//g' \
  -e 's/(accounts?|clips?|they) (broadly |largely |all )?(agree|are consistent|align|match)//g' \
  -e 's/does? not (conflict|disagree|contradict)//g' \
  -e 's/no evidence of [a-z ]*//g')"
# positive match = a real DISAGREEMENT in the accounts, not any "inconsistency":
# the strong verbs (conflict/contradict/disagree) or an explicit ordering mismatch.
# loose nouns (inconsistent/mismatch/discrepancy) are only used in the negation
# strip above — an answer like "lighting is inconsistent but no ordering conflict"
# must NOT file a finding.
# the grep detects a cross-clip DISAGREEMENT; it can't reliably tell an ordering
# disagreement from a detail disagreement (a car's colour) from free text, so the
# finding is worded as a general "disagreement flagged for review" (low confidence,
# for a human to resolve) rather than over-claiming an ORDERING conflict.
if printf '%s' "$stripped" | grep -qE 'conflict|contradict|disagree|(different|opposite|wrong|reversed) order|out of (sequence|order)|order[a-z ]*(differ|disagree)'; then
  cond "timeline skill: a reported cross-clip disagreement becomes a low-confidence finding"
  # the answer text names which clips/moments disagree; we can't parse that reliably,
  # so DON'T pin the finding to a specific clip+span (a fixed --ref W1 --at 1-4 would
  # mis-anchor a conflict about the second recording). Leave it a case-level lead.
  oc "$CASE" finding create "timeline: cross-clip answer reports a disagreement between the accounts — flagged for review (see the ask answer for the specific clips + moments)" --confidence low --json >/dev/null
  ok "$C.conflict" "answer reported a real disagreement (survived negation strip) → finding created"
  conflict_summary="flagged a cross-clip disagreement"
else
  ok "$C.conflict" "answer reported agreement / denied a disagreement → no invented finding"
  conflict_summary="no cross-clip disagreements reported"
fi
nclips=1; [ -n "$W2" ] && nclips=2
oc "$CASE" note "timeline: reconstructed the event across $nclips clip(s); anchored shared moments; $conflict_summary." --tag tldr --json >/dev/null
BRIEF="$SMOKE_DIR/86_timeline_brief.html"
oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
if [ -s "$BRIEF" ] && grep -qi "<html" "$BRIEF"; then
  ok "$C.brief" "chronological timeline brief exported: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
else
  fail "$C.brief" "no timeline brief HTML at $BRIEF"
fi
