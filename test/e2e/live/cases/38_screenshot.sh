#!/usr/bin/env bash
# Real browser screen capture: the `screenshot` verb renders a live URL AND a
# local .html export to PNG evidence via the shipped Playwright engine, and the
# `browser:` source page-watches. Gated on the playwright optional dep + Chromium
# payload (skips cleanly when absent). The provider is bound with an absolute
# $PWD/examples path so render.mjs resolves playwright from the repo node_modules
# (the bun binary's sidecar copy has no node_modules) — same reason 34_forensics
# binds exif that way.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=screenshot

have_cmd node || { skip "$C" "no node on PATH (the screenshot engine runs under system node)"; exit 0; }
# playwright resolvable + Chromium payload present?
if ! (cd "$PWD/examples/providers/screenshot" && node -e '
  const { existsSync } = await import("node:fs");
  const { chromium } = await import("playwright");
  const p = chromium.executablePath();
  if (!p || !existsSync(p)) throw new Error("no chromium payload");
' >/dev/null 2>&1); then
  skip "$C" "playwright/Chromium not installed (npm install --include=optional && npx playwright install chromium)"
  exit 0
fi

CASE=$(case_dir screenshot)
SHOT_SH="$PWD/examples/providers/screenshot/screenshot.sh"
ocrun "$CASE" setup provider screenshot "exec:bash $SHOT_SH run --input {{input}} --json" >/dev/null 2>&1

URL="${OC_SCREENSHOT_URL:-https://example.com}"

# --- 1) render a real URL → a ready web.screenshot PNG record ---
cond "screenshot renders a live URL to a PNG evidence record"
sout="$(OC_TIMEOUT=120 oc "$CASE" screenshot "$URL" --json | primary_rec)"
save_json "38_screenshot_url" "$sout" >/dev/null
assert_eq "$C.url.state" "ready" "$(jq -r '.state' <<<"$sout")" "screenshot ready"
ref="$(jq -r '.media.ref' <<<"$sout")"
if [ -f "$ref" ] && [ "$(wc -c <"$ref" 2>/dev/null)" -gt 1000 ]; then
  ok "$C.url.png" "rendered $(wc -c <"$ref" | tr -d ' ') byte PNG; title=$(jq -r '.payload.title // "?"' <<<"$sout" | cut -c1-40)"
else
  fail "$C.url.png" "no non-trivial PNG at $ref"
fi

# --- 2) --full-page renders (usually taller than the viewport shot) ---
cond "screenshot --full-page captures the whole scrollable page"
fout="$(OC_TIMEOUT=120 oc "$CASE" screenshot "$URL" --full-page --json | primary_rec)"
assert_eq "$C.full.state" "ready" "$(jq -r '.state' <<<"$fout")" "full-page ready"
assert_eq "$C.full.flag" "true" "$(jq -r '.payload.full_page' <<<"$fout")" "payload marks full_page"

# --- 3) render a LOCAL .html export to an image (the wall/map/brief use case) ---
html="$SMOKE_DIR/38_local.html"
printf '%s\n' '<!doctype html><meta charset="utf-8"><title>Local Export</title><h1>overcast local render</h1><p>evidence</p>' >"$html"
cond "screenshot renders a local .html file to a PNG"
lout="$(OC_TIMEOUT=120 oc "$CASE" screenshot "$html" --json | primary_rec)"
save_json "38_screenshot_local" "$lout" >/dev/null
lref="$(jq -r '.media.ref' <<<"$lout")"
if [ "$(jq -r '.state' <<<"$lout")" = "ready" ] && [ -f "$lref" ]; then
  ok "$C.local.png" "local HTML rendered to $(basename "$lref")"
else
  fail "$C.local.png" "local .html did not render (state=$(jq -r '.state' <<<"$lout"))"
fi

# --- 4) SSRF: a private/loopback target is refused by default ---
cond "screenshot refuses a private/loopback target (SSRF guard)"
bout="$(OC_TIMEOUT=60 oc "$CASE" screenshot "http://127.0.0.1:1/" --json | primary_rec)"
save_json "38_screenshot_ssrf" "$bout" >/dev/null
bstate="$(jq -r '.state' <<<"$bout")"
if [ "$bstate" = "error" ]; then
  ok "$C.ssrf.blocked" "loopback refused → error (private-fetch guard on)"
else
  fail "$C.ssrf.blocked" "expected error for 127.0.0.1, got state=$bstate"
fi

# --- 5) browser: source — scan --pull renders + captures a page image ---
cond "browser source scan --pull renders the page into an image capture"
SCASE=$(case_dir browser_src)
export OVERCAST_SOURCE_BROWSER_CMD="bash $PWD/examples/providers/sources/browser.sh"
ocrun "$SCASE" source add "browser:$URL" >/dev/null 2>&1
scan="$(OC_TIMEOUT=150 ocrun "$SCASE" scan --pull --json 2>/dev/null)"
save_json "38_browser_scan" "$scan" >/dev/null
ncap="$(jq -s '[.[]|select(.verb=="capture" and .payload.kind=="image")]|length' <<<"$scan" 2>/dev/null)"
[ "${ncap:-0}" -ge 1 ] && ok "$C.source.capture" "browser scan --pull captured a rendered image" || fail "$C.source.capture" "no image capture from browser source"

# --- 6) doctor --sources reports the browser renderer ---
cond "doctor --sources reports the browser renderer check"
dout="$(ocrun "$SCASE" doctor --sources --json 2>/dev/null | jq -s '.')"
dbrowser="$(jq -r '.[] | .. | objects | select(.name? == "source:browser") | .ok' <<<"$dout" 2>/dev/null | head -1)"
[ -n "$dbrowser" ] && ok "$C.doctor.browser" "doctor surfaces source:browser (ok=$dbrowser)" || skip "$C.doctor.browser" "doctor --sources json shape lacks source:browser (non-fatal)"
