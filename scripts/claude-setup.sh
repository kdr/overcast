#!/bin/bash
# claude-setup.sh — session-start hook for cloud coding-agent environments
# (Claude Code "Setup script", Cursor Cloud startup, CI warm-up).
#
# Thin wrapper over scripts/setup-dev.sh: npm ci + build + e2e media fetch
# (only when the OC_E2E_MEDIA_URL / OC_E2E_MEDIA_SHA256 secrets are configured
# — otherwise a clean no-op) + CLI sanity check + optional-tool report.
# Idempotent; everything optional degrades to e2e SKIPs, so a missing key or
# media-hosting outage can never brick a session.
#
# Want more in the session image? Call setup-dev.sh directly with flags:
#   bash scripts/setup-dev.sh --tinycloud      # + the tinycloud CLI (Cloudglue senses)
#   bash scripts/setup-dev.sh --system-deps    # + brew/apt ffmpeg, exiftool, yt-dlp, …
#   bash scripts/setup-dev.sh --venv all       # + the uv Python venv (multi-GB torch)
#   bash scripts/setup-dev.sh --full           # all of the above
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

npm run dev:setup
