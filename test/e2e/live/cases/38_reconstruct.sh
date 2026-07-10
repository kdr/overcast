#!/usr/bin/env bash
# Real `reconstruct` (fal, FAL_KEY): speculative camera reposition + sweep +
# depth against the LIVE endpoints, on a real image (OC_IMAGE, else a frame of
# OC_VIDEO_SMALL / OC_VIDEO_VISUAL). Asserts the loose-record contract, the
# outputs[] fan-out, the non-negotiable caveat, the sweep's locally-assembled
# contact sheet + turntable, and the viewer routing. The 3D mesh lift
# (`--ops model`, fal QUEUE API) is HARD-GATED on OC_RECONSTRUCT_3D_E2E=1 —
# it runs minutes and bills more than the ~cent-level view/depth calls.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=reconstruct

require_cred "$C" FAL_KEY "skipping (reconstruct is fal-bound)" || exit 0

# a real image: OC_IMAGE, else a frame pulled from a real clip
IMG="${OC_IMAGE:-}"
if ! have_media "$IMG"; then
  SRC="$VIDEO_SMALL"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
  if have_media "$SRC"; then IMG="$SMOKE_DIR/reconstruct_frame.jpg"; frame_jpg "$SRC" 1 "$IMG"; fi
fi
have_media "$IMG" || { skip "$C" "no OC_IMAGE / video to frame"; exit 0; }

CASE=$(case_dir reconstruct)
RP="$PWD/examples/providers/fal/reconstruct.sh"
ocrun "$CASE" setup provider reconstruct "exec:bash $RP --input {{input}}" --json >/dev/null 2>&1

# --- camera reposition: --rotate 90 → parent + one synthesized view child ----
cond "reposition the camera 90° around a real image (qwen multi-angle)"
out="$(OC_TIMEOUT=300 oc "$CASE" reconstruct "$IMG" --rotate 90 --json | jq -sc '.')"
save_json "38_reconstruct_view" "$out" >/dev/null
assert_eq "$C.view.state" "ready" "$(jq -r '.[0].state' <<<"$out")" "view parent ready"
assert_eq "$C.view.child_kind" "view" "$(jq -r '.[1].payload.kind' <<<"$out")" "synthesized view child"
assert_eq "$C.view.azimuth" "90" "$(jq -r '.[1].payload.azimuth' <<<"$out")" "azimuth echoed on the child"
jq -r '.[0].payload.caveat, .[1].payload.caveat' <<<"$out" | grep -qc "NOT photographic evidence" \
  && ok "$C.view.caveat" "caveat stamped on parent + child" \
  || fail "$C.view.caveat" "missing caveat: $(jq -c '[.[].payload.caveat]' <<<"$out")"
vref="$(jq -r '.[1].media.ref' <<<"$out")"
if [ -s "$vref" ]; then ok "$C.view.output" "synthesized view on disk ($(wc -c <"$vref" | tr -d ' ') bytes)"; else fail "$C.view.output" "missing: $vref"; fi

# --- sweep (2 stops, cost-minimal) → per-stop children + sheet + turntable ---
cond "sweep 2 camera stops and assemble the contact sheet + turntable locally"
sw="$(OC_TIMEOUT=600 oc "$CASE" reconstruct "$IMG" --ops sweep --count 2 --json | jq -sc '.')"
save_json "38_reconstruct_sweep" "$sw" >/dev/null
assert_eq "$C.sweep.state" "ready" "$(jq -r '.[0].state' <<<"$sw")" "sweep parent ready"
assert_eq "$C.sweep.views" "2" "$(jq '[.[].payload.kind|select(.=="view")]|length' <<<"$sw")" "2 synthesized stops"
sheet="$(jq -r '.[] | select(.payload.kind=="sheet") | .media.ref' <<<"$sw")"
turn="$(jq -r '.[] | select(.payload.kind=="turntable") | .media.ref' <<<"$sw")"
if [ -n "$sheet" ] && [ -s "$sheet" ]; then ok "$C.sweep.sheet" "contact sheet assembled"; else fail "$C.sweep.sheet" "no sheet at '$sheet'"; fi
if [ -n "$turn" ] && [ -s "$turn" ]; then ok "$C.sweep.turntable" "turntable mp4 assembled"; else fail "$C.sweep.turntable" "no turntable at '$turn'"; fi

