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
for v in watch listen see enhance view; do
  echo "$verbs" | grep -qx "$v" || missing="$missing $v"
done
if [ -z "$missing" ]; then ok "senses.verb_surface" "commands --json lists watch/listen/see/enhance/view"; else fail "senses.verb_surface" "missing verbs:$missing"; fi

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

# see: with NO provider configured (HF token unset), it's the placeholder.
# (When HF_TOKEN/a binding is present, see routes to that provider instead.)
sout="$(env -u HF_TOKEN -u HUGGING_FACE_HUB_TOKEN $OVERCAST see "./missing.jpg" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_see" "$sout" >/dev/null
assert_eq "see.state" "needs_credentials" "$(jq -r '.state' <<<"$sout")" "see placeholder state (no provider)"
