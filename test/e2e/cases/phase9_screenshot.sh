#!/usr/bin/env bash
# Phase 9 e2e: browser screen capture — the `screenshot` verb + the `browser`
# source, offline via the committed fixture engine (no node/playwright/chromium).
# Verifies: verb render → web.screenshot PNG record; --full-page flag threads
# through; missing-renderer → needs_credentials (not a hard error); the real
# browser.sh enumerate emits one recapture hit; source scan --pull captures an
# image; monitor re-captures the ephemeral hit every pass (never seen-suppressed).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

FIX="$REPO/test/fixtures/fake-screenshot.sh"

casedir="$SMOKE_DIR/case_screenshot"; mkdir -p "$casedir"
ochome="$SMOKE_DIR/home_screenshot"; mkdir -p "$ochome/profiles"
# bind the screenshot verb to the fixture engine (like fx.json binds watch)
cat >"$ochome/profiles/shot.json" <<JSON
{"name":"shot","providers":{"screenshot":{"type":"exec","run":"bash $FIX run --input {{input}} --json"}}}
JSON
G=(--case "$casedir" --home "$ochome" --profile shot)

# 1) verb: render a URL → a ready web.screenshot record with a PNG media.ref
shot="$($OVERCAST screenshot https://example.com --full-page --json "${G[@]}" 2>/dev/null)"
save_json "phase9_screenshot" "$shot" >/dev/null
assert_eq "screenshot.state" "ready" "$(jq -r '.state' <<<"$shot")" "screenshot verb ready"
assert_eq "screenshot.url" "https://example.com" "$(jq -r '.payload.url' <<<"$shot")" "payload carries url"
assert_eq "screenshot.full_page" "true" "$(jq -r '.payload.full_page' <<<"$shot")" "--full-page threaded through"
ref="$(jq -r '.media.ref' <<<"$shot")"
case "$ref" in *.png) ok "screenshot.media_png" "media.ref is a .png ($(basename "$ref"))" ;; *) fail "screenshot.media_png" "media.ref not a png: $ref" ;; esac
[ -f "$ref" ] && ok "screenshot.file_exists" "rendered PNG on disk" || fail "screenshot.file_exists" "no file at $ref"
assert_eq "screenshot.case_stamped" "$casedir" "$(jq -r '.meta.case' <<<"$shot")" "meta.case stamped"

# 2) verb: a missing renderer degrades to needs_credentials, not a hard error
cd="$SMOKE_DIR/case_screenshot_missing"; mkdir -p "$cd"
miss="$(OVERCAST_FAKE_SHOT_FAIL13=1 $OVERCAST screenshot https://example.com --json --case "$cd" --home "$ochome" --profile shot 2>/dev/null)"
save_json "phase9_screenshot_missing" "$miss" >/dev/null
assert_eq "screenshot.needs_creds" "needs_credentials" "$(jq -r '.state' <<<"$miss")" "missing renderer → needs_credentials"

# 3) the SHIPPED browser.sh enumerate emits one ephemeral recapture hit (jq-only,
#    no renderer needed) — validates the real source contract offline
enum="$(bash "$REPO/providers/sources/browser.sh" enumerate --query https://example.com 2>/dev/null)"
assert_eq "browser.enum_count" "1" "$(jq 'length' <<<"$enum")" "browser enumerate is one hit"
assert_eq "browser.enum_recapture" "true" "$(jq -r '.[0].recapture' <<<"$enum")" "browser hit is recapture (ephemeral)"
assert_eq "browser.enum_source" "browser" "$(jq -r '.[0].source' <<<"$enum")" "browser hit tagged source=browser"
# scheme-less refs assume https
enum2="$(bash "$REPO/providers/sources/browser.sh" enumerate --query example.org 2>/dev/null)"
assert_eq "browser.enum_scheme" "https://example.org" "$(jq -r '.[0].url' <<<"$enum2")" "scheme-less ref → https"

# 4) source plumbing: bind the fixture engine as the browser source; scan --pull
#    renders + captures an image; monitor re-captures the ephemeral hit each pass
export OVERCAST_SOURCE_BROWSER_CMD="bash $FIX"
scase="$SMOKE_DIR/case_browser_src"; mkdir -p "$scase"
S=(--case "$scase" --home "$ochome" --profile shot)
$OVERCAST source add "browser:https://example.com" "${S[@]}" >/dev/null 2>&1
scan_out="$($OVERCAST scan --pull --json "${S[@]}" 2>/dev/null)"
save_json "phase9_browser_scan" "$scan_out" >/dev/null
nhit="$(jq -s '[.[]|select(.verb=="scan" and (.payload.op // "")!="pull_progress")]|length' <<<"$scan_out" 2>/dev/null)"
ncap="$(jq -s '[.[]|select(.verb=="capture" and .payload.kind=="image")]|length' <<<"$scan_out" 2>/dev/null)"
assert_eq "browser.scan_hit" "1" "$nhit" "browser scan emitted one hit"
[ "${ncap:-0}" -ge 1 ] && ok "browser.scan_capture" "scan --pull captured an image ($ncap)" || fail "browser.scan_capture" "no image capture"

mcase="$SMOKE_DIR/case_browser_mon"; mkdir -p "$mcase"
M=(--case "$mcase" --home "$ochome" --profile shot)
$OVERCAST source add "browser:https://example.com" "${M[@]}" >/dev/null 2>&1
mon1="$($OVERCAST monitor --once --json "${M[@]}" 2>/dev/null)"
new1="$(jq -s '.[]|select(.verb=="monitor")|.payload.new_items' <<<"$mon1" 2>/dev/null | head -1)"
seen1="$(jq -s '.[]|select(.verb=="monitor")|.payload.seen_size' <<<"$mon1" 2>/dev/null | head -1)"
assert_eq "browser.mon_first" "1" "$new1" "monitor first pass captures the page"
assert_eq "browser.mon_ephemeral" "0" "$seen1" "ephemeral hit not added to seen"
mon2="$($OVERCAST monitor --once --json "${M[@]}" 2>/dev/null)"
new2="$(jq -s '.[]|select(.verb=="monitor")|.payload.new_items' <<<"$mon2" 2>/dev/null | head -1)"
assert_eq "browser.mon_recapture" "1" "$new2" "monitor re-captures the page next pass (recapture)"

# 5) the verb surface lists screenshot
$OVERCAST commands --json 2>/dev/null | jq -r '.verbs[].name' | grep -qx screenshot \
  && ok "screenshot.verb_surface" "screenshot listed in commands --json" \
  || fail "screenshot.verb_surface" "screenshot missing from verb surface"
