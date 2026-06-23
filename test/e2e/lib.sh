#!/usr/bin/env bash
# Shared helpers for the overcast e2e suite. Sourced by run.sh and case scripts.
# Cases assert on CLI-observable behavior (--json parsed with jq) and on
# overcast's own headless agent JSON. Results accumulate into $SMOKE_DIR.

# --- env contract (exported by run.sh) ---------------------------------------
#   OVERCAST       absolute path to the built CLI launcher (node dist/bin/...)
#   SMOKE_DIR      this run's ./.dev/smoke/<UTC>/ folder (raw JSON + report.md)
#   TEST_MEDIA     dir holding smoke clips (default ~/Downloads/test-videos)
#   RESULTS_TSV    append-only "<case>\t<pass|fail>\t<note>" ledger

pass_count=0
fail_count=0

_record() { # <case> <pass|fail> <note>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$RESULTS_TSV"
}

ok() { # <case> <note>
  pass_count=$((pass_count + 1))
  printf '  \033[32mPASS\033[0m %s — %s\n' "$1" "$2"
  _record "$1" pass "$2"
}

fail() { # <case> <note>
  fail_count=$((fail_count + 1))
  printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "$2"
  _record "$1" fail "$2"
}

# assert_eq <case> <expected> <actual> <note>
assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1" "$4 ($3)"; else fail "$1" "$4: expected '$2' got '$3'"; fi
}

# assert_nonempty <case> <value> <note>
assert_nonempty() {
  if [ -n "$2" ] && [ "$2" != "null" ]; then ok "$1" "$3"; else fail "$1" "$3: empty/null"; fi
}

# save_json <name> <content> -> echoes the saved file path
save_json() {
  local f="$SMOKE_DIR/$1.json"
  printf '%s' "$2" >"$f"
  echo "$f"
}

# smallest smoke clip with NO audio (screen-recording / OCR)
smoke_clip() { echo "$TEST_MEDIA/browse-hackernews.mp4"; }
