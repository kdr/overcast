#!/usr/bin/env bash
# Real OSINT sources: web search (Tavily), tiktok (Apify), youtube (yt-dlp).
# Bound via OVERCAST_SOURCE_<TYPE>_CMD with absolute paths (the bun binary can't
# auto-resolve the shipped examples/).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=source
SRCDIR="$PWD/examples/providers/sources"

# --- web (Tavily) ---
if require_cred "$C.web" TAVILY_API_KEY "skipping web search"; then
  CASE=$(case_dir src_web)
  export OVERCAST_SOURCE_WEB_CMD="bash $SRCDIR/web.sh"
  ocrun "$CASE" source add 'web:overcast pi agent' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 ocrun "$CASE" scan --source web --query "open source AI agent" --limit 3 --json 2>/dev/null)"
  save_json "20_scan_web" "$out" >/dev/null
  hits="$(echo "$out" | jq -s '[.[]|select(.state!="error" and .verb=="scan")]|length' 2>/dev/null)"
  if [ "${hits:-0}" -ge 1 ]; then
    ok "$C.web.hits" "web search returned $hits hits"
    assert_nonempty "$C.web.url" "$(echo "$out"|jq -s -r '[.[]|select(.payload.url!="")][0].payload.url // empty')" "first hit has a url"
  else
    err="$(echo "$out" | jq -s -r '[.[]|select(.state=="error")][0].error // "no hits"' 2>/dev/null)"
    fail "$C.web.hits" "no web hits ($err)"
  fi
  unset OVERCAST_SOURCE_WEB_CMD
fi

# --- tiktok (Apify) — enumerate; small limit to keep cost low ---
if require_cred "$C.tiktok" APIFY_TOKEN "skipping tiktok"; then
  CASE=$(case_dir src_tiktok)
  export OVERCAST_SOURCE_TIKTOK_CMD="bash $SRCDIR/tiktok.sh"
  ocrun "$CASE" source add 'tiktok:@nasa' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=180 ocrun "$CASE" scan --source tiktok --limit 2 --json 2>/dev/null)"
  save_json "20_scan_tiktok" "$out" >/dev/null
  recs="$(echo "$out" | jq -s 'length' 2>/dev/null)"
  st="$(echo "$out" | jq -s -r '[.[]|select(.verb=="scan")][0].state // "none"' 2>/dev/null)"
  # Apify can be slow/empty; assert the scan ran and produced a record (hit or a
  # clean error), not that it found content — keep it tolerant but real.
  if [ "${recs:-0}" -ge 1 ]; then ok "$C.tiktok.ran" "tiktok scan ran ($recs record(s), first state=$st)"; else fail "$C.tiktok.ran" "no records"; fi
  unset OVERCAST_SOURCE_TIKTOK_CMD
fi

# --- youtube (yt-dlp) — gated on yt-dlp ---
if have_cmd yt-dlp; then
  CASE=$(case_dir src_youtube)
  export OVERCAST_SOURCE_YOUTUBE_CMD="bash $SRCDIR/youtube.sh"
  ocrun "$CASE" source add 'youtube:search:nasa' --json >/dev/null 2>&1
  out="$(OC_TIMEOUT=120 ocrun "$CASE" scan --source youtube --limit 2 --json 2>/dev/null)"
  save_json "20_scan_youtube" "$out" >/dev/null
  hits="$(echo "$out" | jq -s '[.[]|select(.state!="error" and .verb=="scan")]|length' 2>/dev/null)"
  [ "${hits:-0}" -ge 1 ] && ok "$C.youtube.hits" "youtube returned $hits hits" || fail "$C.youtube.hits" "no hits"
  unset OVERCAST_SOURCE_YOUTUBE_CMD
else
  skip "$C.youtube" "yt-dlp not installed"
fi
