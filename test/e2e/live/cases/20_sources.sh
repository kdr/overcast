#!/usr/bin/env bash
# Real OSINT sources: web search (Tavily), dork (Serper.dev Google dorking),
# shodan (host/service recon), tiktok (Apify), x (Apify), lens reverse image
# search (Apify), youtube (yt-dlp), and the opt-in identity/records sources
# username/person/phone/property/plate (Apify; gate on APIFY_TOKEN, benign targets).
# Bound via OVERCAST_SOURCE_<TYPE>_CMD with absolute paths (the bun binary can't
# auto-resolve the shipped examples/).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=source
SRCDIR="$PWD/examples/providers/sources"

assert_scan_hits() {
  local id="$1" out="$2" label="$3"
  local hits url title err
  hits="$(echo "$out" | jq -s '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.url // "") != "")]|length' 2>/dev/null)"
  url="$(echo "$out" | jq -s -r '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.url // "") != "")][0].payload.url // empty' 2>/dev/null)"
  title="$(echo "$out" | jq -s -r '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.title // "") != "")][0].payload.title // empty' 2>/dev/null)"
  if [ "${hits:-0}" -ge 1 ]; then
    ok "$id" "$label returned $hits hit(s): ${title:-$url}"
    assert_nonempty "$id.url" "$url" "$label first hit has a url"
  else
    err="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // "no hits"' 2>/dev/null)"
    fail "$id" "$label returned no usable hits ($err)"
  fi
}

# assert_scan_ready: like assert_scan_hits but does NOT require payload.url — for
# metadata sources whose hits legitimately carry no url (e.g. `phone` number intel,
# or a `person`/`property` record with no linked profile/source page). The hit's
# meaningful signal is asserted separately by the caller (e.g. country / owner).
assert_scan_ready() {
  local id="$1" out="$2" label="$3"
  local hits title
  hits="$(echo "$out" | jq -s '[.[]|select(.state=="ready" and .verb=="scan")]|length' 2>/dev/null)"
  title="$(echo "$out" | jq -s -r '[.[]|select(.state=="ready" and .verb=="scan" and (.payload.title // "") != "")][0].payload.title // empty' 2>/dev/null)"
  if [ "${hits:-0}" -ge 1 ]; then
    ok "$id" "$label returned $hits ready record(s): ${title:-<no title>}"
  else
    local err
    err="$(echo "$out" | jq -s -r '[.[]|select(.state=="error" or .state=="needs_credentials")][0].error // "no records"' 2>/dev/null)"
    fail "$id" "$label returned no ready records ($err)"
  fi
}

# scan evidence must surface in the case's records web export (the audit page)
assert_export_has() { # <id> <casedir> <needle> <label>
  local id="$1" cd="$2" needle="$3" label="$4"
  ocrun "$cd" case records --export "$cd/records.html" --theme csi --json >/dev/null 2>&1
  if [ -s "$cd/records.html" ] && [ -n "$needle" ] && grep -qF "$needle" "$cd/records.html"; then
    ok "$id" "$label present in records html export"
  else
    fail "$id" "$label missing from records html export (needle: ${needle:-<empty>})"
  fi
}

# --- web (Tavily) ---
if require_cred "$C.web" TAVILY_API_KEY "skipping web search"; then
  CASE=$(case_dir src_web)
  export OVERCAST_SOURCE_WEB_CMD="bash $SRCDIR/web.sh"
  ocrun "$CASE" source add 'web:overcast weather app' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source web --limit 3 --json)"
  save_json "20_scan_web" "$out" >/dev/null
  assert_scan_hits "$C.web.query" "$out" "web query"
  weburl="$(echo "$out" | jq -s -r '[.[]|select(.state=="ready" and .verb=="scan")][0].payload.url // empty' 2>/dev/null)"
  assert_export_has "$C.web.export" "$CASE" "$weburl" "web text hit url"
  unset OVERCAST_SOURCE_WEB_CMD
fi

