#!/usr/bin/env bash
# Offline reconstruct e2e (NO fal, NO keys): the fixture provider drives the REAL
# CLI router → verb → exec provider → outputs[] fan-out → sweep assembly
# (internal ffmpeg contact sheet + turntable) → viewers → evidence quarantine.
# Isolated OVERCAST_HOME so the fixture binding never leaks into other phases.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

export OVERCAST_HOME="$SMOKE_DIR/reconstruct_home"
mkdir -p "$OVERCAST_HOME"
casedir="$SMOKE_DIR/reconstruct_case"
mkdir -p "$casedir"

# a REAL png so the sweep's contact-sheet + turntable ffmpeg passes run for real
img="$SMOKE_DIR/reconstruct_scene.png"
node --import tsx -e "
import {FFMPEG_PATH} from '$REPO/src/media/ffmpeg.ts';
import {execFileSync} from 'node:child_process';
execFileSync(FFMPEG_PATH,['-y','-f','lavfi','-i','testsrc=size=96x64','-frames:v','1','$img'],{stdio:'ignore'});
" 2>/dev/null
if [ ! -f "$img" ]; then fail "reconstruct.fixture_png" "could not synthesize test image"; exit 0; fi

# unbound → actionable bind guidance, never a crash (reconstruct has no builtin)
uout="$($OVERCAST reconstruct "$img" --rotate 45 --json --case "$casedir" 2>/dev/null)"
save_json "reconstruct_unbound" "$uout" >/dev/null
assert_eq "reconstruct.unbound_state" "error" "$(jq -r '.state' <<<"$uout")" "unbound reconstruct errors"
echo "$uout" | jq -r '.error' | grep -q "provider setup apply --verb reconstruct" \
  && ok "reconstruct.unbound_msg" "error names the bind command" \
  || fail "reconstruct.unbound_msg" "error: $(jq -r '.error' <<<"$uout")"

# bind the offline fixture through the real profile machinery
$OVERCAST setup provider reconstruct "exec:bash $REPO/test/fixtures/fake-reconstruct.sh --input {{input}}" --json >/dev/null 2>&1

# --rotate → parent + 1 synthesized view child, caveat stamped on BOTH (the
# fixture deliberately omits it — the verb must inject it)
rout="$($OVERCAST reconstruct "$img" --rotate 45 --json --case "$casedir" 2>/dev/null | jq -sc '.')"
save_json "reconstruct_view" "$rout" >/dev/null
assert_eq "reconstruct.view_records" "2" "$(jq 'length' <<<"$rout")" "parent + 1 view child"
assert_eq "reconstruct.view_state" "ready" "$(jq -r '.[0].state' <<<"$rout")" "parent ready"
assert_eq "reconstruct.child_kind" "view" "$(jq -r '.[1].payload.kind' <<<"$rout")" "child is a synthesized view"
jq -r '.[0].payload.caveat' <<<"$rout" | grep -q "NOT photographic evidence" \
  && ok "reconstruct.parent_caveat" "caveat stamped on the parent" \
  || fail "reconstruct.parent_caveat" "parent caveat: $(jq -r '.[0].payload.caveat' <<<"$rout")"
jq -r '.[1].payload.caveat' <<<"$rout" | grep -q "NOT photographic evidence" \
  && ok "reconstruct.child_caveat" "caveat stamped on the child" \
  || fail "reconstruct.child_caveat" "child caveat: $(jq -r '.[1].payload.caveat' <<<"$rout")"
vref="$(jq -r '.[1].media.ref' <<<"$rout")"
if [ -f "$vref" ]; then ok "reconstruct.view_output" "synthesized view written"; else fail "reconstruct.view_output" "no view at $vref"; fi

# --ops sweep → per-stop children + a contact sheet + a turntable mp4 assembled
# by the internal ffmpeg (kind:"sheet" / kind:"turntable" children)
swout="$($OVERCAST reconstruct "$img" --ops sweep --count 3 --json --case "$casedir" 2>/dev/null | jq -sc '.')"
save_json "reconstruct_sweep" "$swout" >/dev/null
assert_eq "reconstruct.sweep_views" "3" "$(jq '[.[].payload.kind|select(.=="view")]|length' <<<"$swout")" "3 synthesized stops"
sheet="$(jq -r '.[] | select(.payload.kind=="sheet") | .media.ref' <<<"$swout")"
turn="$(jq -r '.[] | select(.payload.kind=="turntable") | .media.ref' <<<"$swout")"
if [ -n "$sheet" ] && [ -f "$sheet" ]; then ok "reconstruct.sweep_sheet" "contact sheet assembled"; else fail "reconstruct.sweep_sheet" "no sheet at '$sheet'"; fi
if [ -n "$turn" ] && [ -f "$turn" ]; then ok "reconstruct.sweep_turntable" "turntable mp4 assembled"; else fail "reconstruct.sweep_turntable" "no turntable at '$turn'"; fi

# view on the sweep parent → speculative gallery (caveat banner, scriptless)
swparent="$(jq -r '.[0].id' <<<"$swout")"
gvout="$($OVERCAST view "$swparent" --no-open --json --case "$casedir" 2>/dev/null)"
save_json "reconstruct_gallery" "$gvout" >/dev/null
assert_eq "reconstruct.gallery_mode" "reconstruction" "$(jq -r '.payload.mode' <<<"$gvout")" "view routes to the reconstruction gallery"
ghtml="$(jq -r '.media.ref' <<<"$gvout")"
if [ -f "$ghtml" ] && grep -q "NOT PHOTOGRAPHIC EVIDENCE\|NOT photographic evidence" "$ghtml"; then
  ok "reconstruct.gallery_caveat" "gallery leads with the caveat banner"
