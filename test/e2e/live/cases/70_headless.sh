#!/usr/bin/env bash
# Headless agent mode — drive the pi agent NON-interactively and verify outputs:
#   overcast --mode json "<prompt>"   → JSONL event stream
#   overcast -p "<prompt>"            → plain-text result
# Needs a brain LLM (turnkey Cloudglue via CLOUDGLUE_API_KEY).
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=headless
require_cred "$C" CLOUDGLUE_API_KEY "headless agent needs a brain LLM" || exit 0
CASE=$(case_dir headless)

# 1) JSON event stream is well-formed and carries the agent's reply
cond "overcast --mode json <prompt> emits a valid JSONL event stream containing the reply"
out="$(OC_TIMEOUT=180 oc "$CASE" --mode json "Reply with exactly one word: PONG")"
assert_nonempty "$C.json.nonempty" "$out" "headless json produced output"
invalid=0; nlines=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  nlines=$((nlines + 1))
  printf '%s' "$line" | jq -e . >/dev/null 2>&1 || invalid=$((invalid + 1))
done <<<"$out"
assert_eq "$C.json.valid" "0" "$invalid" "every one of $nlines event lines is valid JSON"
if printf '%s' "$out" | grep -qi "PONG"; then ok "$C.json.reply" "event stream carries the agent's reply (PONG)"; else fail "$C.json.reply" "no PONG in the stream"; fi

# 2) text mode (-p) runs headless, exercises a tool, and reports back
cond "overcast -p <prompt> runs headless, invokes the doctor tool, and reports ffmpeg status"
out="$(OC_TIMEOUT=180 oc "$CASE" -p "Run a doctor preflight and state in one line whether ffmpeg is available.")"
assert_nonempty "$C.text.nonempty" "$out" "headless text response non-empty"
if printf '%s' "$out" | grep -qiE "ffmpeg|ffprobe|available|ready|preflight"; then
  ok "$C.text.tool" "response reflects the doctor/ffmpeg check"
else
  fail "$C.text.tool" "no doctor/ffmpeg signal: $(printf '%s' "$out" | tr '\n' ' ' | head -c 100)"
fi

# 3) headless watch via the agent: ask it to analyze a real clip, expect a record id
cond "the agent, headless, watches a real clip and persists a citable record"
CLIP="$SMOKE_DIR/headless_clip.mp4"
have_media "$VIDEO_VISUAL" && clip_av 10 "$VIDEO_VISUAL" "$CLIP"
if [ -f "$CLIP" ]; then
  out="$(OC_TIMEOUT=300 oc "$CASE" -p "Watch the video at $CLIP and tell me its title in one line.")"
  # the deterministic proof the agent invoked the verb is a persisted record; the
  # free-text -p summary is agent-dependent (may be empty), so it's informational.
  recs="$(ocrun "$CASE" case records --verb watch --json 2>/dev/null | jq -r '.payload.count // 0')"
  if [ "${recs:-0}" -ge 1 ]; then ok "$C.watch.persisted" "agent's watch persisted $recs record(s) to the case"; else fail "$C.watch.persisted" "no watch record persisted"; fi
  if [ -n "$out" ]; then ok "$C.watch.reply" "agent also returned a text summary (${#out} chars)"; else ok "$C.watch.reply" "no text summary this run (agent-dependent); the persisted record is the proof"; fi
else
  skip "$C.watch" "no clip"
fi