# --- dork (Serper.dev Google dorking) — operators honored; small limit ---
if require_cred "$C.dork" SERPER_API_KEY "skipping dork (Google dorking)"; then
  CASE=$(case_dir src_dork)
  export OVERCAST_SOURCE_DORK_CMD="bash $SRCDIR/dork.sh"
  ocrun "$CASE" source add 'dork:site:nasa.gov filetype:pdf' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source dork --limit 3 --json)"
  save_json "20_scan_dork" "$out" >/dev/null
  assert_scan_hits "$C.dork.query" "$out" "dork operator search (site: + filetype:)"
  dorkurl="$(echo "$out" | jq -s -r '[.[]|select(.state=="ready" and .verb=="scan")][0].payload.url // empty' 2>/dev/null)"
  assert_export_has "$C.dork.export" "$CASE" "$dorkurl" "dork hit url"
  unset OVERCAST_SOURCE_DORK_CMD
fi

# --- shodan (host/service recon) — search + single-host lookup, small limits ---
if require_cred "$C.shodan" SHODAN_API_KEY "skipping shodan"; then
  export OVERCAST_SOURCE_SHODAN_CMD="bash $SRCDIR/shodan.sh"

  CASE=$(case_dir src_shodan_search)
  ocrun "$CASE" source add 'shodan:product:nginx' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source shodan --limit 3 --json)"
  save_json "20_scan_shodan_search" "$out" >/dev/null
  assert_scan_hits "$C.shodan.search" "$out" "shodan search"
  # a shodan hit must carry host intel (ip) in the payload — the point of the source
  ip="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.ip != null))][0].payload.ip // empty' 2>/dev/null)"
  assert_nonempty "$C.shodan.ip" "$ip" "shodan hit carries ip host intel"

  CASE=$(case_dir src_shodan_host)
  ocrun "$CASE" source add 'shodan:8.8.8.8' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source shodan --limit 5 --json)"
  save_json "20_scan_shodan_host" "$out" >/dev/null
  assert_scan_hits "$C.shodan.host" "$out" "shodan single-host lookup"

  # opt-in screenshots (OVERCAST_SHODAN_SCREENSHOTS): hits are preserved AND the
  # exposed-host screenshots are decoded into materialized image evidence.
  CASE=$(case_dir src_shodan_shots)
  export OVERCAST_SHODAN_SCREENSHOTS=1
  ocrun "$CASE" source add 'shodan:has_screenshot:true product:VNC' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source shodan --limit 3 --json)"
  save_json "20_scan_shodan_shots" "$out" >/dev/null
  assert_scan_hits "$C.shodan.shots" "$out" "shodan opt-in screenshots (hits preserved)"
  shots="$(echo "$out" | jq -s '[.[]|select(.verb=="scan" and .state=="ready" and .payload.screenshot==true)]|length' 2>/dev/null)"
  if [ "${shots:-0}" -ge 1 ]; then
    ok "$C.shodan.shot" "materialized $shots exposed-host screenshot(s) as image evidence"
  else
    # Screenshots are BEST-EFFORT (a host may be down or return no decodable bytes);
    # the contract asserted above is "hits preserved", so absence is a skip, not a
    # failure.
    skip "$C.shodan.shot" "no decodable screenshots this run (best-effort; hits were preserved, which is the contract)"
  fi
  unset OVERCAST_SHODAN_SCREENSHOTS

  unset OVERCAST_SOURCE_SHODAN_CMD
fi

# --- tiktok (Apify) — profile + hashtag; small limits to keep cost low ---
if require_cred "$C.tiktok" APIFY_TOKEN "skipping tiktok"; then
  export OVERCAST_SOURCE_TIKTOK_CMD="bash $SRCDIR/tiktok.sh"

  CASE=$(case_dir src_tiktok_user)
  ocrun "$CASE" source add 'tiktok:@chefreactions' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=180 oc "$CASE" scan --source tiktok --limit 2 --json)"
  save_json "20_scan_tiktok_user" "$out" >/dev/null
  assert_scan_hits "$C.tiktok.user" "$out" "tiktok profile"

  CASE=$(case_dir src_tiktok_tag)
  ocrun "$CASE" source add 'tiktok:#space' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=180 oc "$CASE" scan --source tiktok --limit 2 --json)"
  save_json "20_scan_tiktok_tag" "$out" >/dev/null
  assert_scan_hits "$C.tiktok.tag" "$out" "tiktok hashtag"

  unset OVERCAST_SOURCE_TIKTOK_CMD
