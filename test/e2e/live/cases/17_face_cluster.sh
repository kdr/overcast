#!/usr/bin/env bash
# Real local face CLUSTERING end-to-end. Exercises BOTH sides:
#   setup  — the `case setup` wizard provisions a local face-cluster index
#            alongside a media index (proves wizard integration).
#   query  — `cluster add` ingests real face crops and assign-or-creates people,
#            `recluster` groups them, a HELD-OUT `identify` matches the right
#            person (with a wide similarity gap), `label`/`view` browse the DB,
#            and a headless-agent JSONL trace shows the agent invoking the tool.
#
# Deterministic when OC_CLUSTER_FIXTURE_DIR holds curated crops
# (willsmith_ref.jpg + willsmith_N.jpg + personB_N.jpg — two distinct people);
# falls back to ingesting OC_LOCAL_FACE_VIDEO when only the raw video is set.
# Skips cleanly without the deepface venv or any fixtures.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$LIVE/lib.sh"
C=cluster

# --- deepface venv (Facenet512 + retinaface, both hard deepface deps) ---
PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import deepface, numpy
PY
then
  skip "$C.deps" "deepface/numpy missing in $PY (build it: scripts/visual-db-uv.sh --face)"
  exit 0
fi

FIXDIR="${OC_CLUSTER_FIXTURE_DIR:-}"
have_fixtures=0
[ -n "$FIXDIR" ] && [ -f "$FIXDIR/willsmith_ref.jpg" ] && have_fixtures=1
if [ "$have_fixtures" -eq 0 ] && ! have_media "$LOCAL_FACE_VIDEO"; then
  skip "$C" "no OC_CLUSTER_FIXTURE_DIR crops and no OC_LOCAL_FACE_VIDEO"
  exit 0
fi

CASE=$(case_dir cluster)

# ---- SETUP SIDE: the wizard stands up a face-cluster DB alongside another index ----
cond "case setup provisions a local face-cluster index alongside another local index"
setup="$(oc "$CASE" case setup --index "faces:face-cluster,logos:image-ransac" --yes --json)"
# `case setup --yes` emits a JSONL stream (the setup record + each index create) —
# assert the setup record itself is ready and nothing in the stream errored.
setup_state="$(echo "$setup" | jq -rs '[.[]|select((.payload.op // "")|test("startup_setup"))][0].state // "missing"')"
setup_errs="$(echo "$setup" | jq -rs '[.[]|select(.state=="error")]|length')"
assert_eq "$C.setup_state" "ready" "$setup_state" "case setup record is ready"
assert_eq "$C.setup_no_errors" "0" "$setup_errs" "no record in the setup stream errored"
ID="$(oc "$CASE" index list --json | jq -r '[.payload.indexes[]|select(.type=="face-cluster")][0].id // empty')"
assert_nonempty "$C.setup_index" "$ID" "wizard created a local face-cluster index ($ID)"
sig="$(jq -r '[.indexes[]?|select(.type=="face-cluster")|.default_signals[]?]|join(",")' "$CASE/.overcast/setup.json" 2>/dev/null)"
assert_eq "$C.setup_signal" "cluster add" "$sig" "setup routes the face DB via the 'cluster add' signal"

# ---- QUERY SIDE ----
if [ "$have_fixtures" -eq 1 ]; then
  # Deterministic: ingest willsmith_N + personB_N crops, HOLD OUT willsmith_ref.
  ingest=(); for f in "$FIXDIR"/willsmith_[0-9]*.jpg "$FIXDIR"/personB_[0-9]*.jpg; do [ -f "$f" ] && ingest+=("$f"); done
  cond "cluster add ingests curated face crops (assign-or-create) and returns ready records"
  n=0
  for f in "${ingest[@]}"; do
    st="$(OC_TIMEOUT=600 oc "$CASE" cluster add "$f" --index "$ID" --json | jq -r '.state')"
    [ "$st" = "ready" ] && n=$((n + 1))
  done
  assert_eq "$C.ingest_all" "${#ingest[@]}" "$n" "all ${#ingest[@]} crops ingested ready"

  cond "recluster groups the crops into at least the two real people"
  re="$(oc "$CASE" cluster recluster --index "$ID" --json)"
  assert_eq "$C.recluster_state" "ready" "$(echo "$re" | jq -r '.state')" "recluster ready"
  list="$(oc "$CASE" cluster list --index "$ID" --json)"; save_json "cluster_list" "$list" >/dev/null
  people="$(echo "$list" | jq -r '.payload.count')"
  if [ "${people:-0}" -ge 2 ]; then ok "$C.people" "clustered into $people people"; else fail "$C.people" "expected >=2 people, got ${people:-0}"; fi

  # HELD-OUT identify: the reference must match a Will Smith cluster, and beat the
  # other person by a wide margin (the real proof clustering separates identities).
  cond "held-out identify matches the Will Smith reference to a Will Smith cluster, far above the other person"
  idout="$(oc "$CASE" cluster identify "$FIXDIR/willsmith_ref.jpg" --index "$ID" --json)"; save_json "identify" "$idout" >/dev/null
  best_cid="$(echo "$idout" | jq -r '.payload.matches[0].candidates[0].cluster_id')"
  best_sim="$(echo "$idout" | jq -r '.payload.matches[0].candidates[0].similarity')"
  second_sim="$(echo "$idout" | jq -r '.payload.matches[0].candidates[1].similarity // 0')"
  best_is_ws="$(echo "$list" | jq -r --arg c "$best_cid" '[.payload.clusters[]|select(.cluster_id==$c)|select(any(.sources[];test("willsmith")))]|length')"
  assert_eq "$C.identify_person" "1" "${best_is_ws:-0}" "closest cluster ($best_cid) is a Will Smith cluster"
  if awk "BEGIN{exit !($best_sim > $second_sim + 15)}"; then
    ok "$C.identify_gap" "similarity gap is wide ($best_sim vs $second_sim)"
  else
    fail "$C.identify_gap" "similarity gap too small ($best_sim vs $second_sim)"
  fi

  cond "label names a person and view renders a self-contained HTML gallery with embedded crops"
  oc "$CASE" cluster label "$best_cid" "Will Smith" --index "$ID" --json >/dev/null
  view="$(oc "$CASE" cluster view --index "$ID" --no-open --json)"
  viewer="$(echo "$view" | jq -r '.payload.viewer')"
  if [ -f "$viewer" ]; then
    cp "$viewer" "$SMOKE_DIR/cluster_gallery.html"
    imgs="$(grep -o 'data:image' "$viewer" | wc -l | tr -d ' ')"
    assert_nonempty "$C.gallery_imgs" "$([ "${imgs:-0}" -ge 1 ] && echo "$imgs")" "gallery embeds $imgs base64 face crops"
    if grep -q "Will Smith" "$viewer"; then ok "$C.gallery_label" "gallery shows the assigned label"; else fail "$C.gallery_label" "label missing from gallery"; fi
  else
    fail "$C.gallery" "no gallery HTML written"
  fi
