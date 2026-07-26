#!/usr/bin/env bash
# Phase 11 e2e: the geofence verb + map --near/--bbox (offline — no providers, no
# network). Seeds a case with gps-bearing records at known coordinates/times, then
# asserts the geofence-warrant query returns exactly the in-fence + in-window
# subset (newest-first, undated kept), the error/empty surfaces, and the map's
# spatial pre-filter.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

casedir="$SMOKE_DIR/case_geofence"; mkdir -p "$casedir"

# the registry lists geofence (one spec → CLI/tool/skill)
if $OVERCAST commands --json | jq -r '.verbs[].name' | grep -qx "geofence"; then
  ok "geofence.verb_surface" "commands --json lists geofence"
else
  fail "geofence.verb_surface" "geofence missing from commands --json"
fi

# seed gps-bearing records at known coordinates + capture times (absolute dates,
# so the case never rots). sf_near is ~1000.75 m north of the sf anchor.
node --import tsx -e "
import {openCase} from '$REPO/src/case.ts'; import {makeRecord} from '$REPO/src/record.ts';
const c=openCase('$casedir'); c.ensure();
const rec=(verb,ref,gps,time)=>{
  const r=makeRecord({verb,format:'json',payload:{summary:'evidence at '+ref,gps},media:{ref},...(time?{meta:{time}}:{})});
  if(!time) delete r.meta.time; // genuinely undated
  c.writeRecord(r);
};
rec('exif','sf_new.jpg',{lat:37.7749,lng:-122.4194},'2021-01-01T00:00:00Z');
rec('capture','sf_near.jpg',{lat:37.7839,lng:-122.4194},'2020-01-01T00:00:00Z');
rec('scan','ny.jpg',{lat:40.7128,lng:-74.006},'2021-01-01T00:00:00Z');
rec('exif','sf_undated.jpg',{lat:37.7749,lng:-122.4194},null);
" 2>"$SMOKE_DIR/phase11_geofence_seed.err" || fail "geofence.seed" "seeding failed: $(head -1 "$SMOKE_DIR/phase11_geofence_seed.err")"

# (1) radius query: the 3 SF records return (newest-first, undated last); NY is out
gout="$($OVERCAST geofence --near 37.7749,-122.4194 --radius 1200 --json --case "$casedir" 2>/dev/null)"
save_json "phase11_geofence_near" "$gout" >/dev/null
assert_eq "geofence.near.state" "ready" "$(jq -r '.state' <<<"$gout")" "radius query ready"
assert_eq "geofence.near.count" "3" "$(jq -r '.payload.count' <<<"$gout")" "3 records inside 1200 m"
assert_eq "geofence.near.order" "sf_new.jpg,sf_near.jpg,sf_undated.jpg" \
  "$(jq -r '[.payload.matches[].ref] | join(",")' <<<"$gout")" "newest-first, undated last, NY excluded"
assert_eq "geofence.near.counts" "2" "$(jq -r '.payload.counts.exif' <<<"$gout")" "per-verb counts (exif)"
assert_eq "geofence.near.gps_total" "4" "$(jq -r '.payload.gps_total' <<<"$gout")" "gps_total counts every gps-bearing record"
assert_eq "geofence.near.query" "1200" "$(jq -r '.payload.query.radius_m' <<<"$gout")" "query echoed back"

# (2) time window: --since drops the dated-old point, keeps the undated one
sout="$($OVERCAST geofence --near 37.7749,-122.4194 --radius 1200 --since 2020-06-01 --json --case "$casedir" 2>/dev/null)"
save_json "phase11_geofence_since" "$sout" >/dev/null
assert_eq "geofence.since" "sf_new.jpg,sf_undated.jpg" \
  "$(jq -r '[.payload.matches[].ref] | join(",")' <<<"$sout")" "--since excludes the 2020-01 capture, keeps undated"

# (3) tighter radius: the ~1 km point drops out
tout="$($OVERCAST geofence --near 37.7749,-122.4194 --radius 900 --json --case "$casedir" 2>/dev/null)"
assert_eq "geofence.tight_radius" "2" "$(jq -r '.payload.count' <<<"$tout")" "900 m fence drops the ~1 km point"

# (4) bbox query: an SF-only box keeps the 3 SF records
bout="$($OVERCAST geofence --bbox 37.7,-122.5,37.8,-122.3 --json --case "$casedir" 2>/dev/null)"
save_json "phase11_geofence_bbox" "$bout" >/dev/null
assert_eq "geofence.bbox" "3" "$(jq -r '.payload.count' <<<"$bout")" "bbox keeps SF, excludes NY"

# (5) empty intersection: ready + guidance, not an error
eout="$($OVERCAST geofence --near 10,10 --radius 500 --json --case "$casedir" 2>/dev/null)"
save_json "phase11_geofence_empty" "$eout" >/dev/null
assert_eq "geofence.empty.state" "ready" "$(jq -r '.state' <<<"$eout")" "empty fence is a clean ready record"
assert_eq "geofence.empty.count" "0" "$(jq -r '.payload.count' <<<"$eout")" "zero matches"
assert_nonempty "geofence.empty.note" "$(jq -r '.payload.note // empty' <<<"$eout")" "empty result carries guidance"

# (6) flag surface: --near+--bbox are mutually exclusive; no fence is an error
xout="$($OVERCAST geofence --near 1,2 --bbox 0,0,1,1 --json --case "$casedir" 2>/dev/null)"
assert_eq "geofence.exclusive" "error" "$(jq -r '.state' <<<"$xout")" "--near + --bbox rejected"
nout="$($OVERCAST geofence --json --case "$casedir" 2>/dev/null)"
assert_eq "geofence.no_fence" "error" "$(jq -r '.state' <<<"$nout")" "missing fence rejected"

# (7) map --near: the spatial pre-filter plots only in-fence points
mout="$($OVERCAST map --near 37.7749,-122.4194 --radius 1200 --offline --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase11_geofence_map" "$mout" >/dev/null
assert_eq "geofence.map.state" "ready" "$(jq -r '.state' <<<"$mout")" "filtered map ready"
assert_eq "geofence.map.points" "3" "$(jq -r '.payload.points' <<<"$mout")" "map plots only the in-fence points"
mhtml="$(jq -r '.payload.viewer' <<<"$mout")"
if [ -f "$mhtml" ]; then
  ok "geofence.map.html" "filtered map html written at $mhtml"
else
  fail "geofence.map.html" "no map html at $mhtml"
fi

# (8) map fence miss: pending guidance distinguishing "filtered out" from "no gps"
fmout="$($OVERCAST map --near 10,10 --radius 500 --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase11_geofence_map_miss" "$fmout" >/dev/null
assert_eq "geofence.map_miss.state" "pending" "$(jq -r '.state' <<<"$fmout")" "fence miss is pending guidance"
assert_eq "geofence.map_miss.gps_total" "4" "$(jq -r '.payload.gps_total' <<<"$fmout")" "gps_total stays pre-filter"