fi

# --- x (Apify) — profile + video-targeted search; small limits to keep cost low ---
if require_cred "$C.x" APIFY_TOKEN "skipping x"; then
  export OVERCAST_SOURCE_X_CMD="bash $SRCDIR/x.sh"

  CASE=$(case_dir src_x_handle)
  ocrun "$CASE" source add 'x:@NASA' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=180 oc "$CASE" scan --source x --limit 5 --json)"
  save_json "20_scan_x_handle" "$out" >/dev/null
  assert_scan_hits "$C.x.handle" "$out" "x profile"

  CASE=$(case_dir src_x_video)
  ocrun "$CASE" source add 'x:video:space launch' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=180 oc "$CASE" scan --source x --limit 5 --json)"
  save_json "20_scan_x_video" "$out" >/dev/null
  assert_scan_hits "$C.x.video" "$out" "x video-targeted search"

  unset OVERCAST_SOURCE_X_CMD
fi

# --- lens (Apify Google Lens reverse image) — stable public image, small limit ---
if require_cred "$C.lens" APIFY_TOKEN "skipping lens reverse image search"; then
  CASE=$(case_dir src_lens)
  export OVERCAST_SOURCE_LENS_CMD="bash $SRCDIR/lens.sh"
  ocrun "$CASE" source add 'lens:https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg/330px-Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=420 oc "$CASE" scan --source lens --limit 2 --json)"
  save_json "20_scan_lens" "$out" >/dev/null
  assert_scan_hits "$C.lens.query" "$out" "lens reverse image"
  match="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.match // empty' 2>/dev/null)"
  assert_nonempty "$C.lens.match" "$match" "lens hit carries a match kind (exact|visual)"
  # exact-match thumbnails are materialized into the case media dir as evidence
  thumb="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and .payload.match=="exact")][0].payload.thumbnail_path // empty' 2>/dev/null)"
  if [ -n "$thumb" ] && [ -s "$thumb" ]; then
    ok "$C.lens.thumb" "exact match thumbnail materialized: $(basename "$thumb")"
  else
    fail "$C.lens.thumb" "no materialized thumbnail for an exact lens match"
  fi
  lensurl="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.url // empty' 2>/dev/null)"
  assert_export_has "$C.lens.export" "$CASE" "$lensurl" "lens image match url"
  # local image query, case-relative: the CLI runs with --case from another cwd,
  # so the bare filename only resolves through OVERCAST_CASE_DIR (upload path)
  if [ -n "${OC_IMAGE:-}" ] && [ -f "$OC_IMAGE" ]; then
    cp "$OC_IMAGE" "$CASE/lens_query.${OC_IMAGE##*.}"
    out="$(OC_TIMEOUT=420 oc "$CASE" scan --source lens --query "lens_query.${OC_IMAGE##*.}" --limit 2 --json)"
    save_json "20_scan_lens_local" "$out" >/dev/null
    assert_scan_hits "$C.lens.local" "$out" "lens local case-relative image"
  else
    skip "$C.lens.local" "no OC_IMAGE — skipping lens local-file query"
  fi
  unset OVERCAST_SOURCE_LENS_CMD
fi

# --- yandeximg (Apify Yandex reverse image) — built-in actor + image_url key ---
if require_cred "$C.yandeximg" APIFY_TOKEN "skipping yandeximg reverse image search"; then
  CASE=$(case_dir src_yandeximg)
  export OVERCAST_SOURCE_YANDEXIMG_CMD="bash $SRCDIR/yandeximg.sh"
  # stable public image; the built-in default actor (johnvc~yandex-reverse-image-search)
  # is invoked with the image under its `image_url` input key — asserts the shipped
  # default actor + input key work end to end with only APIFY_TOKEN set (no
  # OVERCAST_YANDEX_ACTOR / OVERCAST_YANDEX_IMAGE_KEY override required).
  ocrun "$CASE" source add 'yandeximg:https://upload.wikimedia.org/wikipedia/commons/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=420 oc "$CASE" scan --source yandeximg --limit 3 --json)"
  save_json "20_scan_yandeximg" "$out" >/dev/null
  assert_scan_hits "$C.yandeximg.query" "$out" "yandeximg reverse image (built-in actor + image_url key)"
  ymatch="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.match // empty' 2>/dev/null)"
  assert_nonempty "$C.yandeximg.match" "$ymatch" "yandeximg hit carries a match kind"
  yurl="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.url // empty' 2>/dev/null)"
  assert_export_has "$C.yandeximg.export" "$CASE" "$yurl" "yandeximg match url"
  unset OVERCAST_SOURCE_YANDEXIMG_CMD
fi

# --- youtube (yt-dlp) — channel + playlist URL + keyword search ---
if have_cmd yt-dlp; then
  export OVERCAST_SOURCE_YOUTUBE_CMD="bash $SRCDIR/youtube.sh"

  CASE=$(case_dir src_youtube_handle)
  ocrun "$CASE" source add 'youtube:@aiDotEngineer' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source youtube --limit 2 --json)"
  save_json "20_scan_youtube_handle" "$out" >/dev/null
  assert_scan_hits "$C.youtube.handle" "$out" "youtube handle"

  CASE=$(case_dir src_youtube_playlist)
  ocrun "$CASE" source add 'youtube:https://www.youtube.com/watch?v=jWy39wavbjY&list=PLfaIDFEXuae2uJrYpdMZz_HbFfCfYIlVR' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source youtube --limit 2 --json)"
  save_json "20_scan_youtube_playlist" "$out" >/dev/null
  assert_scan_hits "$C.youtube.playlist" "$out" "youtube playlist URL"

  CASE=$(case_dir src_youtube_search)
  ocrun "$CASE" source add 'youtube:search:baseball' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source youtube --limit 2 --json)"
  save_json "20_scan_youtube_search" "$out" >/dev/null
  assert_scan_hits "$C.youtube.search" "$out" "youtube keyword search"

  unset OVERCAST_SOURCE_YOUTUBE_CMD
