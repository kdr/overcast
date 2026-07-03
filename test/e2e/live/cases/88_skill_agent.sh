#!/usr/bin/env bash
# AGENTIC HEADLESS: a real pi agent (overcast --mode json) LOADS a vended skill and
# executes a bounded slice of it against real media. This is "agentic headless mode
# using overcast": the SKILL.md is pasted into the prompt, the agent decides which
# overcast tools to call, and we assert on the PERSISTED records + the JSONL tool
# trace (never on the non-deterministic prose). Mirrors 26_x_copycat step 5.
#
# Needs a brain LLM (CLOUDGLUE_API_KEY). Each skill leg gates on its own media/deps.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_agent
require_cred "$C" CLOUDGLUE_API_KEY "headless agent needs a brain LLM" || exit 0

# assert_agent_ran <id> <trace> <verb> <label> — trace is valid JSONL, invoked the
# expected tool, and persisted a ready record of that verb.
assert_agent_ran() {
  local id="$1" trace="$2" verb="$3" label="$4" invalid=0 nlines=0 line
  while IFS= read -r line; do
    [ -z "$line" ] && continue; nlines=$((nlines + 1))
    printf '%s' "$line" | jq -e . >/dev/null 2>&1 || invalid=$((invalid + 1))
  done <<<"$trace"
  assert_eq "$id.jsonl" "0" "$invalid" "$label trace is valid JSONL ($nlines lines)"
  local tools; tools="$(jq -sr '[.[]|select(.type=="agent_end")|.messages[]?|select(.role=="assistant")|.content[]?|select(.type=="toolCall")|.name]|join(",")' <<<"$trace" 2>/dev/null)"
  if printf '%s' "$tools" | grep -q "$verb"; then ok "$id.tool" "$label agent invoked the $verb tool"; else fail "$id.tool" "$label: $verb not in tool calls: ${tools:-<none>}"; fi
}

# --- leg 1: enhance-and-resolve (fully local: ffmpeg enhance + see re-read) -------
cond "agent loads the enhance-and-resolve skill and enhances a real clip headless"
CLIP="$SMOKE_DIR/agent_enhance.mp4"
SRC="$VIDEO_SMALL"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" && clip_av 8 "$SRC" "$CLIP"
SKILL="$PWD/skills/overcast-enhance-and-resolve/SKILL.md"
if [ -f "$CLIP" ] && [ -f "$SKILL" ]; then
  CASE=$(case_dir agent_enhance)
  prompt="You have the following Overcast agent skill available:

$(cat "$SKILL")

Invoke the skill above for this BOUNDED task only: run the overcast enhance tool on the clip at $CLIP with ops denoise,upscale, then STOP. Do not watch, crop, or brief. Reply in one line: 'ENHANCED: <output path>'."
  trace="$(OC_TIMEOUT=420 oc "$CASE" --mode json "$prompt")"
  save_json "88_enhance_trace" "$trace" >/dev/null
  assert_nonempty "$C.enhance.trace" "$trace" "enhance-skill JSONL trace captured"
  assert_agent_ran "$C.enhance" "$trace" "enhance" "enhance-and-resolve"
  recs="$(cat "$CASE/.overcast/records/enhance.jsonl" 2>/dev/null | jq -s '[.[]|select(.state=="ready")]|length')"
  if [ "${recs:-0}" -ge 1 ]; then ok "$C.enhance.persisted" "agent persisted $recs ready enhance record(s)"; else fail "$C.enhance.persisted" "no ready enhance record persisted"; fi
else
  skip "$C.enhance" "no clip or skill file"
fi

# --- leg 2: wiretap (listen --diarize on a real recording) ------------------------
cond "agent loads the wiretap skill and diarizes a real recording headless"
if have_media "$AUDIO_FILE"; then REC="$AUDIO_FILE"; elif have_media "$VIDEO_SPEECH_SRC"; then REC="$SMOKE_DIR/agent_speech.mp4"; clip_av 12 "$VIDEO_SPEECH_SRC" "$REC"; fi
SKILL="$PWD/skills/overcast-wiretap/SKILL.md"
if [ -n "${REC:-}" ] && [ -f "$REC" ] && [ -f "$SKILL" ]; then
  CASE=$(case_dir agent_wiretap)
  prompt="You have the following Overcast agent skill available:

$(cat "$SKILL")

Invoke the skill above for this BOUNDED task only: run the overcast listen tool on the recording at $REC with --diarize to separate the speakers, then STOP. Do not enhance or brief. Reply in one line: 'SPEAKERS: <n>'."
  trace="$(OC_TIMEOUT=420 oc "$CASE" --mode json "$prompt")"
  save_json "88_wiretap_trace" "$trace" >/dev/null
  assert_nonempty "$C.wiretap.trace" "$trace" "wiretap-skill JSONL trace captured"
  assert_agent_ran "$C.wiretap" "$trace" "listen" "wiretap"
  recs="$(cat "$CASE/.overcast/records/listen.jsonl" 2>/dev/null | jq -s '[.[]|select(.state=="ready")]|length')"
  if [ "${recs:-0}" -ge 1 ]; then ok "$C.wiretap.persisted" "agent persisted $recs ready listen record(s)"; else fail "$C.wiretap.persisted" "no ready listen record persisted"; fi
else
  skip "$C.wiretap" "no recording or skill file"
fi
