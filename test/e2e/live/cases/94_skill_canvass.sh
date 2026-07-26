#!/usr/bin/env bash
# SKILL: overcast-canvass — "canvass the cameras near the scene".
# Drives the skill's documented chain: (1) forward-geocode a sample address to a
# point via the shipped geocode provider (keyless Nominatim), (2) fan the OSM
# fixed-camera `overpass` source around a known camera-dense urban point and scan
# it (keyless), (3) render the canvass map, (4) the WINDY_API_KEY-gated `webcam`
# leg. Keyless legs run everywhere; a genuinely empty/unreachable external result
# SKIPS (not fails), while a provider ERROR fails — an error must not pass as an
# empty canvass.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_canvass

SKILL_FILE="$PWD/skills/overcast-canvass/SKILL.md"
[ -f "$SKILL_FILE" ] || { fail "$C.file" "vended skill missing: $SKILL_FILE (run overcast skills generate)"; exit 0; }
GEOCODE_SH="$PWD/providers/senses/geocode/geocode.sh"
[ -f "$GEOCODE_SH" ] || { fail "$C.geocode_sh" "geocode provider script missing: $GEOCODE_SH"; exit 0; }

CASE=$(case_dir skill_canvass)

# A camera-dense urban point (central London, around Trafalgar Square) with
# well-mapped OSM surveillance nodes; radius in meters.
LAT=51.508
LNG=-0.128
RADIUS=1200

# 1) skill step: forward-geocode an address -> a point (keyless Nominatim)
cond "canvass skill: geocode --query forward-resolves an address to a numeric point"
gout="$(bash "$GEOCODE_SH" --query "350 Fifth Ave, New York, NY" 2>/dev/null)"; grc=$?
save_json "94_canvass_geocode" "$gout" >/dev/null
gstate="$(echo "$gout" | jq -r '.state // ""' 2>/dev/null)"
glat="$(echo "$gout" | jq -r '.payload.lat // empty' 2>/dev/null)"
glng="$(echo "$gout" | jq -r '.payload.lng // empty' 2>/dev/null)"
# A provider ERROR or a CRASH (non-zero exit / empty / non-JSON output) must not
# pass as a skip (matches the overpass leg + this file's header): both mean the
# geocode script regressed, not that the address is absent. Only a clean no-match
# (state:ready, no coords) is the skippable "empty" case.
if [ "$grc" -ne 0 ] || [ -z "$gout" ] || ! echo "$gout" | jq -e . >/dev/null 2>&1; then
  fail "$C.geocode" "forward geocode crashed / emitted no JSON record (exit=$grc)"
elif [ "$gstate" = "error" ]; then
  gerr="$(echo "$gout" | jq -r '.error // "unknown error"' 2>/dev/null)"
  fail "$C.geocode" "forward geocode errored (not a clean no-match): $gerr"
elif [ -n "$glat" ] && echo "$glat" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$'; then
  ok "$C.geocode" "forward geocode returned a numeric point (lat=$glat lng=$glng)"
else
  skip "$C.geocode" "forward geocode returned no match for the sample address (empty result) — skipped"
fi

# 2) skill step: fan the OSM fixed-camera source around the point (keyless)
cond "canvass skill: source add overpass:man_made=surveillance@around registers the camera source"
sout="$(oc "$CASE" source add "overpass:man_made=surveillance@around:$RADIUS,$LAT,$LNG" --json)"
save_json "94_canvass_source" "$sout" >/dev/null
sstate="$(echo "$sout" | jq -s -r '[.[]|select(.verb=="source")][0].state // ""' 2>/dev/null)"
assert_eq "$C.source" "ready" "$sstate" "overpass surveillance source registered"

cond "canvass skill: scan --source overpass pulls OSM fixed-camera nodes near the point"
out="$(OC_TIMEOUT=180 oc "$CASE" scan --source overpass --limit 200 --json)"
save_json "94_canvass_scan" "$out" >/dev/null
serr="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // ""' 2>/dev/null)"
if [ -n "$serr" ] && [ "$serr" != "null" ]; then
  fail "$C.scan" "overpass scan errored (not an empty area): $serr"
  exit 0
fi
hits="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")]|length' 2>/dev/null)"
if [ -z "$hits" ] || [ "$hits" = "0" ]; then
  skip "$C.scan" "overpass returned 0 mapped cameras near the point (crowd-mapped, may be sparse) — downstream asserts skipped"
  exit 0
fi
ok "$C.scan" "overpass canvass returned $hits mapped camera nodes"

# a camera node carries top-level payload.gps and an openstreetmap.org media.ref
clat="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.gps.lat != null))][0].payload.gps.lat // empty' 2>/dev/null)"
assert_nonempty "$C.gps" "$clat" "camera node carries payload.gps (lat=$clat)"
cref="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and ((.media.ref // "")|test("openstreetmap.org")))][0].media.ref // empty' 2>/dev/null)"
assert_nonempty "$C.ref" "$cref" "camera node carries an openstreetmap.org media.ref"

# 3) skill step: plot the canvass on one map
cond "canvass skill: map --no-open renders the geolocated cameras"
MAP_HTML="$SMOKE_DIR/94_canvass_map.html"
mapout="$(oc "$CASE" map --no-open --export "$MAP_HTML" --json)"
save_json "94_canvass_map" "$mapout" >/dev/null
mapstate="$(echo "$mapout" | jq -s -r '[.[]|select(.verb=="map")][0].state // ""' 2>/dev/null)"
assert_eq "$C.map" "ready" "$mapstate" "canvass map rendered"
if [ -f "$MAP_HTML" ]; then ok "$C.map_file" "map HTML written ($MAP_HTML)"; else fail "$C.map_file" "map HTML missing"; fi

# 4) skill step: the WINDY_API_KEY-gated live-webcam leg
if require_cred "$C.webcam" WINDY_API_KEY "live-webcam canvass leg skipped"; then
  cond "canvass skill: webcam source lists live public webcams near the point"
  wsrc="$(oc "$CASE" source add "webcam:$LAT,$LNG,5" --json)"
  save_json "94_canvass_webcam_source" "$wsrc" >/dev/null
  wout="$(OC_TIMEOUT=180 oc "$CASE" scan --source webcam --limit 20 --json)"
  save_json "94_canvass_webcam_scan" "$wout" >/dev/null
  werr="$(echo "$wout" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // ""' 2>/dev/null)"
  if [ -n "$werr" ] && [ "$werr" != "null" ]; then
    fail "$C.webcam" "webcam scan errored: $werr"
  else
    ok "$C.webcam" "webcam canvass leg completed (ran with WINDY_API_KEY)"
  fi
fi
