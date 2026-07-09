#!/usr/bin/env bash
# Phase 2 e2e: senses & view (offline — ffmpeg + placeholder). Generates a real
# tiny clip with the system ffmpeg, then exercises enhance / view / see / the
# verb surface. listen's live Cloudglue path is gated in phase2_listenlive.sh.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

# make a 1s clip with the system ffmpeg (resolved via the toolkit)
clip="$SMOKE_DIR/tiny.mp4"
node --import tsx -e "
import {FFMPEG_PATH} from '$REPO/src/media/ffmpeg.ts';
import {execFileSync} from 'node:child_process';
execFileSync(FFMPEG_PATH,['-y','-f','lavfi','-i','testsrc=size=128x96:rate=10:duration=1','-pix_fmt','yuv420p','$clip'],{stdio:'ignore'});
" 2>"$SMOKE_DIR/phase2_ff.err"
if [ ! -f "$clip" ]; then
  fail "senses.clip_gen" "could not generate test clip with system ffmpeg"
  return 0 2>/dev/null || exit 0
fi
ok "senses.clip_gen" "generated tiny.mp4 via system ffmpeg"

casedir="$SMOKE_DIR/case_senses"; mkdir -p "$casedir"

# commands --json includes the Phase 1+2 senses + view (subset check — later
# phases append more verbs, so assert presence, not the exact set).
verbs="$($OVERCAST commands --json | jq -r '.verbs[].name')"
missing=""
for v in watch listen see enhance view crop grid voice exif verify map devices; do
  echo "$verbs" | grep -qx "$v" || missing="$missing $v"
done
if [ -z "$missing" ]; then ok "senses.verb_surface" "commands --json lists watch/listen/see/enhance/view/crop/grid/voice/exif/verify/map/devices"; else fail "senses.verb_surface" "missing verbs:$missing"; fi

# enhance: ffmpeg op -> media.enhanced with output media.ref
eout="$($OVERCAST enhance "$clip" --ops grayscale --json --case "$casedir" 2>/dev/null)"
save_json "phase2_enhance" "$eout" >/dev/null
assert_eq "enhance.verb" "enhance" "$(jq -r .verb <<<"$eout")" "enhance verb"
assert_eq "enhance.state" "ready" "$(jq -r '.state' <<<"$eout")" "enhance ready"
eref="$(jq -r '.media.ref' <<<"$eout")"
if [ -f "$eref" ]; then ok "enhance.output_exists" "enhanced media written"; else fail "enhance.output_exists" "no output at $eref"; fi

# view --no-open: writes an HTML player
vout="$($OVERCAST view "$clip" --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase2_view" "$vout" >/dev/null
assert_eq "view.mode" "video" "$(jq -r '.payload.mode' <<<"$vout")" "view detects video"
vhtml="$(jq -r '.payload.viewer' <<<"$vout")"
if [ -f "$vhtml" ] && grep -q "OVERCAST VIEW" "$vhtml"; then ok "view.html_written" "self-contained player generated"; else fail "view.html_written" "no player html"; fi

# crop: materialize face detections into local crop evidence records. The fake
# tinycloud fixture exercises the real face envelope mapper before crop reads
# the resulting face record by id.
fout="$(OVERCAST_TINYCLOUD_CMD="bash $REPO/test/fixtures/fake-tinycloud.sh" $OVERCAST face "$clip" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_face_for_crop" "$fout" >/dev/null
assert_eq "crop.face_state" "ready" "$(jq -r '.state' <<<"$fout")" "fixture face detect ready"
face_id="$(jq -r '.id' <<<"$fout")"
cout="$($OVERCAST crop "$face_id" --all --limit 1 --json --case "$casedir" 2>/dev/null)"
save_json "phase2_crop" "$cout" >/dev/null
assert_eq "crop.verb" "crop" "$(jq -r '.verb' <<<"$cout")" "crop emits crop record"
assert_eq "crop.state" "ready" "$(jq -r '.state' <<<"$cout")" "crop ready"
crop_path="$(jq -r '.media.ref' <<<"$cout")"
if [ -f "$crop_path" ]; then ok "crop.output_exists" "crop image written"; else fail "crop.output_exists" "no crop at $crop_path"; fi

# grid: tile timestamped frames into ONE contact sheet via the internal ffmpeg
# toolkit — emits media.grid with a cell-number->timestamp map and a montage on disk.
gout="$($OVERCAST grid "$clip" --count 4 --cols 2 --json --case "$casedir" 2>/dev/null)"
save_json "phase2_grid" "$gout" >/dev/null
assert_eq "grid.verb" "grid" "$(jq -r '.verb' <<<"$gout")" "grid emits grid record"
assert_eq "grid.state" "ready" "$(jq -r '.state' <<<"$gout")" "grid ready"
assert_eq "grid.cells" "4" "$(jq -r '.payload.cells | length' <<<"$gout")" "grid maps 4 cells"
grid_path="$(jq -r '.media.ref' <<<"$gout")"
if [ -f "$grid_path" ]; then ok "grid.output_exists" "contact sheet written"; else fail "grid.output_exists" "no montage at $grid_path"; fi

