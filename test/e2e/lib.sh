#!/usr/bin/env bash
# Shared helpers for the overcast e2e suite. Sourced by run.sh and case scripts.
# Cases assert on CLI-observable behavior (--json parsed with jq) and on
# overcast's own headless agent JSON. Results accumulate into $SMOKE_DIR.

# --- env contract (exported by run.sh) ---------------------------------------
#   OVERCAST       absolute path to the built CLI launcher (node dist/bin/...)
#   SMOKE_DIR      this run's ./.dev/smoke/<UTC>/ folder (raw JSON + report.md)
#   TEST_MEDIA     dir holding smoke clips (default ~/Downloads/test-videos)
#   RESULTS_TSV    append-only "<case>\t<pass|fail>\t<note>" ledger
#   DETAIL_MD      optional verbose markdown detail ledger

pass_count=0
fail_count=0

_record() { # <case> <pass|fail> <note>
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$RESULTS_TSV"
}

detail_enabled() {
  case "${E2E_VERBOSE:-0}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac
}

cond() { _COND="$1"; rm -f "$SMOKE_DIR/.cmd" "$SMOKE_DIR/.out"; }

capture_cmd() { # <display-cmd> <output>
  printf '%s' "$1" >"$SMOKE_DIR/.cmd"
  printf '%s' "$2" >"$SMOKE_DIR/.out"
}

snippet_output() { # <output>
  local lines total head_lines tail_lines omitted
  lines="${E2E_VERBOSE_LINES:-16}"
  total="$(printf '%s\n' "$1" | wc -l | tr -d ' ')"
  if [ "${total:-0}" -le "$lines" ]; then
    printf '%s\n' "$1" | cut -c1-240
    return 0
  fi
  head_lines=$((lines / 2))
  tail_lines=$((lines - head_lines))
  [ "$head_lines" -lt 1 ] && head_lines=1
  [ "$tail_lines" -lt 1 ] && tail_lines=1
  omitted=$((total - head_lines - tail_lines))
  printf '%s\n' "$1" | head -"$head_lines" | cut -c1-240
  printf '... (%s lines omitted; showing tail)\n' "$omitted"
  printf '%s\n' "$1" | tail -"$tail_lines" | cut -c1-240
}

_detail() { # <PASS|FAIL> <id> <note>
  detail_enabled || return 0
  local detail cmd out key
  detail="${DETAIL_MD:-$SMOKE_DIR/detail.md}"
  cmd="$(cat "$SMOKE_DIR/.cmd" 2>/dev/null)"
  out="$(cat "$SMOKE_DIR/.out" 2>/dev/null)"
  key="${cmd}|${_COND:-$3}"
  if [ "$key" != "$(cat "$SMOKE_DIR/.reportedkey" 2>/dev/null)" ]; then
    {
      printf '\n##### %s\n\n' "${_COND:-$3}"
      if [ -n "$cmd" ]; then
        printf '```console\n$ %s\n' "$cmd"
        snippet_output "$out"
        printf '```\n\n'
      fi
    } >>"$detail"
    printf '%s' "$key" >"$SMOKE_DIR/.reportedkey"
  fi
  printf -- '- **%s** — %s: %s\n' "$1" "$2" "$3" >>"$detail"
}

ok() { # <case> <note>
  pass_count=$((pass_count + 1))
  printf '  \033[32mPASS\033[0m %s — %s\n' "$1" "$2"
  _record "$1" pass "$2"
  _detail PASS "$1" "$2"
}

fail() { # <case> <note>
  fail_count=$((fail_count + 1))
  printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "$2"
  _record "$1" fail "$2"
  _detail FAIL "$1" "$2"
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

# Portable timeout (macOS has no `timeout`): run argv, SIGALRM-kill after N secs.
# A genuinely-hung cloud call then fails the case fast instead of hanging the
# whole suite. Exits 142 (SIGALRM) on timeout.
oc_timeout() { local t="$1"; shift; perl -e 'alarm shift; exec @ARGV or exit 127' "$t" "$@"; }