else
  fail "reconstruct.gallery_caveat" "no caveat banner in $ghtml"
fi

# --ops model → mesh child; view opens the embedded WebGL orbit viewer
mout="$($OVERCAST reconstruct "$img" --ops model --json --case "$casedir" 2>/dev/null | jq -sc '.')"
save_json "reconstruct_model" "$mout" >/dev/null
assert_eq "reconstruct.mesh_kind" "mesh" "$(jq -r '.[1].payload.kind' <<<"$mout")" "mesh child emitted"
mparent="$(jq -r '.[0].id' <<<"$mout")"
ovout="$($OVERCAST view "$mparent" --no-open --json --case "$casedir" 2>/dev/null)"
assert_eq "reconstruct.orbit_mode" "orbit" "$(jq -r '.payload.mode' <<<"$ovout")" "view routes to the 3D orbit viewer"
ohtml="$(jq -r '.media.ref' <<<"$ovout")"
if [ -f "$ohtml" ] && grep -q "GLB_B64" "$ohtml"; then ok "reconstruct.orbit_embed" "mesh embedded in the viewer"; else fail "reconstruct.orbit_embed" "no embedded mesh in $ohtml"; fi

# --ops age → speculative age progression (the sketch artist): aged-still child
# with the EXTENDED caveat (synthesized likeness / never a face-cluster-similar
# match probe) stamped by the verb even though the fixture emits none
agout="$($OVERCAST reconstruct "$img" --ops age --age-years +20 --json --case "$casedir" 2>/dev/null | jq -sc '.')"
save_json "reconstruct_age" "$agout" >/dev/null
assert_eq "reconstruct.age_records" "2" "$(jq 'length' <<<"$agout")" "parent + 1 aged-still child"
assert_eq "reconstruct.age_state" "ready" "$(jq -r '.[0].state' <<<"$agout")" "age parent ready"
assert_eq "reconstruct.age_kind" "age" "$(jq -r '.[1].payload.kind' <<<"$agout")" "child is the aged still"
assert_eq "reconstruct.age_years" "20" "$(jq -r '.[1].payload.age_years' <<<"$agout")" "age delta echoed on the child"
for i in 0 1; do
  cv="$(jq -r ".[$i].payload.caveat" <<<"$agout")"
  if grep -q "NOT photographic evidence" <<<"$cv" \
     && grep -q "not a photograph of the subject" <<<"$cv" \
     && grep -q "face/cluster/similar" <<<"$cv"; then
    ok "reconstruct.age_caveat_$i" "extended likeness caveat on record $i"
  else
    fail "reconstruct.age_caveat_$i" "caveat missing age language: $cv"
  fi
done
aref="$(jq -r '.[1].media.ref' <<<"$agout")"
if [ -f "$aref" ]; then ok "reconstruct.age_output" "aged still written"; else fail "reconstruct.age_output" "no aged still at $aref"; fi

# out-of-range delta fails fast with a clear error (never reaches the provider)
bad="$($OVERCAST reconstruct "$img" --ops age --age-years 99 --json --case "$casedir" 2>/dev/null)"
assert_eq "reconstruct.age_range_state" "error" "$(jq -r '.state' <<<"$bad")" "out-of-range --age-years errors"
echo "$bad" | jq -r '.error' | grep -q "out of range" \
  && ok "reconstruct.age_range_msg" "range error names the bounds" \
  || fail "reconstruct.age_range_msg" "error: $(jq -r '.error' <<<"$bad")"

# evidence quarantine: ask must NOT read reconstructions even on a direct hit
aout="$($OVERCAST ask "synthesized camera view" --json --case "$casedir" 2>/dev/null)"
save_json "reconstruct_ask" "$aout" >/dev/null
cited="$(jq -r '[.payload.citations // [] | .[] | select(.verb=="reconstruct")] | length' <<<"$aout" 2>/dev/null)"
hits="$(jq -r '.payload.evidence // .payload.hits // [] | length' <<<"$aout" 2>/dev/null)"
if [ "${cited:-0}" = "0" ]; then
  ok "reconstruct.quarantine" "ask cites no reconstruct records (hits=$hits)"
else
  fail "reconstruct.quarantine" "ask cited $cited reconstruct records"
fi

# …and the aged likeness specifically stays quarantined too
agask="$($OVERCAST ask "age progression" --json --case "$casedir" 2>/dev/null)"
save_json "reconstruct_age_ask" "$agask" >/dev/null
agcited="$(jq -r '[.payload.citations // [] | .[] | select(.verb=="reconstruct")] | length' <<<"$agask" 2>/dev/null)"
if [ "${agcited:-0}" = "0" ]; then
  ok "reconstruct.age_quarantine" "ask cites no age-progression records"
else
  fail "reconstruct.age_quarantine" "ask cited $agcited reconstruct records for the age query"
fi

# …and no findings trigger fired off any reconstruction (synthesized pixels
# never enter the suggestion pipeline — the whole case must have zero findings)
fout="$($OVERCAST finding list --state all --json --case "$casedir" 2>/dev/null)"
save_json "reconstruct_findings" "$fout" >/dev/null
fcount="$(jq -r '.payload.findings | length' <<<"$fout" 2>/dev/null)"
if [ "${fcount:-1}" = "0" ]; then
  ok "reconstruct.no_findings" "no findings fired off reconstruct records"
else
  fail "reconstruct.no_findings" "$fcount finding(s) present: $(jq -c '.payload.findings' <<<"$fout")"
fi
