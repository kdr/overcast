#!/usr/bin/env bash
# Real forensics on REAL data: exif (ExifTool metadata/GPS/serial/lens) + verify
# (C2PA) via the shipped scripts against the SYSTEM exiftool/c2patool, then the
# metadata made actionable — geolocation (map + opt-in live Nominatim geocode) and
# device-linking (devices). Providers are bound with absolute $PWD/examples paths
# because the bun binary can't resolve the shipped examples/ from its virtual FS
# (same reason 12_see.sh binds HF/fal/tinycloud that way).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=forensics

# A geotagged photo (OC_EXIF_IMAGE) is ideal; fall back to a generic image
# (OC_IMAGE) or a real video frame (still exercises device/tags — just no GPS).
PHOTO="${OC_EXIF_IMAGE:-}"
if ! have_media "$PHOTO"; then
  if have_media "$IMAGE_FILE"; then PHOTO="$IMAGE_FILE"
  elif have_media "$VIDEO_VISUAL"; then PHOTO="$SMOKE_DIR/forensics_frame.jpg"; frame_jpg "$VIDEO_VISUAL" 2 "$PHOTO"
  elif have_media "$VIDEO_OBJECTS"; then PHOTO="$SMOKE_DIR/forensics_frame.jpg"; frame_jpg "$VIDEO_OBJECTS" 2 "$PHOTO"
  fi
fi
[ -n "${PHOTO:-}" ] && [ -f "$PHOTO" ] || { skip "$C" "no image (set OC_EXIF_IMAGE or OC_IMAGE / OC_VIDEO_*)"; exit 0; }
have_cmd exiftool || { skip "$C" "no exiftool on PATH (brew install exiftool / apt install libimage-exiftool-perl)"; exit 0; }

CASE=$(case_dir forensics)
EXIF_SH="$PWD/providers/senses/exif/exif.sh"
ocrun "$CASE" setup provider exif "exec:bash $EXIF_SH --input {{input}}" --json >/dev/null 2>&1

# --- exif: real embedded metadata ---
cond "exif reads real embedded metadata from a photo → ready media.metadata record"
xout="$(oc "$CASE" exif "$PHOTO" --json | primary_rec)"
save_json "34_exif" "$xout" >/dev/null
assert_eq "$C.exif.state" "ready" "$(jq -r '.state' <<<"$xout")" "exif ready"
tags="$(jq -r '.payload.tags // 0' <<<"$xout")"
if [ "${tags:-0}" -gt 0 ]; then
  ok "$C.exif.tags" "$tags tags; device=$(jq -r '[.payload.make,.payload.model]|map(select(.))|join(" ")' <<<"$xout")"
else
  fail "$C.exif.tags" "no tags parsed from a real photo"
fi

HAS_GPS="$(jq -r '.payload.gps != null' <<<"$xout")"
if [ "$HAS_GPS" = "true" ]; then
  assert_nonempty "$C.exif.gps" "$(jq -r '.payload.gps.lat // empty' <<<"$xout")" "GPS lat present"
  ok "$C.exif.gps_val" "GPS $(jq -rc '.payload.gps' <<<"$xout")"
else
  skip "$C.exif.gps" "photo has no GPS — set OC_EXIF_IMAGE to a geotagged photo to exercise map/geocode"
fi

# --- map: plot the case's GPS-bearing records ---
cond "map renders a self-contained HTML map of the case's GPS points"
mout="$(oc "$CASE" map --no-open --json)"
save_json "34_map" "$mout" >/dev/null
mstate="$(jq -r '.state' <<<"$mout")"
if [ "$HAS_GPS" = "true" ]; then
  assert_eq "$C.map.state" "ready" "$mstate" "map ready with points"
  mhtml="$(jq -r '.payload.viewer' <<<"$mout")"
  if [ -f "$mhtml" ] && grep -q "tile.openstreetmap.org" "$mhtml"; then
    ok "$C.map.html" "online map HTML written ($(jq -r '.payload.points' <<<"$mout") pts, OSM tiles inlined)"
  else
    fail "$C.map.html" "no online map html at $mhtml"
  fi
  moff="$(oc "$CASE" map --offline --no-open --json)"
  mhtml2="$(jq -r '.payload.viewer' <<<"$moff")"
  if [ -f "$mhtml2" ] && grep -q "openstreetmap.org/?mlat" "$mhtml2"; then
    ok "$C.map.offline" "offline scatter with openstreetmap.org deep links (no egress)"
  else
    fail "$C.map.offline" "no offline map at $mhtml2"
  fi
else
  assert_eq "$C.map.pending" "pending" "$mstate" "no GPS in case → map is transient pending guidance, not an error"
fi

