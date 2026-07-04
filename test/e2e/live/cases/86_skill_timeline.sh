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
# a NEGATED / agreement phrase means the model denied a conflict — check that FIRST
# so a denial can't trip the positive keyword match below. The negation net allows
# words between "no" and the keyword ("no clear conflict", "no evidence of a
# mismatch") and covers agreement/consistency phrasings.
if echo "$ans" | grep -qiE "no ([a-z]+ ){0,3}(conflict|contradiction|disagree|discrepanc|mismatch|inconsisten)|without (a )?(conflict|contradiction|discrepanc)|(accounts?|clips?|they) (broadly |largely |all )?(agree|are consistent|align|match)|do(es)? not (conflict|disagree|contradict)|no evidence of"; then
  ok "$C.conflict" "answer denied a conflict / reported agreement → no invented finding"
  conflict_summary="no ordering conflicts reported"
elif echo "$ans" | grep -qiE 'conflict|contradict|disagree|discrepanc|inconsist|mismatch|out of order'; then
  cond "timeline skill: a reported cross-clip conflict becomes a low-confidence finding"
  oc "$CASE" finding create "timeline: cross-clip answer reports an ordering conflict — flagged for review" --ref "$W1" --at 1-4 --confidence low --json >/dev/null
  ok "$C.conflict" "answer reported a conflict → finding created"
  conflict_summary="flagged an ordering conflict"
else
  ok "$C.conflict" "no cross-clip conflict reported → no invented finding"
  conflict_summary="no ordering conflicts reported"
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
