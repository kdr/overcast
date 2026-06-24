#!/usr/bin/env bash
# Build a few overcast profiles that combine the example providers, for testing
# different backend combinations. Writes to $OVERCAST_HOME (default ~/.overcast).
#   bash examples/profiles/install-profiles.sh [--home <dir>]
# Then:  overcast <verb> ... --profile <name>   (or `overcast setup use <name>`)
#
# Keys (in .env or your shell): CLOUDGLUE_API_KEY, FAL_KEY, ELEVENLABS_API_KEY, HF_TOKEN.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OC="node $REPO/dist/bin/overcast.js"
P="$REPO/examples/providers"
HOME_ARG=()
[ "${1:-}" = "--home" ] && HOME_ARG=(--home "$2")

bind() { # <profile> <verb> <script-relpath> [interpreter=bash]
  local interp="${4:-bash}"   # .py scripts must run under python3, not bash
  $OC setup provider "$2" "exec:$interp $P/$3 {{input}}" --profile "$1" "${HOME_ARG[@]}" >/dev/null
  echo "  $1: $2 -> $interp $3"
}

echo "Building profiles in ${2:-~/.overcast}:"

# 1. cloudglue — the baseline (tinycloud watch/listen, ffmpeg enhance, see placeholder).
$OC setup llm cloudglue tinycloud:advanced --profile cloudglue "${HOME_ARG[@]}" >/dev/null
echo "  cloudglue: defaults (watch/listen=tinycloud, enhance=ffmpeg, see=placeholder)"

# 2. fal — fal.ai everything pluggable.
bind fal see     fal/see.sh
bind fal enhance fal/enhance.sh        # image=esrgan, audio=deepfilternet3

# 3. elevenlabs — speech-focused.
bind elevenlabs listen  elevenlabs/listen.sh    # Scribe STT
bind elevenlabs enhance elevenlabs/enhance.sh   # voice isolator (audio)

# 4. hf — Hugging Face.
bind hf see     hf/see.sh              # gemma vision-LLM caption
bind hf enhance hf/enhance.py python3  # image upscale via fal-routed HF token (Python)

# 5. recon — best-of-breed mix for an OSINT case.
$OC setup llm cloudglue tinycloud:advanced --profile recon "${HOME_ARG[@]}" >/dev/null
bind recon listen  elevenlabs/listen.sh   # crisp word-timed transcript
bind recon see     fal/see.sh             # florence-2 caption + OCR
bind recon enhance fal/enhance.sh         # esrgan (faithful) + deepfilternet3
echo "  recon: watch=tinycloud · listen=elevenlabs · see=fal · enhance=fal"

echo
echo "Done. Try:  overcast see ./img.jpg --json --profile fal"
echo "            overcast listen ./clip.mp4 --describe --json --profile cloudglue"
echo "            overcast --profile recon   (or: overcast setup use recon)"