else
  skip "$C.youtube" "yt-dlp not installed"
fi

# --- webcam (Windy Webcams API) — geolocated cams near a point + still capture ---
if require_cred "$C.webcam" WINDY_API_KEY "skipping webcam (Windy)"; then
  CASE=$(case_dir src_webcam)
  export OVERCAST_SOURCE_WEBCAM_CMD="bash $SRCDIR/webcam.sh"
  ocrun "$CASE" source add 'webcam:48.8584,2.2945,50' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source webcam --limit 3 --json)"
  save_json "20_scan_webcam" "$out" >/dev/null
  assert_scan_hits "$C.webcam.nearby" "$out" "webcam nearby"
  # a webcam hit must carry geolocation (the point of the source)
  lat="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.lat != null))][0].payload.lat // empty' 2>/dev/null)"
  assert_nonempty "$C.webcam.geo" "$lat" "webcam hit carries lat/lng"
  # capture the current still (the free tier serves a still image, kind:image)
  hitid="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].id // empty' 2>/dev/null)"
  if [ -n "$hitid" ]; then
    capout="$(OC_TIMEOUT=120 oc "$CASE" capture "$hitid" --json)"
    save_json "20_capture_webcam" "$capout" >/dev/null
    capstate="$(echo "$capout" | jq -s -r '[.[]|select(.verb=="capture")][0].state // empty' 2>/dev/null)"
    capkind="$(echo "$capout" | jq -s -r '[.[]|select(.verb=="capture")][0].payload.kind // empty' 2>/dev/null)"
    if [ "$capstate" = "ready" ] && [ "$capkind" = "image" ]; then
      ok "$C.webcam.capture" "captured current still (kind=$capkind)"
    else
      fail "$C.webcam.capture" "webcam still capture failed (state=${capstate:-?} kind=${capkind:-?})"
    fi
  else
    fail "$C.webcam.capture" "no webcam hit to capture"
  fi
  unset OVERCAST_SOURCE_WEBCAM_CMD
fi

