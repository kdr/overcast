#!/usr/bin/env bash
# Real OSINT sources: web search (Tavily), tiktok (Apify), lens reverse image
# search (Apify), youtube (yt-dlp).
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
