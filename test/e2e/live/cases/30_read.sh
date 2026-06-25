#!/usr/bin/env bash
# Read side over REAL records: watch a real clip, then ask (cited retrieval) and
# brief (timeline + html export) over the case's local memory.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C="read"
require_cred "$C" CLOUDGLUE_API_KEY "skipping (needs a real watch to read over)" || exit 0

CLIP="$SMOKE_DIR/read_clip.mp4"
have_media "$VIDEO_VISUAL" && clip_av 12 "$VIDEO_VISUAL" "$CLIP"
[ -f "$CLIP" ] || { skip "$C" "no clip"; exit 0; }

CASE=$(case_dir read)
w="$(OC_TIMEOUT=300 oc "$CASE" watch "$CLIP" --json)"
[ "$(echo "$w"|jq -r '.state')" = "ready" ] || { fail "$C.seed" "seed watch failed"; exit 0; }
# a query term grounded in the real describe content (first salient word)
term="$(echo "$w" | jq -r '.payload.content' | tr 'A-Z' 'a-z' | grep -oE '[a-z]{5,}' | head -1)"
[ -n "$term" ] || term="video"

# ask → cited answer over local memory
a="$(oc "$CASE" ask "what is in the $term footage" --json)"
save_json "30_ask" "$a" >/dev/null
assert_eq "$C.ask.state" "ready" "$(echo "$a"|jq -r '.state')" "ask ready"
nc="$(echo "$a" | jq -r '.payload.citations|length')"
if [ "${nc:-0}" -ge 1 ]; then ok "$C.ask.cited" "ask returned $nc citation(s) to record.id"; else fail "$C.ask.cited" "no citations"; fi
assert_nonempty "$C.ask.text" "$(echo "$a"|jq -r '.payload.text')" "answer text"

# ask --format md surfaces the answer text (not JSON)
md="$(oc "$CASE" ask "summary" --format md)"
if printf '%s' "$md" | grep -q "record" || [ -n "$md" ]; then ok "$C.ask.md" "ask --format md prints text"; else fail "$C.ask.md" "md empty"; fi

# brief → timeline + html export
BHTML="$SMOKE_DIR/brief.html"
b="$(oc "$CASE" brief --export "$BHTML" --json)"
save_json "30_brief" "$b" >/dev/null
assert_eq "$C.brief.state" "ready" "$(echo "$b"|jq -r '.state')" "brief ready"
tot="$(echo "$b" | jq -r '.payload.total')"
if [ "${tot:-0}" -ge 1 ]; then ok "$C.brief.total" "brief covers $tot record(s)"; else fail "$C.brief.total" "brief empty"; fi
if [ -f "$BHTML" ] && grep -qi "<h1" "$BHTML"; then ok "$C.brief.html" "exported html report"; else fail "$C.brief.html" "no html"; fi