# --- gdelttv (GDELT 2.0 TV, no key) — broadcast-news clip search ---
export OVERCAST_SOURCE_GDELTTV_CMD="bash $SRCDIR/gdelttv.sh"
CASE=$(case_dir src_gdelttv)
ocrun "$CASE" source add 'gdelttv:climate change' --json >/dev/null 2>&1
out="$(OC_TIMEOUT=120 oc "$CASE" scan --source gdelttv --limit 3 --json)"
save_json "20_scan_gdelttv" "$out" >/dev/null
assert_scan_hits "$C.gdelttv.query" "$out" "gdelttv broadcast search"
unset OVERCAST_SOURCE_GDELTTV_CMD

# --- dispatch (Socrata calls-for-service, no key) — SF real-time CAD feed ---
export OVERCAST_SOURCE_DISPATCH_CMD="bash $SRCDIR/dispatch.sh"
CASE=$(case_dir src_dispatch)
ocrun "$CASE" source add 'dispatch:sf' --json >/dev/null 2>&1
out="$(OC_TIMEOUT=120 oc "$CASE" scan --source dispatch --since 2d --limit 10 --json)"
save_json "20_scan_dispatch" "$out" >/dev/null
assert_scan_hits "$C.dispatch.sf" "$out" "dispatch SF calls-for-service"
# a dispatch hit must carry geolocation + a call-type title (the point of the
# source); sensitive calls may omit the location, so assert on ANY one hit.
dlat="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.gps.lat != null))][0].payload.gps.lat // empty' 2>/dev/null)"
assert_nonempty "$C.dispatch.gps" "$dlat" "dispatch hit carries payload.gps"
dtitle="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and ((.payload.title // "") != ""))][0].payload.title // empty' 2>/dev/null)"
assert_nonempty "$C.dispatch.title" "$dtitle" "dispatch hit carries a call-type title"
# every ref must be a per-row QUERY deep link (?<col>=… or ?$where=:id='…') —
# never a fragment, which curl drops (fetch would download the whole dataset)
# and which is why the row-hash fallback was removed.
dref="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")|.media.ref // ""] | if length > 0 and all(test("/resource/.*\\.json\\?") and (contains("#")|not)) then "ok" else "" end' 2>/dev/null)"
assert_nonempty "$C.dispatch.ref" "$dref" "dispatch refs are per-row query deep links (no fragments)"
unset OVERCAST_SOURCE_DISPATCH_CMD

# --- instagram + telegram (Apify) — small limits to keep cost low ---
if require_cred "$C.instagram" APIFY_TOKEN "skipping instagram"; then
  CASE=$(case_dir src_instagram)
  export OVERCAST_SOURCE_INSTAGRAM_CMD="bash $SRCDIR/instagram.sh"
  ocrun "$CASE" source add 'instagram:@nasa' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=300 oc "$CASE" scan --source instagram --limit 2 --json)"
  save_json "20_scan_instagram" "$out" >/dev/null
  assert_scan_hits "$C.instagram.profile" "$out" "instagram profile"
  unset OVERCAST_SOURCE_INSTAGRAM_CMD
fi

if require_cred "$C.telegram" APIFY_TOKEN "skipping telegram"; then
  CASE=$(case_dir src_telegram)
  export OVERCAST_SOURCE_TELEGRAM_CMD="bash $SRCDIR/telegram.sh"
  ocrun "$CASE" source add 'telegram:durov' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=300 oc "$CASE" scan --source telegram --limit 2 --since 30d --json)"
  save_json "20_scan_telegram" "$out" >/dev/null
  assert_scan_hits "$C.telegram.channel" "$out" "telegram channel"
  unset OVERCAST_SOURCE_TELEGRAM_CMD
fi