# grid --view: render the clickable HTML board (numbered, seekable cells)
gvout="$($OVERCAST grid "$clip" --count 4 --cols 2 --view --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase2_grid_view" "$gvout" >/dev/null
assert_eq "grid.view_not_opened" "false" "$(jq -r '.payload.opened' <<<"$gvout")" "--no-open respected"
grid_html="$(jq -r '.payload.view' <<<"$gvout")"
if [ -f "$grid_html" ] && grep -q 'onclick="seek(' "$grid_html"; then ok "grid.view_html" "board HTML has seekable cells"; else fail "grid.view_html" "no clickable board at $grid_html"; fi

# voice: argument hygiene only (the local speaker model never runs offline) —
# pairwise sample XOR --index must be enforced before any audio work.
vuout="$($OVERCAST voice match "$clip" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_voice_usage" "$vuout" >/dev/null
assert_eq "voice.usage_state" "error" "$(jq -r '.state' <<<"$vuout")" "voice match without a sample or --index errors"
echo "$vuout" | jq -r '.error' | grep -q "reference sample" \
  && ok "voice.usage_msg" "usage error names the sample/--index choice" \
  || fail "voice.usage_msg" "error: $(jq -r '.error' <<<"$vuout")"

# see: with NO brain, NO HF token, and no binding, it's the placeholder.
# (A brain / HF_TOKEN / a binding routes see to that backend instead.) Both the
# brain default (OVERCAST_SEE_BRAIN=off) and .env auto-load (OVERCAST_NO_DOTENV=1)
# are disabled so this stays deterministic even with an ambient Cloudglue key.
sout="$(env -u HF_TOKEN -u HUGGING_FACE_HUB_TOKEN OVERCAST_NO_DOTENV=1 OVERCAST_SEE_BRAIN=off $OVERCAST see "./missing.jpg" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_see" "$sout" >/dev/null
assert_eq "see.state" "needs_credentials" "$(jq -r '.state' <<<"$sout")" "see placeholder state (no provider)"

# see bound to the tinycloud wrapper against the fake tinycloud CLI: the REAL
# exec provider + envelope→record mapping runs, no network. Isolated --home so
# the binding never leaks into other phases.
frame="$SMOKE_DIR/tiny_frame.jpg"
node --import tsx -e "
import {FFMPEG_PATH} from '$REPO/src/media/ffmpeg.ts';
import {execFileSync} from 'node:child_process';
execFileSync(FFMPEG_PATH,['-y','-i','$clip','-frames:v','1','$frame'],{stdio:'ignore'});
" 2>/dev/null
if [ -f "$frame" ]; then
  tchome="$SMOKE_DIR/senses-tc-home"; mkdir -p "$tchome"
  $OVERCAST setup provider see "exec:bash $REPO/examples/providers/tinycloud/see.sh --input {{input}}" --home "$tchome" --json >/dev/null 2>&1
  tsout="$(env OVERCAST_NO_DOTENV=1 CLOUDGLUE_API_KEY=fixture OVERCAST_TINYCLOUD_CMD="bash $REPO/test/fixtures/fake-tinycloud.sh" \
    $OVERCAST see "$frame" --ocr --json --case "$casedir" --home "$tchome" 2>/dev/null)"
  save_json "phase2_see_tinycloud" "$tsout" >/dev/null
  assert_eq "see.tinycloud_state" "ready" "$(jq -r '.state' <<<"$tsout")" "tinycloud-wrapper see ready"
  echo "$tsout" | jq -r '.payload.caption' | grep -qi "fixture" \
    && ok "see.tinycloud_caption" "caption from fixture see envelope" \
    || fail "see.tinycloud_caption" "caption: $(jq -r '.payload.caption' <<<"$tsout")"
  assert_eq "see.tinycloud_ocr" "HELLO FIXTURE" "$(jq -r '.payload.ocr' <<<"$tsout")" "scene_text mapped to payload.ocr"
  assert_eq "see.tinycloud_provider" "tinycloud:see" "$(jq -r '.meta.provider' <<<"$tsout")" "provider tag"
else
  fail "see.tinycloud_frame" "could not extract a frame for the tinycloud see check"
fi

