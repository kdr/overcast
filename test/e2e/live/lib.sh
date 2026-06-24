#!/usr/bin/env bash
# Helpers for the LIVE (real-data) e2e suite. Sourced by live/cases/*.sh on top
# of the shared test/e2e/lib.sh (ok/fail/assert_eq/assert_nonempty/save_json/...).
#
# Exported by live/run.sh:
#   OVERCAST     the CLI under test (the compiled bun binary by default)
#   TEST_MEDIA   ~/Downloads/test-videos (real clips)
#   SMOKE_DIR    this run's output dir
#   FFMPEG       the vendored ffmpeg (for prepping short real clips)
#   plus every provider key from .env (CLOUDGLUE_API_KEY, HF_TOKEN, FAL_KEY, …)

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
# Full small clips that exist in TEST_MEDIA (assert presence before use).
VIDEO_VISUAL="$TEST_MEDIA/browse-hackernews.mp4"     # screen-rec, rich visual, ~35s
VIDEO_OBJECTS="$TEST_MEDIA/worker_without_helmet.mp4" # people + hard hats (detection)
VIDEO_SMALL="$TEST_MEDIA/bbq.mp4"                     # small, for enhance/view
VIDEO_SPEECH_SRC="$TEST_MEDIA/bobbyleetheoasian.mp4"  # comedy clip → has speech

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
