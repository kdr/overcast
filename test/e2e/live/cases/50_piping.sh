#!/usr/bin/env bash
# Common workflows: piping the JSON record surface through jq, and chaining
# a capture-id into a sense — the agent/shell ergonomics.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=pipe
CASE=$(case_dir piping)

# commands --json | jq → list verb names
names="$($OVERCAST commands --json 2>/dev/null | jq -r '.verbs[].name' | tr '\n' ' ')"
for v in watch scan ask brief monitor see; do
  case " $names " in *" $v "*) ok "$C.has_$v" "verb $v in the piped registry";; *) fail "$C.has_$v" "missing $v";; esac
done

# --format md | grep → human-readable surface for a non-JSON record (case info)
ocrun "$CASE" case init --name pipecase --json >/dev/null 2>&1
info_md="$(ocrun "$CASE" case info --format md 2>/dev/null)"
[ -n "$info_md" ] && ok "$C.format_md" "case info --format md produces text" || fail "$C.format_md" "md empty"

# chain: capture a real local clip → take its media.ref → watch it (if Cloudglue)
CLIP="$SMOKE_DIR/pipe50.mp4"
SRC="$VIDEO_SMALL"; have_media "$SRC" || SRC="$VIDEO_VISUAL"
have_media "$SRC" && clip_av 8 "$SRC" "$CLIP"
if [ -f "$CLIP" ]; then
  ref="$(ocrun "$CASE" capture "$CLIP" --json 2>/dev/null | jq -r '.media.ref')"
  assert_nonempty "$C.capture_ref" "$ref" "capture emits a media.ref to chain"
  if require_cred "$C.chain_watch" CLOUDGLUE_API_KEY "skipping chained watch"; then
    w="$(OC_TIMEOUT=300 ocrun "$CASE" watch "$ref" --json 2>/dev/null | jq -r '.state')"
    assert_eq "$C.chain_watch" "ready" "$w" "watch the captured ref (capture → watch chain)"
  fi
fi

# exit codes are pipe-friendly: a verb error record → non-zero exit
ocrun "$CASE" watch /no/such/file.mp4 >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ]; then ok "$C.error_exit" "a failed verb exits non-zero (scriptable)"; else fail "$C.error_exit" "expected non-zero"; fi
