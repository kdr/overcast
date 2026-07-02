#!/usr/bin/env bash
# Helpers for the LIVE (real-data) e2e suite. Sourced by live/cases/*.sh on top
# of the shared test/e2e/lib.sh (ok/fail/assert_eq/assert_nonempty/save_json/...).
#
# Exported by live/run.sh:
#   OVERCAST     the CLI under test (the compiled bun binary by default)
#   SMOKE_DIR    this run's output dir
#   FFMPEG       the system ffmpeg (for prepping short real clips)
#   plus every provider key + media path from .env (OC_VIDEO_*/OC_IMAGE/OC_AUDIO,
#   CLOUDGLUE_API_KEY, HF_TOKEN, FAL_KEY, …)

LIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
source "$(cd "$LIVE_DIR/.." && pwd)/lib.sh"

# --- gating ------------------------------------------------------------------
have_cred() { [ -n "${!1:-}" ]; }       # have_cred CLOUDGLUE_API_KEY
have_cmd()  { command -v "$1" >/dev/null 2>&1; }

# skip <case> <note> — record a PASS-as-skip so a missing key/tool doesn't fail.
skip() { ok "$1" "SKIPPED — $2"; }

# require_cred <case> <ENVVAR> <note>  -> returns 1 (and skips) if missing
require_cred() { if have_cred "$2"; then return 0; else skip "$1" "no $2 — $3"; return 1; fi; }

# --- real media --------------------------------------------------------------
# Every medium is a FULL PATH supplied via .env (OC_VIDEO_*/OC_IMAGE/OC_AUDIO); no
# file names are baked in here. Cases assert presence (have_media) and SKIP when a
# medium is unset/missing, so any subset works. They're consumed by the case
# scripts that source this lib, so the SC2034 "appears unused" below is a false
# positive (disabled per-line).
# shellcheck disable=SC2034
VIDEO_VISUAL="${OC_VIDEO_VISUAL:-}"      # rich on-screen visual — watch / see
# shellcheck disable=SC2034
VIDEO_OBJECTS="${OC_VIDEO_OBJECTS:-}"    # people + detectable objects — see --detect
# shellcheck disable=SC2034
VIDEO_SMALL="${OC_VIDEO_SMALL:-}"        # short / small — enhance / view
# shellcheck disable=SC2034
VIDEO_SPEECH_SRC="${OC_VIDEO_SPEECH:-}"  # clear speech — listen (audio fallback)
# shellcheck disable=SC2034
IMAGE_FILE="${OC_IMAGE:-}"               # standalone image — see (caption / OCR / detect)
# shellcheck disable=SC2034
AUDIO_FILE="${OC_AUDIO:-}"               # standalone audio — listen
# shellcheck disable=SC2034
LOCAL_FACE_VIDEO="${OC_LOCAL_FACE_VIDEO:-}"     # local face DB: video to search
# shellcheck disable=SC2034
LOCAL_FACE_IMAGE="${OC_LOCAL_FACE_IMAGE:-}"     # local face DB: reference face image
# shellcheck disable=SC2034
LOCAL_IMAGE_REF="${OC_LOCAL_IMAGE_REF:-}"       # local image DB: reference logo/landmark
# shellcheck disable=SC2034
LOCAL_IMAGE_VIDEO_A="${OC_LOCAL_IMAGE_VIDEO_A:-}" # local image DB: candidate video A
# shellcheck disable=SC2034
LOCAL_IMAGE_VIDEO_B="${OC_LOCAL_IMAGE_VIDEO_B:-}" # local image DB: candidate video B
# shellcheck disable=SC2034
CLIP_IMAGE_REF="${OC_CLIP_IMAGE_REF:-}"          # basic-clip DB: image to embed + image-query
# shellcheck disable=SC2034
CLIP_VIDEO="${OC_CLIP_VIDEO:-}"                  # basic-clip DB: video to embed (frames)
# shellcheck disable=SC2034
CLIP_TEXT="${OC_CLIP_TEXT:-a person}"            # basic-clip DB: text query for `similar search`

have_media() { [ -f "$1" ]; }

# clip_av <seconds> <src> <dst>  — extract the first N seconds (re-encode small so
# any cloud backend accepts it). Cached: skip if dst already exists.
clip_av() {
  local n="$1" src="$2" dst="$3"
  [ -f "$dst" ] && return 0
  "$FFMPEG" -y -ss 0 -t "$n" -i "$src" -vf "scale='min(640,iw)':-2" \
    -c:v libx264 -preset veryfast -c:a aac -movflags +faststart "$dst" >/dev/null 2>&1
}

