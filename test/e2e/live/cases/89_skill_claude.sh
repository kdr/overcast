#!/usr/bin/env bash
# AGENTIC (ANOTHER HARNESS): load a vended overcast skill into the real `claude`
# CLI headless and let Claude drive the overcast CLI to execute it — "loading the
# skill within another agent like claude". Claude reads the SKILL.md, then uses its
# Bash tool to run the overcast binary; we assert on the PERSISTED overcast records
# (the deterministic proof), not on Claude's prose.
#
# OPT-IN ONLY: gated behind OC_E2E_CLAUDE=1 AND a `claude` on PATH, because it
# spends Claude credit, uses the machine's Claude auth, and runs Bash headless
# (--permission-mode bypassPermissions). Skips cleanly by default.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=skill_claude

[ "${OC_E2E_CLAUDE:-}" = "1" ] || { skip "$C" "set OC_E2E_CLAUDE=1 to drive the real claude CLI (opt-in: spends credit, headless Bash)"; exit 0; }
have_cmd claude || { skip "$C" "no 'claude' CLI on PATH"; exit 0; }

CLIP="$SMOKE_DIR/claude_enhance.mp4"
SRC="$VIDEO_SMALL"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" && clip_av 8 "$SRC" "$CLIP"
SKILL="$PWD/skills/overcast-enhance-and-resolve/SKILL.md"
[ -f "$CLIP" ] && [ -f "$SKILL" ] || { skip "$C" "no clip or skill file"; exit 0; }

CASE=$(case_dir skill_claude); mkdir -p "$CASE/.ochome"

# Claude gets the skill for context + the exact overcast invocation (overcast is not
# on PATH in this repo, so we hand Claude the launcher + the required --case/--home).
prompt="You have the following Overcast agent skill installed:

$(cat "$SKILL")

The overcast CLI is invoked in this environment as:
  $OVERCAST --case $CASE --home $CASE/.ochome <verb> ...

Follow the skill for this BOUNDED task only: enhance the clip at $CLIP using the
skill's enhance step with ops denoise,upscale (run the overcast enhance tool via
your Bash tool). Do not watch, crop, or brief. When done, print the enhanced output
path on one line as 'ENHANCED: <path>'."

cond "the claude CLI loads the enhance-and-resolve skill and drives overcast headless"
out="$(perl -e 'alarm shift; exec @ARGV or exit 127' "${OC_TIMEOUT:-360}" \
  claude -p "$prompt" --allowedTools "Bash" --permission-mode bypassPermissions --output-format json 2>&1)"
save_json "89_claude_result" "$out" >/dev/null
assert_nonempty "$C.result" "$out" "claude headless produced output"

# deterministic proof: overcast persisted a ready enhance record in the case store
recs="$(cat "$CASE/.overcast/records/enhance.jsonl" 2>/dev/null | jq -s '[.[]|select(.verb=="enhance" and .state=="ready")]|length' 2>/dev/null)"
if [ "${recs:-0}" -ge 1 ]; then
  ok "$C.persisted" "claude drove overcast to persist $recs ready enhance record(s)"
else
  fail "$C.persisted" "no ready enhance record persisted by the claude-driven run"
fi
# and the enhanced media actually exists on disk
enhref="$(cat "$CASE/.overcast/records/enhance.jsonl" 2>/dev/null | jq -sr '[.[]|select(.state=="ready")][0].media.ref // empty' 2>/dev/null)"
if [ -n "$enhref" ] && [ -f "$enhref" ]; then
  ok "$C.media" "enhanced media written by the claude-driven skill run ($(basename "$enhref"))"
else
  skip "$C.media" "no enhanced media ref recovered (claude may have phrased the run differently)"
fi
