#!/usr/bin/env bash
# Phase 2 e2e: senses & view (offline — ffmpeg + placeholder). Generates a real
# tiny clip with the vendored ffmpeg, then exercises enhance / view / see / the
# verb surface. listen's live Cloudglue path is gated in phase2_listenlive.sh.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

# resolve the vendored ffmpeg via the toolkit and make a 1s clip
ff="$(node -e "import('$REPO/dist/index.js').catch(()=>{}); import('$REPO/src/media/ffmpeg.ts')" 2>/dev/null || true)"
clip="$SMOKE_DIR/tiny.mp4"
node --import tsx -e "
import {FFMPEG_PATH} from '$REPO/src/media/ffmpeg.ts';
import {execFileSync} from 'node:child_process';
execFileSync(FFMPEG_PATH,['-y','-f','lavfi','-i','testsrc=size=128x96:rate=10:duration=1','-pix_fmt','yuv420p','$clip'],{stdio:'ignore'});
" 2>"$SMOKE_DIR/phase2_ff.err"
if [ ! -f "$clip" ]; then
  fail "senses.clip_gen" "could not generate test clip with vendored ffmpeg"
  return 0 2>/dev/null || exit 0
fi
ok "senses.clip_gen" "generated tiny.mp4 via vendored ffmpeg"

casedir="$SMOKE_DIR/case_senses"; mkdir -p "$casedir"

# commands --json lists all five Phase 1+2 verbs
verbs="$($OVERCAST commands --json | jq -r '.verbs[].name' | sort | tr '\n' ',')"
assert_eq "senses.verb_surface" "enhance,listen,see,view,watch," "$verbs" "commands --json lists senses + view + watch"

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

# see: placeholder reports needs_credentials cleanly
sout="$($OVERCAST see "./missing.jpg" --json --case "$casedir" 2>/dev/null)"
save_json "phase2_see" "$sout" >/dev/null
assert_eq "see.state" "needs_credentials" "$(jq -r '.state' <<<"$sout")" "see placeholder state"