else
  # Fallback: ingest the raw face video directly (looser assertions).
  FACE_FPS="${OC_LOCAL_FACE_FPS:-0.5}"; FACE_FRAMES="${OC_LOCAL_FACE_MAX_FRAMES:-12}"
  cond "cluster add ingests faces from a real video and persists a face-cluster store"
  add="$(OC_TIMEOUT=600 oc "$CASE" cluster add "$LOCAL_FACE_VIDEO" --index "$ID" --fps "$FACE_FPS" --max-frames "$FACE_FRAMES" --json)"
  save_json "cluster_add" "$add" >/dev/null
  assert_eq "$C.add_state" "ready" "$(echo "$add" | jq -r '.state')" "cluster add ready"
  cnt="$(echo "$add" | jq -r '.payload.count // 0')"
  if [ "${cnt:-0}" -ge 1 ]; then ok "$C.add_count" "ingested $cnt face(s)"; else fail "$C.add_count" "no faces ingested"; fi
  oc "$CASE" cluster recluster --index "$ID" --json >/dev/null
  view="$(oc "$CASE" cluster view --index "$ID" --no-open --json)"
  viewer="$(echo "$view" | jq -r '.payload.viewer')"
  [ -f "$viewer" ] && cp "$viewer" "$SMOKE_DIR/cluster_gallery.html"
  if have_media "$LOCAL_FACE_IMAGE"; then
    idout="$(oc "$CASE" cluster identify "$LOCAL_FACE_IMAGE" --index "$ID" --json)"
    assert_eq "$C.identify_state" "ready" "$(echo "$idout" | jq -r '.state')" "identify ready"
  fi
fi

# ---- store persistence ----
cond "the face-cluster store persists on disk (faces + clusters)"
store="$CASE/.overcast/index/$ID"
if [ -f "$store/faces.jsonl" ] && [ -f "$store/clusters.json" ]; then
  ok "$C.persisted" "faces.jsonl + clusters.json written under the index dir"
else
  fail "$C.persisted" "cluster store files missing under $store"
fi

# ---- HEADLESS AGENT MODE: the agent invokes the cluster tool (JSONL trace) ----
if require_cred "$C.agent" CLOUDGLUE_API_KEY "headless cluster agent needs a brain LLM"; then
  cond "a headless agent invokes the cluster tool over the face DB and the JSONL trace proves it"
  trace="$(OC_TIMEOUT=300 oc "$CASE" --mode json "Use the cluster tool to list the people in face-cluster index $ID. Report only how many people there are. Do not add notes or findings.")"
  printf '%s' "$trace" >"$SMOKE_DIR/cluster_agent_trace.jsonl"
  invalid=0; nlines=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    nlines=$((nlines + 1))
    printf '%s' "$line" | jq -e . >/dev/null 2>&1 || invalid=$((invalid + 1))
  done <<<"$trace"
  assert_eq "$C.agent_trace_valid" "0" "$invalid" "agent trace is valid JSONL ($nlines lines)"
  tool_names="$(jq -sr '[.[]|select(.type=="agent_end")|.messages[]?|select(.role=="assistant")|.content[]?|select(.type=="toolCall")|.name]|join(",")' <<<"$trace" 2>/dev/null)"
  if printf '%s' "$tool_names" | grep -q "cluster"; then
    ok "$C.agent_tool" "agent trace invoked the cluster tool"
  else
    fail "$C.agent_tool" "cluster not in agent tool calls: ${tool_names:-<none>}"
  fi
  ready="$(jq -sr '[.[]|select(.type=="agent_end")|.messages[]?|select(.role=="toolResult")|.details.records[]?|select(.verb=="cluster" and .state=="ready")]|length' <<<"$trace" 2>/dev/null)"
  if [ "${ready:-0}" -ge 1 ]; then
    ok "$C.agent_record" "agent received a ready cluster record"
  else
    fail "$C.agent_record" "no ready cluster record in the agent trace"
  fi
fi
