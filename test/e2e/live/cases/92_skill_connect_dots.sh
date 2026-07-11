#!/usr/bin/env bash
# SKILL: overcast-connect-the-dots — "string the board" (case knowledge graph).
# Drives the skill's documented chain with NO creds (pure local): seed a mini
# investigation whose evidence shares typed entities (an email + a handle across
# two notes), open the line, stamp a finding onto it, then build the interactive
# force-graph (csi theme) and a 2-hop --focus view anchored on the shared email.
# Proves the graph verb the skill is built on end-to-end: entity harvest, the
# target↔evidence thread matcher, and finding→target edges all land in the HTML.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_connect
SKILL_FILE="$PWD/skills/overcast-connect-the-dots/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE (run overcast skills generate)"; exit 0; }

CASE=$(case_dir skill_connect)
EMAIL="night.courier77@proton.me"

# 1) skill step: open the line of investigation (value doubles as the thread text)
cond "connect-dots skill: target add opens the line the board threads onto"
tout="$(oc "$CASE" target add '@night_courier' --question 'Who is behind the @night_courier drops?' --json)"
save_json "92_connect_target" "$tout" >/dev/null
tstate="$(echo "$tout" | jq -s -r '[.[]|select(.verb=="target")][0].state // ""' 2>/dev/null)"
assert_eq "$C.target" "ready" "$tstate" "line of investigation opened"

# 2) skill step: land evidence that shares typed entities across records
cond "connect-dots skill: two notes share an email + handle (entity harvest fodder)"
n1="$(oc "$CASE" note "Dropbox flyer in the Mission lists contact $EMAIL and handle @night_courier" --tag lead --json)"
n2="$(oc "$CASE" note "Second flyer near the Embarcadero — different design, same $EMAIL address" --tag lead --json)"
save_json "92_connect_note1" "$n1" >/dev/null
save_json "92_connect_note2" "$n2" >/dev/null
n1id="$(echo "$n1" | jq -s -r '[.[]|select(.verb=="note")][0].id // empty' 2>/dev/null)"
assert_nonempty "$C.notes" "$n1id" "notes landed as evidence records"

# 3) skill step: promote the connection onto the line
cond "connect-dots skill: finding create --target stamps the link onto the line"
fout="$(oc "$CASE" finding create "Same contact email on both flyers — one operator behind @night_courier" --target '@night_courier' --ref "$n1id" --json)"
save_json "92_connect_finding" "$fout" >/dev/null
fstate="$(echo "$fout" | jq -s -r '[.[]|select(.verb=="finding")][0].state // ""' 2>/dev/null)"
assert_eq "$C.finding" "ready" "$fstate" "finding stamped onto the line"

# 4) skill step: build the board — one self-contained interactive force-graph
cond "connect-dots skill: graph --no-open renders the knowledge graph (csi theme)"
GRAPH_HTML="$SMOKE_DIR/92_connect_graph.html"
gout="$(oc "$CASE" graph --no-open --theme csi --export "$GRAPH_HTML" --json)"
save_json "92_connect_graph" "$gout" >/dev/null
gstate="$(echo "$gout" | jq -s -r '[.[]|select(.verb=="graph")][0].state // ""' 2>/dev/null)"
assert_eq "$C.graph" "ready" "$gstate" "graph rendered"
nodes="$(echo "$gout" | jq -s -r '[.[]|select(.verb=="graph")][0].payload.nodes // 0' 2>/dev/null)"
edges="$(echo "$gout" | jq -s -r '[.[]|select(.verb=="graph")][0].payload.edges // 0' 2>/dev/null)"
if [ "${nodes:-0}" -gt 0 ] 2>/dev/null && [ "${edges:-0}" -gt 0 ] 2>/dev/null; then
  ok "$C.graph_size" "board has $nodes nodes / $edges edges"
else
  fail "$C.graph_size" "empty board (nodes=$nodes edges=$edges)"
fi
if grep -qF "$EMAIL" "$GRAPH_HTML" 2>/dev/null; then
  ok "$C.graph_entity" "shared email harvested as an entity node in the HTML"
else
  fail "$C.graph_entity" "shared email missing from the graph HTML"
fi
if grep -qF "night_courier" "$GRAPH_HTML" 2>/dev/null; then
  ok "$C.graph_thread" "target/handle thread present in the board"
else
  fail "$C.graph_thread" "target/handle thread missing from the board"
fi

# 5) skill step: the 2-hop --focus view anchored on the shared entity
cond "connect-dots skill: graph --focus <entity> trims to the 2-hop neighborhood"
FOCUS_HTML="$SMOKE_DIR/92_connect_focus.html"
gfout="$(oc "$CASE" graph --focus "$EMAIL" --no-open --theme csi --export "$FOCUS_HTML" --json)"
save_json "92_connect_focus" "$gfout" >/dev/null
gfstate="$(echo "$gfout" | jq -s -r '[.[]|select(.verb=="graph")][0].state // ""' 2>/dev/null)"
assert_eq "$C.focus" "ready" "$gfstate" "focused board rendered"
fnodes="$(echo "$gfout" | jq -s -r '[.[]|select(.verb=="graph")][0].payload.nodes // 0' 2>/dev/null)"
if [ "${fnodes:-0}" -gt 0 ] 2>/dev/null && [ "$fnodes" -le "${nodes:-0}" ] 2>/dev/null; then
  ok "$C.focus_trim" "focus view kept $fnodes of $nodes nodes (anchor neighborhood)"
else
  fail "$C.focus_trim" "focus view node count unexpected ($fnodes of $nodes)"
fi
