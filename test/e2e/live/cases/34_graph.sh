#!/usr/bin/env bash
# Real-data knowledge graph: seed a case with real watch/listen evidence via the
# live tinycloud backend plus a tipster note / target / finding, then build
# `graph` (nodes+edges over real records, finding→source provenance, harvested
# entity, self-contained HTML) and run `--extract` against the live turnkey
# brain (extraction stats, caveat, cache round-trip on a re-run).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C="graph"
require_cred "$C" CLOUDGLUE_API_KEY "skipping (graph live case needs real watch evidence + the turnkey brain)" || exit 0

CLIP_A="$SMOKE_DIR/graph_clip_a.mp4"
CLIP_B="$SMOKE_DIR/graph_clip_b.mp4"
have_media "$VIDEO_VISUAL" && clip_av 12 "$VIDEO_VISUAL" "$CLIP_A"
have_media "$VIDEO_SPEECH_SRC" && clip_av 12 "$VIDEO_SPEECH_SRC" "$CLIP_B"
[ -f "$CLIP_A" ] || { skip "$C" "no clip"; exit 0; }

CASE=$(case_dir graph)

cond "graph case seeds a real watch record from a real video"
wa="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP_A" --json)"
assert_eq "$C.watch.state" "ready" "$(echo "$wa" | jq -r '.state')" "watch ready"
WID="$(echo "$wa" | jq -r '.id')"
assert_nonempty "$C.watch.id" "$WID" "watch record id"

ISLAND=0
if [ -f "$CLIP_B" ]; then
  cond "a second, unconnected feed gives --focus something to exclude"
  la="$(OC_TIMEOUT=300 oc "$CASE" listen "$CLIP_B" --json)"
  if [ "$(echo "$la" | jq -r '.state')" = "ready" ]; then
    ok "$C.listen" "listen ready (real transcript feeds --extract)"
    ISLAND=1
  else
    skip "$C.listen" "listen not ready; graph proceeds with one feed"
  fi
fi

cond "human evidence layers on: tipster note, line of investigation, pinned finding"
n="$(oc "$CASE" note 'Tipster tips@graphcase.example flagged this clip on @graphwatch' --ref "$WID" --tag tip --json)"
assert_eq "$C.note.state" "ready" "$(echo "$n" | jq -r '.state')" "note recorded"
t="$(oc "$CASE" target add 'graph smoke line' --question 'does the graph connect real evidence?' --json)"
TID="$(echo "$t" | jq -r '.payload.target.id // .payload.id // empty')"
f="$(oc "$CASE" finding create 'Live graph: corroborated moment' --ref "$WID" ${TID:+--target "$TID"} --json)"
assert_eq "$C.finding.state" "ready" "$(echo "$f" | jq -r '.state')" "finding pinned"
FID="$(echo "$f" | jq -r '.id')"

cond "graph connects the real records into one self-contained board"
GHTML="$SMOKE_DIR/34_graph.html"
g="$(oc "$CASE" graph --export "$GHTML" --theme csi --no-open --json)"
save_json "34_graph" "$g" >/dev/null
assert_eq "$C.verb" "graph" "$(echo "$g" | jq -r '.verb')" "graph record emitted"
assert_eq "$C.state" "ready" "$(echo "$g" | jq -r '.state')" "graph ready"
assert_eq "$C.opened" "false" "$(echo "$g" | jq -r '.payload.opened')" "--no-open honored"
assert_eq "$C.export" "$GHTML" "$(echo "$g" | jq -r '.payload.viewer')" "export path returned"
NODES="$(echo "$g" | jq -r '.payload.nodes')"
EDGES="$(echo "$g" | jq -r '.payload.edges')"
if [ "$NODES" -ge 5 ] 2>/dev/null && [ "$EDGES" -ge 4 ] 2>/dev/null; then
  ok "$C.size" "graph has $NODES nodes / $EDGES edges"
else
  fail "$C.size" "expected >=5 nodes / >=4 edges, got $NODES/$EDGES"
fi
for ty in record media finding target; do
  cnt="$(echo "$g" | jq -r ".payload.by_type.$ty // 0")"
  if [ "$cnt" -ge 1 ] 2>/dev/null; then ok "$C.type_$ty" "$cnt $ty node(s)"; else fail "$C.type_$ty" "no $ty nodes"; fi
