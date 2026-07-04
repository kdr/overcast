#!/usr/bin/env bash
# SKILL: overcast-lineup — "run him through the database" (mugshot book / lineup).
# Drives the skill's documented command chain against REAL face media: stand up a
# local face-cluster DB, book crops into it, browse the lineup gallery, run a
# held-out probe through `cluster identify`, label the hit, and land a cited
# identification finding + tldr note + brief. Proves the cluster verb the skill is
# built on end-to-end, and that the skill's chain produces a briefable result.
#
# Deterministic with OC_CLUSTER_FIXTURE_DIR (two curated people); falls back to
# ingesting OC_LOCAL_FACE_VIDEO. Needs the deepface venv (scripts/visual-db-uv.sh
# --face). Skips cleanly without either.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_lineup
SKILL_FILE="$PWD/skills/overcast-lineup/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE (run overcast skills generate)"; exit 0; }

PY="${OC_VISUAL_DB_PY:-${OVERCAST_VISUAL_DB_PY:-python3}}"
if ! "$PY" - <<'PY' >/dev/null 2>&1
import deepface, numpy  # noqa
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

CASE=$(case_dir skill_lineup)

# 1) skill step: stand up the local face-cluster lineup DB
cond "lineup skill: index create people --type face-cluster --local stands up the DB"
created="$(oc "$CASE" index create people --type face-cluster --local --json)"
ID="$(echo "$created" | jq -r '.payload.index // .payload.id // empty')"
assert_nonempty "$C.index" "$ID" "local face-cluster index created ($ID)"

# 2) skill step: book every case face into the lineup (cluster add)
if [ "$have_fixtures" -eq 1 ]; then
  ingest=(); for f in "$FIXDIR"/willsmith_[0-9]*.jpg "$FIXDIR"/personB_[0-9]*.jpg; do [ -f "$f" ] && ingest+=("$f"); done
  cond "lineup skill: cluster add books curated crops into people (assign-or-create)"
  n=0
  for f in "${ingest[@]}"; do
    st="$(OC_TIMEOUT=600 oc "$CASE" cluster add "$f" --index "$ID" --json | jq -r '.state')"
    [ "$st" = "ready" ] && n=$((n + 1))
  done
  assert_eq "$C.ingest" "${#ingest[@]}" "$n" "all ${#ingest[@]} crops booked ready"
  oc "$CASE" cluster recluster --index "$ID" --json >/dev/null
else
  cond "lineup skill: cluster add books faces from a real video into the lineup"
  add="$(OC_TIMEOUT=600 oc "$CASE" cluster add "$LOCAL_FACE_VIDEO" --index "$ID" --fps "${OC_LOCAL_FACE_FPS:-0.5}" --max-frames "${OC_LOCAL_FACE_MAX_FRAMES:-12}" --json)"
  save_json "80_cluster_add" "$add" >/dev/null
  assert_eq "$C.add_state" "ready" "$(echo "$add" | jq -r '.state')" "cluster add ready"
  cnt="$(echo "$add" | jq -r '.payload.count // 0')"
  assert_nonempty "$C.add_count" "$([ "${cnt:-0}" -ge 1 ] && echo "$cnt")" "booked $cnt face(s)"
  oc "$CASE" cluster recluster --index "$ID" --json >/dev/null
fi

# 3) skill step: open the lineup (self-contained HTML contact sheet)
cond "lineup skill: cluster view renders the lineup contact sheet (the mugshot book)"
list="$(oc "$CASE" cluster list --index "$ID" --json)"; save_json "80_cluster_list" "$list" >/dev/null
people="$(echo "$list" | jq -r '.payload.count // 0')"
assert_nonempty "$C.people" "$([ "${people:-0}" -ge 1 ] && echo "$people")" "lineup holds $people person(s)"
view="$(oc "$CASE" cluster view --index "$ID" --no-open --json)"
viewer="$(echo "$view" | jq -r '.payload.viewer // empty')"
if [ -f "$viewer" ]; then
  cp "$viewer" "$SMOKE_DIR/80_lineup_gallery.html"
  imgs="$(grep -o 'data:image' "$viewer" | wc -l | tr -d ' ')"
  assert_nonempty "$C.gallery" "$([ "${imgs:-0}" -ge 1 ] && echo "$imgs")" "lineup gallery embeds $imgs face crop(s)"
