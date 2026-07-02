#!/usr/bin/env bash
# Phase 6 e2e: the control-room wall (offline — ffmpeg only). Generates a real
# clip, seeds registerable case media via `enhance` (an enhance record's
# media.ref is real local video), then asserts the wall verb writes a themed
# HTML wall with looping tiles and handles the empty case as pending guidance.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

clip="$SMOKE_DIR/wall_tiny.mp4"
node --import tsx -e "
import {FFMPEG_PATH} from '$REPO/src/media/ffmpeg.ts';
import {execFileSync} from 'node:child_process';
execFileSync(FFMPEG_PATH,['-y','-f','lavfi','-i','testsrc=size=128x96:rate=10:duration=2','-pix_fmt','yuv420p','$clip'],{stdio:'ignore'});
" 2>"$SMOKE_DIR/phase6_ff.err"
if [ ! -f "$clip" ]; then
  fail "wall.clip_gen" "could not generate test clip with system ffmpeg"
  return 0 2>/dev/null || exit 0
fi
ok "wall.clip_gen" "generated wall_tiny.mp4 via system ffmpeg"

casedir="$SMOKE_DIR/case_wall"; mkdir -p "$casedir"

# the registry lists wall (one spec → CLI/tool/skill)
if $OVERCAST commands --json | jq -r '.verbs[].name' | grep -qx "wall"; then
  ok "wall.verb_surface" "commands --json lists wall"
else
  fail "wall.verb_surface" "wall missing from commands --json"
fi

# empty case → transient pending guidance, no artifact
eout="$($OVERCAST wall --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase6_wall_empty" "$eout" >/dev/null
assert_eq "wall.empty_state" "pending" "$(jq -r '.state' <<<"$eout")" "empty case is pending guidance"
if [ ! -f "$casedir/.overcast/media/wall.html" ]; then
  ok "wall.empty_no_artifact" "no wall.html written for an empty case"
else
  fail "wall.empty_no_artifact" "wall.html written despite empty case"
fi

# seed registerable case media (enhance emits media.ref = real local video)
enh="$($OVERCAST enhance "$clip" --ops grayscale --json --case "$casedir" 2>/dev/null)"
save_json "phase6_wall_enhance" "$enh" >/dev/null
assert_eq "wall.seed_state" "ready" "$(jq -r '.state' <<<"$enh")" "enhance seeded case media"

# wall --no-open --theme csi: record + themed html with a looping tile
wout="$($OVERCAST wall --no-open --theme csi --json --case "$casedir" 2>/dev/null)"
save_json "phase6_wall" "$wout" >/dev/null
assert_eq "wall.verb" "wall" "$(jq -r '.verb' <<<"$wout")" "wall emits wall record"
assert_eq "wall.state" "ready" "$(jq -r '.state' <<<"$wout")" "wall ready"
assert_eq "wall.opened" "false" "$(jq -r '.payload.opened' <<<"$wout")" "--no-open honored"
tiles="$(jq -r '.payload.tiles' <<<"$wout")"
if [ "$tiles" -ge 1 ] 2>/dev/null; then ok "wall.tiles" "wall has $tiles tile(s)"; else fail "wall.tiles" "expected >=1 tile, got '$tiles'"; fi
whtml="$(jq -r '.payload.viewer' <<<"$wout")"
if [ -f "$whtml" ]; then ok "wall.html_written" "wall html generated at $whtml"; else fail "wall.html_written" "no wall html at $whtml"; fi
if grep -q 'data-overcast-theme="csi"' "$whtml" && grep -q 'data-csi-wall="true"' "$whtml"; then
  ok "wall.theme_marker" "csi theme markers present"
else
  fail "wall.theme_marker" "csi markers missing from wall html"
fi
if grep -q 'data-start=' "$whtml" && grep -q 'data-src="file://' "$whtml"; then
  ok "wall.tile_loop" "tile carries a file:// src and a loop window"
else
  fail "wall.tile_loop" "no looping video tile in wall html"
fi

# --infinite: endless wall marker in the record and the page
iout="$($OVERCAST wall --infinite --no-open --json --case "$casedir" 2>/dev/null)"
save_json "phase6_wall_infinite" "$iout" >/dev/null
assert_eq "wall.infinite_payload" "true" "$(jq -r '.payload.infinite' <<<"$iout")" "--infinite recorded in payload"
if grep -q 'data-infinite="true"' "$(jq -r '.payload.viewer' <<<"$iout")"; then
  ok "wall.infinite_marker" "wall html carries data-infinite"
else
  fail "wall.infinite_marker" "data-infinite missing from --infinite wall html"
fi
