#!/usr/bin/env bash
# Real OSINT sources: web search (Tavily), tiktok (Apify), youtube (yt-dlp).
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

# --- web (Tavily) ---
if require_cred "$C.web" TAVILY_API_KEY "skipping web search"; then
  CASE=$(case_dir src_web)
  export OVERCAST_SOURCE_WEB_CMD="bash $SRCDIR/web.sh"
  ocrun "$CASE" source add 'web:overcast weather app' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 oc "$CASE" scan --source web --limit 3 --json)"
  save_json "20_scan_web" "$out" >/dev/null
  assert_scan_hits "$C.web.query" "$out" "web query"
  unset OVERCAST_SOURCE_WEB_CMD
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