else
  fail "$C.gallery" "no lineup gallery HTML written"
fi

# 4) skill step: run a probe through the database (held-out identify)
IDREF=""; identified_ok=0
if [ "$have_fixtures" -eq 1 ]; then
  cond "lineup skill: cluster identify runs the held-out probe through the DB and names the right person"
  idout="$(oc "$CASE" cluster identify "$FIXDIR/willsmith_ref.jpg" --index "$ID" --json)"; save_json "80_identify" "$idout" >/dev/null
  IDREF="$(echo "$idout" | jq -r '.id // empty')"
  best_cid="$(echo "$idout" | jq -r '.payload.matches[0].candidates[0].cluster_id // empty')"
  best_sim="$(echo "$idout" | jq -r '.payload.matches[0].candidates[0].similarity // 0')"
  best_is_ws="$(echo "$list" | jq -r --arg c "$best_cid" '[.payload.clusters[]|select(.cluster_id==$c)|select(any(.sources[];test("willsmith")))]|length')"
  assert_eq "$C.identify" "1" "${best_is_ws:-0}" "probe matched a Will Smith cluster ($best_cid @ $best_sim)"
  # 5) label + confident finding ONLY when the match is actually correct — a WRONG
  # match already failed the assert above; don't also write a misleading "Will Smith"
  # label + high-confidence identification into the case store.
  if [ "${best_is_ws:-0}" -eq 1 ]; then
    identified_ok=1
    oc "$CASE" cluster label "$best_cid" "Will Smith" --index "$ID" --json >/dev/null
  fi
elif have_media "$LOCAL_FACE_IMAGE"; then
  cond "lineup skill: cluster identify runs a probe image through the DB"
  idout="$(oc "$CASE" cluster identify "$LOCAL_FACE_IMAGE" --index "$ID" --json)"; save_json "80_identify" "$idout" >/dev/null
  IDREF="$(echo "$idout" | jq -r '.id // empty')"
  assert_eq "$C.identify_state" "ready" "$(echo "$idout" | jq -r '.state')" "identify ready"
fi

# 6) skill step: cited identification finding + mandatory tldr note + brief
cond "lineup skill: an identification finding cites the identify record, a tldr note feeds the brief"
if [ "$identified_ok" -eq 1 ]; then
  oc "$CASE" finding create "identified the probe as a known person in the lineup DB — cited to the identify record" --ref "$IDREF" --confidence high --json >/dev/null
elif [ -n "$IDREF" ]; then
  # a probe ran but the identity was not confirmed in-test — record it, not as a confident ID
  oc "$CASE" finding create "ran a probe through the lineup DB (top match ${best_cid:-unknown}); not a confirmed identification" --ref "$IDREF" --confidence low --json >/dev/null
else
  oc "$CASE" finding create "lineup DB built with $people person(s); no probe matched confidently" --confidence low --json >/dev/null
fi
if [ -n "$IDREF" ]; then probe="ran a held-out identify probe"; else probe="no probe image to identify against"; fi
oc "$CASE" note "lineup sweep: booked faces into a local face-cluster DB, clustered into $people people, $probe." --tag tldr --json >/dev/null
findings="$(ocrun "$CASE" case records --verb finding --json 2>/dev/null | jq -r '.payload.count // 0')"
assert_nonempty "$C.finding" "$([ "${findings:-0}" -ge 1 ] && echo "$findings")" "identification finding persisted"
BRIEF="$SMOKE_DIR/80_lineup_brief.html"
oc "$CASE" brief --export "$BRIEF" --theme csi --json >/dev/null
if [ -s "$BRIEF" ] && grep -qi "<html" "$BRIEF"; then
  ok "$C.brief" "lineup brief exported: $BRIEF ($(wc -c <"$BRIEF" | tr -d ' ') bytes)"
else
  fail "$C.brief" "no lineup brief HTML at $BRIEF"
fi
