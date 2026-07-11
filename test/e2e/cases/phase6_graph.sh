#!/usr/bin/env bash
# Phase 6 e2e: the case knowledge graph (offline — no providers, no ffmpeg).
# Seeds a case with notes/target/finding evidence, then asserts `graph` builds
# nodes+edges over it (records, media, entities, finding→source, target link),
# honors --focus, and writes ONE self-contained HTML viewer with no egress.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_graph"; mkdir -p "$casedir"

# the registry lists graph (one spec → CLI/tool/skill)
if $OVERCAST commands --json | jq -r '.verbs[].name' | grep -qx "graph"; then
  ok "graph.verb_surface" "commands --json lists graph"
else
  fail "graph.verb_surface" "graph missing from commands --json"
fi

# empty case → transient pending guidance, no artifact
eout="$($OVERCAST graph --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_empty" "$eout" >/dev/null
assert_eq "graph.empty_state" "pending" "$(jq -r '.state' <<<"$eout")" "empty case is pending guidance"
if [ ! -f "$casedir/.overcast/media/graph.html" ]; then
  ok "graph.empty_no_artifact" "no graph.html written for an empty case"
else
  fail "graph.empty_no_artifact" "graph.html written despite empty case"
fi

# seed evidence: an entity-bearing note, a note chained to it, a target line,
# and a manual finding sourced from the first note + stamped onto the target
n1="$($OVERCAST note 'Tipster sam@vanwatch.example says @vanspotter posted the white van on https://vanwatch.example/sightings' --tag tip --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_note1" "$n1" >/dev/null
n1_id="$(jq -r '.id' <<<"$n1")"
assert_eq "graph.seed_note" "ready" "$(jq -r '.state' <<<"$n1")" "entity-bearing note recorded"
n2="$($OVERCAST note 'Follow-up: the same handle re-posted the sighting' --ref "$n1_id" --tag tip --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_note2" "$n2" >/dev/null
# an unconnected island note — --focus must exclude it (>2 hops from the tipster)
n3="$($OVERCAST note 'Background: courthouse camera offline for maintenance' --tag background --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_note3" "$n3" >/dev/null
tgt="$($OVERCAST target add 'white van' --question 'who is moving the white van?' --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_target" "$tgt" >/dev/null
tgt_id="$(jq -r '.payload.target.id // .payload.id // empty' <<<"$tgt")"
fnd="$($OVERCAST finding create 'white van sighting corroborated by tipster' --ref "$n1_id" ${tgt_id:+--target "$tgt_id"} --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_finding" "$fnd" >/dev/null
assert_eq "graph.seed_finding" "ready" "$(jq -r '.state' <<<"$fnd")" "manual finding recorded"

# graph --no-open: ready record with a node/edge projection over the seeds
gout="$($OVERCAST graph --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph" "$gout" >/dev/null
assert_eq "graph.verb" "graph" "$(jq -r '.verb' <<<"$gout")" "graph emits graph record"
assert_eq "graph.state" "ready" "$(jq -r '.state' <<<"$gout")" "graph ready"
assert_eq "graph.opened" "false" "$(jq -r '.payload.opened' <<<"$gout")" "--no-open honored"
nodes="$(jq -r '.payload.nodes' <<<"$gout")"
edges="$(jq -r '.payload.edges' <<<"$gout")"
if [ "$nodes" -ge 5 ] 2>/dev/null && [ "$edges" -ge 4 ] 2>/dev/null; then
  ok "graph.size" "graph has $nodes nodes / $edges edges"
else
  fail "graph.size" "expected >=5 nodes / >=4 edges, got $nodes/$edges"
fi
for t in record finding target entity; do
  count="$(jq -r ".payload.by_type.$t // 0" <<<"$gout")"
  if [ "$count" -ge 1 ] 2>/dev/null; then ok "graph.type_$t" "$count $t node(s)"; else fail "graph.type_$t" "no $t nodes in by_type"; fi
done
if jq -e '.payload.node_list[] | select(.id == "ent:email:sam@vanwatch.example")' <<<"$gout" >/dev/null; then
  ok "graph.entity_email" "tipster email harvested as an entity node"
else
  fail "graph.entity_email" "email entity missing from node_list"
fi
if jq -e --arg f "$(jq -r '.id' <<<"$fnd")" --arg r "$n1_id" \
  '.payload.edge_list[] | select(.kind == "finding-source" and .source == ("fnd:" + $f) and .target == ("rec:" + $r))' <<<"$gout" >/dev/null; then
  ok "graph.finding_source" "finding→source edge present"
else
  fail "graph.finding_source" "finding→source edge missing"
fi
ghtml="$(jq -r '.payload.viewer' <<<"$gout")"
if [ -f "$ghtml" ]; then ok "graph.html_written" "graph html generated at $ghtml"; else fail "graph.html_written" "no graph html at $ghtml"; fi
if grep -q 'const NODES=' "$ghtml" && ! grep -qE '<script[^>]+src=|<link[^>]+href=' "$ghtml"; then
  ok "graph.html_selfcontained" "data inlined, no external script/link"
else
  fail "graph.html_selfcontained" "graph html references external assets or lacks inlined data"
fi

# --focus: 2-hop neighborhood of the tipster email only
fout="$($OVERCAST graph --focus 'sam@vanwatch.example' --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_focus" "$fout" >/dev/null
fnodes="$(jq -r '.payload.nodes' <<<"$fout")"
if [ "$fnodes" -ge 1 ] 2>/dev/null && [ "$fnodes" -lt "$nodes" ] 2>/dev/null; then
  ok "graph.focus" "--focus narrowed $nodes → $fnodes nodes"
else
  fail "graph.focus" "--focus did not narrow the graph ($nodes → $fnodes)"
fi

# focus miss → pending guidance, not a silent full graph
mout="$($OVERCAST graph --focus 'no-such-node-anywhere' --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase6_graph_focus_miss" "$mout" >/dev/null
assert_eq "graph.focus_miss" "pending" "$(jq -r '.state' <<<"$mout")" "focus miss is pending guidance"