done
if echo "$g" | jq -e '.payload.node_list[] | select(.id == "ent:email:tips@graphcase.example")' >/dev/null; then
  ok "$C.entity" "tipster email harvested from the real note"
else
  fail "$C.entity" "email entity missing from node_list"
fi
if echo "$g" | jq -e --arg f "$FID" --arg r "$WID" \
  '.payload.edge_list[] | select(.kind == "finding-source" and .source == ("fnd:" + $f) and .target == ("rec:" + $r))' >/dev/null; then
  ok "$C.finding_source" "finding→source provenance edge present"
else
  fail "$C.finding_source" "finding→source edge missing"
fi
if [ -f "$GHTML" ] && grep -q 'const NODES=' "$GHTML" && ! grep -qE '<script[^>]+src=|<link[^>]+href=' "$GHTML"; then
  ok "$C.html" "self-contained graph HTML exported: $GHTML"
else
  fail "$C.html" "graph HTML missing, or references external assets"
fi

cond "--focus restricts to the watch record's 2-hop neighborhood"
fo="$(oc "$CASE" graph --focus "$WID" --no-open --json)"
save_json "34_graph_focus" "$fo" >/dev/null
FNODES="$(echo "$fo" | jq -r '.payload.nodes')"
if echo "$fo" | jq -e --arg r "$WID" '.payload.node_list[] | select(.id == ("rec:" + $r))' >/dev/null; then
  ok "$C.focus_anchor" "focus anchor present in the subgraph"
else
  fail "$C.focus_anchor" "focus anchor missing from node_list"
fi
if [ "$ISLAND" = "1" ]; then
  if [ "$FNODES" -ge 1 ] 2>/dev/null && [ "$FNODES" -lt "$NODES" ] 2>/dev/null; then
    ok "$C.focus" "--focus narrowed $NODES → $FNODES nodes (island feed excluded)"
  else
    fail "$C.focus" "--focus did not narrow ($NODES → $FNODES)"
  fi
else
  skip "$C.focus" "single feed — nothing beyond 2 hops to exclude"
fi

cond "--extract runs the live brain over real evidence text and caches per record"
x="$(OC_TIMEOUT=600 oc "$CASE" graph --extract --no-open --json)"
save_json "34_graph_extract" "$x" >/dev/null
if [ "$(echo "$x" | jq -r '.payload.extraction.unavailable // empty')" != "" ]; then
  skip "$C.extract" "no brain resolvable in this env — structural graph still rendered"
else
  assert_eq "$C.extract.state" "ready" "$(echo "$x" | jq -r '.state')" "graph --extract ready"
  XRAN="$(echo "$x" | jq -r '.payload.extraction.extracted_records // 0')"
  if [ "$XRAN" -ge 1 ] 2>/dev/null; then ok "$C.extract.ran" "brain extracted $XRAN record(s)"; else fail "$C.extract.ran" "no records extracted"; fi
  if [ "$(echo "$x" | jq -r '.payload.caveat // empty')" != "" ]; then
    ok "$C.extract.caveat" "leads-not-proof caveat stamped"
  else
    fail "$C.extract.caveat" "extraction record missing payload.caveat"
  fi
  if [ -f "$CASE/.overcast/graph/extract.jsonl" ]; then
    ok "$C.extract.cache" "extract.jsonl cache written"
  else
    fail "$C.extract.cache" "no extraction cache at .overcast/graph/extract.jsonl"
  fi
  cond "a --extract re-run serves from the cache instead of re-calling the brain"
  x2="$(OC_TIMEOUT=600 oc "$CASE" graph --extract --no-open --json)"
  save_json "34_graph_extract_rerun" "$x2" >/dev/null
  XCACHED="$(echo "$x2" | jq -r '.payload.extraction.cached_records // 0')"
  if [ "$XCACHED" -ge 1 ] 2>/dev/null; then ok "$C.extract.rerun" "re-run served $XCACHED record(s) from cache"; else fail "$C.extract.rerun" "re-run did not hit the cache"; fi
fi
