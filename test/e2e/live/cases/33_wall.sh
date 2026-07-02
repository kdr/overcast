#!/usr/bin/env bash
# Real-video control-room wall: seed watch/face evidence from real clips via the
# live tinycloud backend, pin a finding to a moment, then generate the wall and
# assert the finding-anchored loop window, coverage badges, and CSI markers.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C="wall"
require_cred "$C" CLOUDGLUE_API_KEY "skipping (wall live case needs real watch/face evidence)" || exit 0

CLIP_A="$SMOKE_DIR/wall_clip_a.mp4"
CLIP_B="$SMOKE_DIR/wall_clip_b.mp4"
have_media "$VIDEO_VISUAL" && clip_av 12 "$VIDEO_VISUAL" "$CLIP_A"
have_media "$VIDEO_OBJECTS" && clip_av 12 "$VIDEO_OBJECTS" "$CLIP_B"
[ -f "$CLIP_A" ] || { skip "$C" "no clip"; exit 0; }

CASE=$(case_dir wall)

cond "wall case seeds a real watch record from a real video"
wa="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP_A" --json)"
assert_eq "$C.watch_a.state" "ready" "$(echo "$wa" | jq -r '.state')" "watch A ready"
WID="$(echo "$wa" | jq -r '.id')"
assert_nonempty "$C.watch_a.id" "$WID" "watch A record id"

if [ -f "$CLIP_B" ]; then
  cond "a second real feed joins the wall"
  wb="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP_B" --json)"
  if [ "$(echo "$wb" | jq -r '.state')" = "ready" ]; then
    ok "$C.watch_b" "watch B ready"
  else
    skip "$C.watch_b" "watch B not ready; wall proceeds with one live feed"
  fi
fi

cond "real face detection contributes coverage + moments to the wall tile"
fd="$(OC_TIMEOUT=300 oc "$CASE" face "$CLIP_A" --json)"
if [ "$(echo "$fd" | jq -r '.state')" = "ready" ]; then
  ok "$C.face" "face detect ready ($(echo "$fd" | jq -r '.payload.count // 0') box(es))"
else
  skip "$C.face" "face detect not ready; wall proceeds without the F badge"
fi

cond "a pinned finding drives the tile's loop window"
f="$(oc "$CASE" finding create "Live wall: pinned evidence moment" --ref "$WID" --at 4-9 --target "wall smoke" --json)"
assert_eq "$C.finding.state" "ready" "$(echo "$f" | jq -r '.state')" "finding pinned"

cond "wall renders the case as a CSI monitor wall anchored on the finding"
WHTML="$SMOKE_DIR/33_wall.html"
w="$(oc "$CASE" wall --export "$WHTML" --theme csi --no-open --json)"
save_json "33_wall" "$w" >/dev/null
assert_eq "$C.verb" "wall" "$(echo "$w" | jq -r '.verb')" "wall record emitted"
assert_eq "$C.state" "ready" "$(echo "$w" | jq -r '.state')" "wall ready"
assert_eq "$C.opened" "false" "$(echo "$w" | jq -r '.payload.opened')" "--no-open honored"
assert_eq "$C.export" "$WHTML" "$(echo "$w" | jq -r '.payload.viewer')" "wall export path returned"
tiles="$(echo "$w" | jq -r '.payload.tiles')"
if [ "$tiles" -ge 1 ] 2>/dev/null; then ok "$C.tiles" "wall has $tiles live tile(s)"; else fail "$C.tiles" "expected >=1 tile, got '$tiles'"; fi
assert_eq "$C.findings" "1" "$(echo "$w" | jq -r '.payload.open_findings')" "open finding counted on the HUD"
# the finding-bearing tile ranks first and loops the pinned 4-9s span verbatim
assert_eq "$C.anchor" "4" "$(echo "$w" | jq -r '.payload.tile_refs[0].at')" "top tile anchored at the finding span start"

if [ -f "$WHTML" ] && grep -q 'data-overcast-theme="csi"' "$WHTML" && grep -q 'data-csi-wall="true"' "$WHTML"; then
  ok "$C.html" "CSI wall HTML exported: $WHTML"
else
  fail "$C.html" "missing CSI wall markers"
fi
if grep -q 'data-src="file://' "$WHTML" && grep -q 'data-start="4" data-end="9"' "$WHTML"; then
  ok "$C.loop" "top tile carries the finding's verbatim 4-9s loop window"
else
  fail "$C.loop" "finding loop window missing from wall html"
fi
if grep -q 'FND 1' "$WHTML"; then
  ok "$C.fnd_chip" "FND chip rendered on the finding tile"
else
  fail "$C.fnd_chip" "FND chip missing"
fi

cond "the same case renders as an endless wall (--infinite) without changing the evidence model"
IHTML="$SMOKE_DIR/33_wall_infinite.html"
wi="$(oc "$CASE" wall --infinite --export "$IHTML" --theme csi --no-open --json)"
save_json "33_wall_infinite" "$wi" >/dev/null
assert_eq "$C.inf.state" "ready" "$(echo "$wi" | jq -r '.state')" "infinite wall ready"
assert_eq "$C.inf.flag" "true" "$(echo "$wi" | jq -r '.payload.infinite')" "payload carries infinite=true"
assert_eq "$C.plain_flag" "false" "$(echo "$w" | jq -r '.payload.infinite')" "normal wall records infinite=false"
# --infinite is presentation-only: same tiles, same finding-anchored top tile
assert_eq "$C.inf.tiles" "$tiles" "$(echo "$wi" | jq -r '.payload.tiles')" "same tile model as the normal wall"
assert_eq "$C.inf.anchor" "4" "$(echo "$wi" | jq -r '.payload.tile_refs[0].at')" "finding anchor survives --infinite"
if [ -f "$IHTML" ] && grep -q 'data-infinite="true"' "$IHTML"; then
  ok "$C.inf.marker" "endless wall marker present: $IHTML"
else
  fail "$C.inf.marker" "data-infinite missing from infinite wall html"
fi
# 1-2 real feeds floor at a 3-wide monitor bank (clone rows fill the screen)
if grep -q -- '--cols:3' "$IHTML"; then
  ok "$C.inf.cols" "3-wide monitor-bank floor applied"
else
  fail "$C.inf.cols" "expected --cols:3 floor on a small infinite wall"
fi