# ---- forensic senses (exif / verify) driven against FAKE system binaries via the
# OVERCAST_EXIFTOOL_CMD / OVERCAST_C2PATOOL_CMD overrides — exercises the REAL
# shipped exif.sh / verify.sh jq mapping AND the forensic finding triggers + the
# map / devices rollups, offline (no real exiftool/c2patool needed).
if [ -f "$frame" ]; then
  fcase="$SMOKE_DIR/case_forensics"; mkdir -p "$fcase"

  xout="$(OVERCAST_EXIFTOOL_CMD="bash $REPO/test/fixtures/fake-exiftool.sh" \
    $OVERCAST exif "$frame" --json --case "$fcase" 2>/dev/null | jq -c 'select(.verb=="exif")')"
  save_json "phase2_exif" "$xout" >/dev/null
  assert_eq "exif.state" "ready" "$(jq -r '.state' <<<"$xout")" "shipped exif.sh maps a record"
  assert_eq "exif.serial" "SN-FAKE-1" "$(jq -r '.payload.serial' <<<"$xout")" "serial tag surfaced"
  assert_eq "exif.lens" "TestLens 50mm" "$(jq -r '.payload.lens' <<<"$xout")" "lens tag surfaced"
  echo "$xout" | jq -e '.payload.gps.lat==1.5' >/dev/null && ok "exif.gps" "gps mapped" || fail "exif.gps" "no gps"

  # Workstream-1 integration: an editing-software lead was suggested (default suggest mode)
  flist="$($OVERCAST finding list --state suggested --json --case "$fcase" 2>/dev/null)"
  echo "$flist" | jq -e '.payload.findings[] | select(.payload.trigger=="signal:exif-editing-software" and .payload.confidence=="medium")' >/dev/null \
    && ok "exif.finding" "editing-software lead suggested" || fail "exif.finding" "no editor lead"

  # exif suppresses an OUT-OF-RANGE GPS tag (gps null + summary flags invalid) so
  # stored/indexed coords stay consistent with what map + geocode accept.
  xbad="$(OVERCAST_EXIFTOOL_CMD="bash $REPO/test/fixtures/fake-exiftool-badgps.sh" \
    $OVERCAST exif "$frame" --json --case "$fcase" 2>/dev/null | jq -c 'select(.verb=="exif")')"
  assert_eq "exif.badgps_null" "null" "$(jq -r '.payload.gps' <<<"$xbad")" "out-of-range GPS suppressed to null"
  echo "$xbad" | jq -r '.payload.summary' | grep -qi "out of range" \
    && ok "exif.badgps_summary" "out-of-range GPS labeled 'invalid (out of range)'" || fail "exif.badgps_summary" "no out-of-range note"

  # exif labels an INCOMPLETE GPS (lat only) as malformed, not out-of-range — matches geo.ts gpsIssue
  xmal="$(OVERCAST_EXIFTOOL_CMD="bash $REPO/test/fixtures/fake-exiftool-malformedgps.sh" \
    $OVERCAST exif "$frame" --json --case "$fcase" 2>/dev/null | jq -c 'select(.verb=="exif")')"
  assert_eq "exif.malformedgps_null" "null" "$(jq -r '.payload.gps' <<<"$xmal")" "incomplete GPS suppressed to null"
  echo "$xmal" | jq -r '.payload.summary' | grep -qi "malformed" \
    && ok "exif.malformedgps_summary" "incomplete GPS labeled malformed (not out-of-range)" || fail "exif.malformedgps_summary" "no malformed note"

  vout="$(OVERCAST_C2PATOOL_CMD="bash $REPO/test/fixtures/fake-c2patool.sh" \
    $OVERCAST verify "$frame" --json --case "$fcase" 2>/dev/null | jq -c 'select(.verb=="verify")')"
  save_json "phase2_verify" "$vout" >/dev/null
  assert_eq "verify.has_manifest" "true" "$(jq -r '.payload.has_manifest' <<<"$vout")" "manifest mapped"
  assert_eq "verify.state_invalid" "Invalid" "$(jq -r '.payload.validation_state' <<<"$vout")" "invalid validation state mapped"
  flist2="$($OVERCAST finding list --state suggested --json --case "$fcase" 2>/dev/null)"
  echo "$flist2" | jq -e '.payload.findings[] | select(.payload.trigger=="signal:verify-validation-failed" and .payload.confidence=="high")' >/dev/null \
    && ok "verify.finding" "validation-failed lead suggested (high)" || fail "verify.finding" "no provenance lead"

  # map: the GPS-bearing exif record plots to a self-contained HTML map
  mout="$($OVERCAST map --no-open --json --case "$fcase" 2>/dev/null)"
  save_json "phase2_map" "$mout" >/dev/null
  assert_eq "map.state" "ready" "$(jq -r '.state' <<<"$mout")" "map ready"
  mhtml="$(jq -r '.payload.viewer' <<<"$mout")"
  if [ -f "$mhtml" ] && grep -q "tile.openstreetmap.org" "$mhtml"; then ok "map.html" "self-contained map HTML with OSM tiles"; else fail "map.html" "no map html at $mhtml"; fi
  moff="$($OVERCAST map --offline --no-open --json --case "$fcase" 2>/dev/null)"
  mhtml2="$(jq -r '.payload.viewer' <<<"$moff")"
  if [ -f "$mhtml2" ] && grep -q "openstreetmap.org/?mlat" "$mhtml2"; then ok "map.offline" "offline scatter with openstreetmap.org deep links"; else fail "map.offline" "no offline map at $mhtml2"; fi

  # devices: a single-media exif record → no shared-device cluster, but the rollup
  # must run cleanly and report total_exif.
  dout="$($OVERCAST devices --json --case "$fcase" 2>/dev/null)"
  save_json "phase2_devices" "$dout" >/dev/null
  assert_eq "devices.mode" "devices" "$(jq -r '.payload.mode' <<<"$dout")" "devices rollup runs"
else
  fail "forensics.frame" "no frame available for exif/verify/map/devices checks"
fi