# --- identity / records sources (Apify) — username / person / phone / property /
# plate. These hit LIVE PII on real people and spend Apify credits, so like the
# other Apify sources they gate on APIFY_TOKEN. Targets are kept benign — a public
# org handle, a corporate phone line, a government building, an overridable common
# name (OC_PERSON_QUERY / OC_PROPERTY_QUERY), and the deterministic DPPA gate on
# `plate`. Do NOT point person/phone at private individuals in CI.
if require_cred "$C.identity" APIFY_TOKEN "skipping identity/records sources"; then
  # username — Maigret account discovery for a public org handle
  CASE=$(case_dir src_username)
  export OVERCAST_SOURCE_USERNAME_CMD="bash $SRCDIR/username.sh"
  ocrun "$CASE" source add 'username:bellingcat' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=300 oc "$CASE" scan --source username --limit 6 --json)"
  save_json "20_scan_username" "$out" >/dev/null
  assert_scan_hits "$C.username.accounts" "$out" "username account discovery"
  purl="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and ((.payload.url // "")|test("^https?://")))][0].payload.url // empty' 2>/dev/null)"
  assert_nonempty "$C.username.profileurl" "$purl" "username hit carries a profile URL"
  unset OVERCAST_SOURCE_USERNAME_CMD

  # phone — PhoneInfoga on a public corporate line (offline parse + footprint)
  CASE=$(case_dir src_phone)
  export OVERCAST_SOURCE_PHONE_CMD="bash $SRCDIR/phone.sh"
  ocrun "$CASE" source add 'phone:+14089961010' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=300 oc "$CASE" scan --source phone --json)"
  save_json "20_scan_phone" "$out" >/dev/null
  assert_scan_ready "$C.phone.number" "$out" "phone number OSINT"   # url-less (metadata) hits
  pcountry="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready")][0].payload.country // empty' 2>/dev/null)"
  assert_nonempty "$C.phone.country" "$pcountry" "phone hit carries a parsed country"
  unset OVERCAST_SOURCE_PHONE_CMD

  # property — county assessor lookup for a government building (reliably covered)
  CASE=$(case_dir src_property)
  export OVERCAST_SOURCE_PROPERTY_CMD="bash $SRCDIR/property.sh"
  ocrun "$CASE" source add "property:${OC_PROPERTY_QUERY:-1001 Preston St, Houston, TX 77002}" --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=300 oc "$CASE" scan --source property --json)"
  save_json "20_scan_property" "$out" >/dev/null
  assert_scan_ready "$C.property.address" "$out" "property assessor records"   # source_url may be absent
  powner="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and (.payload.owner != null))][0].payload.owner // empty' 2>/dev/null)"
  assert_nonempty "$C.property.owner" "$powner" "property hit carries an owner"
  unset OVERCAST_SOURCE_PROPERTY_CMD

  # person — people-search / skip-trace for an overridable common name
  CASE=$(case_dir src_person)
  export OVERCAST_SOURCE_PERSON_CMD="bash $SRCDIR/person.sh"
  ocrun "$CASE" source add "person:${OC_PERSON_QUERY:-Robert Williams}" --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=300 oc "$CASE" scan --source person --limit 3 --json)"
  save_json "20_scan_person" "$out" >/dev/null
  assert_scan_ready "$C.person.name" "$out" "person people-search"   # profileUrl may be absent
  pname="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan" and .state=="ready" and ((.payload.full_name // "") != ""))][0].payload.full_name // empty' 2>/dev/null)"
  assert_nonempty "$C.person.record" "$pname" "person hit carries a resolved name"
  unset OVERCAST_SOURCE_PERSON_CMD

  # plate — deterministic DPPA gate: with no OVERCAST_PLATE_ACTOR it must report
  # needs_credentials (a setup gap), NOT a fake-clean empty scan. Costs nothing.
  CASE=$(case_dir src_plate_gate)
  export OVERCAST_SOURCE_PLATE_CMD="bash $SRCDIR/plate.sh"
  unset OVERCAST_PLATE_ACTOR
  ocrun "$CASE" source add 'plate:CA:7ABC123' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=60 oc "$CASE" scan --source plate --json 2>/dev/null)"
  save_json "20_scan_plate_gate" "$out" >/dev/null
  pst="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan")][0].state // empty' 2>/dev/null)"
  if [ "$pst" = "needs_credentials" ]; then
    ok "$C.plate.gate" "plate reports needs_credentials without OVERCAST_PLATE_ACTOR (DPPA-gated, no default)"
  else
    fail "$C.plate.gate" "expected needs_credentials without a bound plate actor, got '$pst'"
  fi
  unset OVERCAST_SOURCE_PLATE_CMD
fi
