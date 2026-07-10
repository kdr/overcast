#!/usr/bin/env bash
# Fixture screenshot engine (exec): stands in for the Playwright render engine so
# the `screenshot` verb + `browser` source can be exercised offline (no node/
# playwright/chromium). Writes a tiny valid PNG and emits the same JSON shapes
# the real engine does.
#   run   --input <url|path> [flags]   -> a full screenshot record (verb path)
#   fetch --url <u> --out <p>          -> {kind:image,...} capture (source path)
#   enumerate --query <url>            -> one recapture:true browser hit
#   init | describe                    -> exec-contract handshakes
# Set OVERCAST_FAKE_SHOT_FAIL13=1 to simulate a missing renderer (exit 13).
set -uo pipefail

# a 1x1 transparent PNG (67 bytes) — enough to pass the >0-byte + magic-byte gate
write_png() {
  printf '%b' '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' >"$1"
}

if [ "${OVERCAST_FAKE_SHOT_FAIL13:-0}" = "1" ]; then
  echo "fake screenshot: renderer missing (simulated)" >&2
  exit 13
fi

op="${1:-run}"; shift || true
case "$op" in
  init) exit 0 ;;
  describe)
    echo '{"verb":"screenshot","kind":"web.screenshot","needs":["node","playwright","chromium"]}'; exit 0 ;;
  run)
    input=""; full=false
    while [ "$#" -gt 0 ]; do case "$1" in
      --input) input="${2:-}"; shift 2 2>/dev/null || shift ;;
      --full-page) full=true; shift ;;
      --viewport|--wait) shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    out="${OVERCAST_MEDIA_DIR:-.}/fake-shot.png"
    write_png "$out"
    jq -nc --arg u "$input" --arg p "$out" --argjson full "$full" \
      '{verb:"screenshot",format:"json",
        payload:{summary:("fixture page — "+$u),url:$u,title:"Fixture Page",kind:"image",source:"browser",full_page:$full,viewport:"1280x800"},
        media:{ref:$p},meta:{provider:"playwright"},state:"ready"}'
    ;;
  fetch)
    url=""; out=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --url) url="${2:-}"; shift 2 2>/dev/null || shift ;;
      --out) out="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$out" ] || { echo "fake screenshot fetch needs --out" >&2; exit 1; }
    write_png "$out"
    jq -nc --arg p "$out" --arg u "$url" '{kind:"image",path:$p,source:"browser",url:$u,title:"Fixture Page"}'
    ;;
  enumerate)
    query=""
    while [ "$#" -gt 0 ]; do case "$1" in
      --query) query="${2:-}"; shift 2 2>/dev/null || shift ;;
      *) shift ;;
    esac; done
    [ -n "$query" ] || { echo "fake screenshot enumerate needs --query" >&2; exit 1; }
    jq -nc --arg u "$query" \
      '[{title:$u,url:$u,source:"browser",recapture:true,snapshot_at:0,snippet:"fixture page",media:{ref:$u}}]'
    ;;
  *) echo "{}" ;;
esac