# view on the sweep parent routes to the speculative gallery with the banner
gv="$(oc "$CASE" view "$(jq -r '.[0].id' <<<"$sw")" --no-open --json)"
assert_eq "$C.sweep.gallery" "reconstruction" "$(echo "$gv" | jq -r '.payload.mode')" "gallery viewer"
ghtml="$(echo "$gv" | jq -r '.media.ref')"
# the banner is uppercased by CSS (text-transform); the HTML SOURCE stays mixed-case
grep -qi "NOT photographic evidence" "$ghtml" 2>/dev/null \
  && ok "$C.sweep.banner" "gallery leads with the caveat banner" \
  || fail "$C.sweep.banner" "no caveat banner in $ghtml"

# --- depth estimate → depth child + parallax viewer routing ------------------
cond "estimate a real depth map (depth-anything v2) and open the parallax viewer"
dp="$(OC_TIMEOUT=300 oc "$CASE" reconstruct "$IMG" --ops depth --json | jq -sc '.')"
save_json "38_reconstruct_depth" "$dp" >/dev/null
assert_eq "$C.depth.state" "ready" "$(jq -r '.[0].state' <<<"$dp")" "depth parent ready"
assert_eq "$C.depth.kind" "depth" "$(jq -r '.[1].payload.kind' <<<"$dp")" "depth child"
dv="$(oc "$CASE" view "$(jq -r '.[0].id' <<<"$dp")" --no-open --json)"
assert_eq "$C.depth.viewer" "parallax" "$(echo "$dv" | jq -r '.payload.mode')" "parallax viewer routed"

# --- evidence quarantine on REAL records --------------------------------------
cond "reconstructions never surface as ask evidence"
aq="$(oc "$CASE" ask "synthesized camera view" --json | primary_rec)"
cited="$(echo "$aq" | jq -r '[.payload.citations // [] | .[] | select(.verb=="reconstruct")] | length')"
[ "${cited:-0}" = "0" ] && ok "$C.quarantine" "ask cites no reconstruct records" \
  || fail "$C.quarantine" "ask cited $cited reconstruct records"

# --- 3D mesh lift via the fal QUEUE API (opt-in: minutes + higher cost) ------
case "${OC_RECONSTRUCT_3D_E2E:-}" in
  1|true|yes|on)
    cond "lift a textured 3D GLB via the fal queue API (trellis)"
    m="$(OC_TIMEOUT=900 oc "$CASE" reconstruct "$IMG" --ops model --json | jq -sc '.')"
    save_json "38_reconstruct_model" "$m" >/dev/null
    assert_eq "$C.model.state" "ready" "$(jq -r '.[0].state' <<<"$m")" "model parent ready (queue polled)"
    assert_eq "$C.model.kind" "mesh" "$(jq -r '.[1].payload.kind' <<<"$m")" "mesh child"
    glb="$(jq -r '.[1].media.ref' <<<"$m")"
    if [ -s "$glb" ]; then ok "$C.model.glb" "GLB on disk ($(wc -c <"$glb" | tr -d ' ') bytes)"; else fail "$C.model.glb" "missing: $glb"; fi
    ov="$(oc "$CASE" view "$(jq -r '.[0].id' <<<"$m")" --no-open --json)"
    assert_eq "$C.model.viewer" "orbit" "$(echo "$ov" | jq -r '.payload.mode')" "3D orbit viewer routed"
    ohtml="$(echo "$ov" | jq -r '.media.ref')"
    grep -q "GLB_B64" "$ohtml" 2>/dev/null \
      && ok "$C.model.embed" "mesh embedded in the orbit viewer" \
      || fail "$C.model.embed" "no embedded mesh in $ohtml"
    ;;
  *) skip "$C.model" "set OC_RECONSTRUCT_3D_E2E=1 to run the 3D mesh lift (fal queue, minutes + higher cost)" ;;
esac
