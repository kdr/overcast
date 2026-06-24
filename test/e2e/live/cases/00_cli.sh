#!/usr/bin/env bash
# CLI surface against the real binary: version, commands, help (incl. env-var
# docs the providers rely on), per-verb help, error handling, doctor with creds.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=cli

# version + pinned pi
ver="$($OVERCAST version --json 2>/dev/null)"
assert_eq "$C.version" "0.80.1" "$(echo "$ver" | jq -r '.pi')" "pi pinned"
assert_nonempty "$C.binary_runs" "$(echo "$ver" | jq -r '.overcast')" "binary reports version"

# registry
n="$($OVERCAST commands --json 2>/dev/null | jq '.verbs|length')"
assert_eq "$C.commands" "18" "$n" "18 verbs in the registry"

# top-level help documents the provider env vars (the focus of the docs pass)
help="$($OVERCAST --help 2>/dev/null)"
for kv in CLOUDGLUE_API_KEY HF_TOKEN FAL_KEY ELEVENLABS_API_KEY TAVILY_API_KEY BRAVE_API_KEY APIFY_TOKEN; do
  if printf '%s' "$help" | grep -q "$kv"; then ok "$C.help_$kv" "documented in --help"; else fail "$C.help_$kv" "missing from --help"; fi
done

# per-verb help
if $OVERCAST see --help 2>/dev/null | grep -q -- "--detect"; then ok "$C.see_help" "see --help lists --detect"; else fail "$C.see_help" "no --detect in see help"; fi
if $OVERCAST monitor --help 2>/dev/null | grep -q -- "--every"; then ok "$C.monitor_help" "monitor --help lists --every"; else fail "$C.monitor_help" "no --every"; fi

# error handling: unknown command is non-zero (not a silent TUI launch)
$OVERCAST notacommandxyz >/dev/null 2>&1; rc=$?
assert_eq "$C.unknown_rc" "1" "$rc" "unknown command exits 1"

# --help wins even with --tui
if $OVERCAST --tui --help 2>/dev/null | grep -qi "senses"; then ok "$C.help_over_tui" "--tui --help shows overcast help"; else fail "$C.help_over_tui" "--tui swallowed --help"; fi

# doctor with real creds
doc="$($OVERCAST doctor --json 2>/dev/null)"
assert_eq "$C.doctor_ffmpeg" "true" "$(echo "$doc" | jq -r '.payload.checks[]|select(.name=="ffmpeg")|.ok')" "vendored ffmpeg runs (in the binary)"
assert_eq "$C.doctor_ffprobe" "true" "$(echo "$doc" | jq -r '.payload.checks[]|select(.name=="ffprobe")|.ok')" "vendored ffprobe runs"
if have_cred CLOUDGLUE_API_KEY; then
  assert_eq "$C.doctor_cloudglue" "true" "$(echo "$doc" | jq -r '.payload.checks[]|select(.name=="cloudglue")|.ok')" "Cloudglue creds present"
fi
save_json "00_doctor" "$doc" >/dev/null