# --- geofence: spatial+time query anchored on the photo's real GPS ---
if [ "$HAS_GPS" = "true" ]; then
  GLAT="$(jq -r '.payload.gps.lat' <<<"$xout")"
  GLNG="$(jq -r '.payload.gps.lng' <<<"$xout")"
  XID="$(jq -r '.id' <<<"$xout")"
  cond "geofence returns the exif record for a radius query around its own GPS"
  gfout="$(oc "$CASE" geofence --near "$GLAT,$GLNG" --radius 1000 --json)"
  save_json "34_geofence" "$gfout" >/dev/null
  assert_eq "$C.geofence.state" "ready" "$(jq -r '.state' <<<"$gfout")" "geofence ready"
  if jq -e --arg id "$XID" '.payload.matches[] | select(.record_id == $id)' <<<"$gfout" >/dev/null; then
    ok "$C.geofence.hit" "exif record inside the 1000 m fence ($(jq -r '.payload.count' <<<"$gfout") match(es))"
  else
    fail "$C.geofence.hit" "exif record $XID missing from geofence matches"
  fi
  # a fence on the far side of the planet returns zero matches with guidance
  zout="$(oc "$CASE" geofence --near 0,0 --radius 100 --json)"
  save_json "34_geofence_miss" "$zout" >/dev/null
  assert_eq "$C.geofence.miss" "0" "$(jq -r '.payload.count' <<<"$zout")" "far-away fence matches nothing"
  assert_nonempty "$C.geofence.miss_note" "$(jq -r '.payload.note // empty' <<<"$zout")" "empty fence carries guidance"
  # map --near: the spatial pre-filter renders a filtered map around the point
  cond "map --near renders the spatially filtered evidence map"
  mnear="$(oc "$CASE" map --near "$GLAT,$GLNG" --radius 1000 --no-open --json)"
  save_json "34_map_near" "$mnear" >/dev/null
  assert_eq "$C.map_near.state" "ready" "$(jq -r '.state' <<<"$mnear")" "filtered map ready"
  mnhtml="$(jq -r '.payload.viewer' <<<"$mnear")"
  if [ -f "$mnhtml" ] && [ "$(jq -r '.payload.points' <<<"$mnear")" -ge 1 ]; then
    ok "$C.map_near.html" "filtered map written ($(jq -r '.payload.points' <<<"$mnear") pt(s) in fence)"
  else
    fail "$C.map_near.html" "no filtered map at $mnhtml"
  fi
else
  skip "$C.geofence" "photo has no GPS — set OC_EXIF_IMAGE to a geotagged photo to exercise geofence/map --near"
fi

# --- geocode: opt-in LIVE Nominatim reverse geocode ---
if [ "$HAS_GPS" = "true" ] && have_cmd curl; then
  GEO_SH="$PWD/providers/senses/geocode/geocode.sh"
  ocrun "$CASE" setup provider geocode "exec:bash $GEO_SH --input {{input}}" --json >/dev/null 2>&1
  cond "exif --geocode resolves real GPS to a place name via OSM Nominatim"
  gout="$(OC_TIMEOUT=90 oc "$CASE" exif "$PHOTO" --geocode --json | primary_rec)"
  save_json "34_geocode" "$gout" >/dev/null
  place="$(jq -r '.payload.place // empty' <<<"$gout")"
  if [ -n "$place" ]; then
    ok "$C.geocode.place" "Nominatim → $(printf '%s' "$place" | cut -c1-72)"
  else
    fail "$C.geocode.place" "no place resolved (Nominatim rate-limit / no match?)"
  fi
else
  skip "$C.geocode" "needs GPS + curl (opt-in Nominatim reverse geocode)"
fi

# --- devices: correlate by camera fingerprint. A 2nd photo from the SAME camera
#     (OC_EXIF_IMAGE_2) proves serial linking; otherwise the rollup just runs. ---
if have_media "${OC_EXIF_IMAGE_2:-}"; then oc "$CASE" exif "$OC_EXIF_IMAGE_2" --json >/dev/null; fi
cond "devices rolls case exif records into camera-fingerprint clusters"
dall="$(oc "$CASE" devices --findings --json | jq -s '.')"
save_json "34_devices" "$dall" >/dev/null
drep="$(printf '%s' "$dall" | jq -c '.[] | select(.verb=="devices")')"
assert_eq "$C.devices.mode" "devices" "$(jq -r '.payload.mode' <<<"$drep")" "devices rollup runs"
ok "$C.devices.summary" "total_exif=$(jq -r '.payload.total_exif' <<<"$drep") clusters=$(jq -r '.payload.clusters|length' <<<"$drep")"

# --- verify: real C2PA provenance ---
if have_cmd c2patool; then
  VER_SH="$PWD/providers/senses/verify/verify.sh"
  ocrun "$CASE" setup provider verify "exec:bash $VER_SH --input {{input}}" --json >/dev/null 2>&1
  cond "verify reads real C2PA provenance → ready media.provenance record"
  vout="$(oc "$CASE" verify "$PHOTO" --json | primary_rec)"
  save_json "34_verify" "$vout" >/dev/null
  assert_eq "$C.verify.state" "ready" "$(jq -r '.state' <<<"$vout")" "verify ready"
  hm="$(jq -r '.payload.has_manifest' <<<"$vout")"
  case "$hm" in
    true)  ok "$C.verify.manifest" "signed manifest: signer=$(jq -r '.payload.signer // "?"' <<<"$vout"), state=$(jq -r '.payload.validation_state // "?"' <<<"$vout")" ;;
    false) ok "$C.verify.manifest" "no content credentials (clean ready result, not an error)" ;;
    *)     fail "$C.verify.manifest" "unexpected has_manifest=$hm" ;;
  esac
else
  skip "$C.verify" "no c2patool on PATH (brew install c2patool / cargo install c2patool)"
fi
