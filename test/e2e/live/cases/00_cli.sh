#!/usr/bin/env bash
# CLI surface against the real binary: version, commands, help (incl. provider
# env-var docs), per-verb help, error handling, doctor with creds.
LIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; source "$LIVE/lib.sh"
C=cli

cond "the binary reports its version and the pinned pi version"
ver="$(ocg version --json)"
assert_eq "$C.version" "0.80.1" "$(echo "$ver" | jq -r '.pi')" "pi pinned at 0.80.1"
assert_nonempty "$C.binary_runs" "$(echo "$ver" | jq -r '.overcast')" "binary reports overcast version"

cond "the verb registry exposes all 18 verbs"
n="$(ocg commands --json | jq '.verbs|length')"
assert_eq "$C.commands" "18" "$n" "18 verbs in the registry"

cond "overcast --help documents every provider env var"
help="$(ocg --help)"
for kv in CLOUDGLUE_API_KEY HF_TOKEN FAL_KEY ELEVENLABS_API_KEY TAVILY_API_KEY BRAVE_API_KEY APIFY_TOKEN; do
  if printf '%s' "$help" | grep -q "$kv"; then ok "$C.help_$kv" "$kv documented in --help"; else fail "$C.help_$kv" "$kv missing from --help"; fi
done

cond "per-verb help lists the verb's flags"
if ocg see --help | grep -q -- "--detect"; then ok "$C.see_help" "see --help lists --detect"; else fail "$C.see_help" "no --detect in see help"; fi
if ocg monitor --help | grep -q -- "--every"; then ok "$C.monitor_help" "monitor --help lists --every"; else fail "$C.monitor_help" "no --every in monitor help"; fi

cond "an unknown command exits non-zero (not a silent TUI launch)"
oc_capture "overcast notacommandxyz" "(checking exit code)"
$OVERCAST notacommandxyz >/dev/null 2>&1; rc=$?   # direct: need the binary's real exit code
assert_eq "$C.unknown_rc" "1" "$rc" "unknown command exits 1"

cond "--help wins even when --tui is present"
if ocg --tui --help | grep -qi "senses"; then ok "$C.help_over_tui" "--tui --help shows overcast help"; else fail "$C.help_over_tui" "--tui swallowed --help"; fi

cond "doctor preflight passes for the vendored ffmpeg/ffprobe + Cloudglue creds"
doc="$(ocg doctor --json)"
assert_eq "$C.doctor_ffmpeg" "true" "$(echo "$doc" | jq -r '.payload.checks[]|select(.name=="ffmpeg")|.ok')" "vendored ffmpeg runs in the binary"
assert_eq "$C.doctor_ffprobe" "true" "$(echo "$doc" | jq -r '.payload.checks[]|select(.name=="ffprobe")|.ok')" "vendored ffprobe runs"
if have_cred CLOUDGLUE_API_KEY; then
  assert_eq "$C.doctor_cloudglue" "true" "$(echo "$doc" | jq -r '.payload.checks[]|select(.name=="cloudglue")|.ok')" "Cloudglue creds detected"
fi