# frame_jpg <src-video> <second> <dst>  — extract one real frame for `see`.
frame_jpg() {
  local src="$1" sec="$2" dst="$3"
  [ -f "$dst" ] && return 0
  "$FFMPEG" -y -ss "$sec" -i "$src" -frames:v 1 -q:v 2 "$dst" >/dev/null 2>&1
}

# a fresh per-case case dir under SMOKE_DIR
case_dir() { local d="$SMOKE_DIR/case_$1"; mkdir -p "$d"; echo "$d"; }

# run the CLI inside a case dir under a SIGALRM timeout (default 300s; override
# with OC_TIMEOUT=<secs>). Profiles live in a PER-CASE-DIR home so cases don't
# contaminate each other's bindings, and we never touch ~/.overcast.
#   ocrun <casedir> <args...>
# Note: $OVERCAST is intentionally UNquoted so "node /path" splits into argv;
# perl's exec runs the real binary. A shell function can't be exec'd — wrapping
# ocrun in the old oc_timeout was the 127 bug; the timeout is built in here.
ocrun() {
  local cd="$1"; shift
  perl -e 'alarm shift; exec @ARGV or exit 127' "${OC_TIMEOUT:-300}" \
    $OVERCAST --case "$cd" --home "$cd/.ochome" "$@"
}

# --- optional rich reporting -------------------------------------------------
# Each report section captures: the CONDITION under test, the exact COMMAND run,
# and a SNIPPET of its output. Authoring pattern in a case:
#
#   cond "watch returns a ready video.analysis record"
#   out="$(oc "$CASE" watch "$CLIP" --json)"      # captures command + output
#   assert_eq "$C.state" "ready" "$(jq -r .state <<<"$out")" "state is ready"
#
# `oc`/`ocg` stash the command+output (files survive the $(...) subshell); the
# ok/fail overrides below emit the markdown block, grouping multiple assertions
# under the one command/output they share.
DETAIL_MD="$SMOKE_DIR/detail.md"

detail_enabled() {
  case "${LIVE_E2E_VERBOSE:-${E2E_VERBOSE:-0}}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac
}

# set the condition under test (and clear any stale captured command/output so a
# pure assertion that follows doesn't show a previous command's snippet)
cond() { _COND="$1"; rm -f "$SMOKE_DIR/.cmd" "$SMOKE_DIR/.out"; }
oc_capture() { printf '%s' "$1" >"$SMOKE_DIR/.cmd"; printf '%s' "$2" >"$SMOKE_DIR/.out"; }

# oc <casedir> <args...> — run via the binary (in a case dir), capture cmd+output
oc() {
  local cd="$1"; shift
  local out; out="$(ocrun "$cd" "$@" 2>/dev/null)"
  oc_capture "overcast $*" "$out"
  printf '%s' "$out"
}

# ocg <args...> — run the binary directly (no case dir; for version/commands/help)
ocg() {
  local out; out="$(perl -e 'alarm shift; exec @ARGV or exit 127' "${OC_TIMEOUT:-60}" $OVERCAST "$@" 2>/dev/null)"
  oc_capture "overcast $*" "$out"
  printf '%s' "$out"
}

snippet_output() { # <output>
  local lines total head_lines tail_lines omitted
  lines="${LIVE_E2E_VERBOSE_LINES:-${E2E_VERBOSE_LINES:-16}}"
  total="$(printf '%s\n' "$1" | wc -l | tr -d ' ')"
  if [ "${total:-0}" -le "$lines" ]; then
    printf '%s\n' "$1" | cut -c1-200
    return 0
  fi
  head_lines=$((lines / 2))
  tail_lines=$((lines - head_lines))
  [ "$head_lines" -lt 1 ] && head_lines=1
  [ "$tail_lines" -lt 1 ] && tail_lines=1
  omitted=$((total - head_lines - tail_lines))
  printf '%s\n' "$1" | head -"$head_lines" | cut -c1-200
  printf '... (%s lines omitted; showing tail)\n' "$omitted"
  printf '%s\n' "$1" | tail -"$tail_lines" | cut -c1-200
}

_detail() { # <PASS|FAIL> <id> <note>
  detail_enabled || return 0
  local cmd out key
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
    } >>"$DETAIL_MD"
    printf '%s' "$key" >"$SMOKE_DIR/.reportedkey"
  fi
  printf -- '- **%s** — %s\n' "$1" "$2 — $3" >>"$DETAIL_MD"
}

# override base ok/fail to ALSO emit the detailed report block
ok() {   pass_count=$((pass_count + 1)); printf '  \033[32mPASS\033[0m %s — %s\n' "$1" "$2"; _record "$1" pass "$2"; _detail PASS "$1" "$2"; }
fail() { fail_count=$((fail_count + 1)); printf '  \033[31mFAIL\033[0m %s — %s\n' "$1" "$2"; _record "$1" fail "$2"; _detail FAIL "$1" "$2"; }
