#!/bin/bash
# claude-setup.sh — SessionStart hook for Claude Code cloud sessions.
#
# IMPORTANT: this is NOT for the cloud environment's "Setup script" field.
# That field runs BEFORE Claude Code launches, as root, with the repo NOT as
# the working directory (a bare `npm install` there fails with
# "Could not read package.json: … open '/package.json'" and the non-zero exit
# blocks the session). Per the Claude Code web docs, the Setup script field is
# for SYSTEM tools (apt packages — snapshot-cached), e.g.:
#
#   #!/bin/bash
#   apt-get update && apt-get install -y ffmpeg libimage-exiftool-perl yt-dlp || true
#   npm i -g @cloudglue/tinycloud || true
#
# …while REPO setup (this script) runs as a SessionStart hook — wired in
# .claude/settings.json via "$CLAUDE_PROJECT_DIR"/scripts/claude-setup.sh —
# which executes after launch, inside the clone, on every session start.
#
# Behavior:
#   - cloud-only by default (CLAUDE_CODE_REMOTE=true); locally it exits 0
#     silently unless OC_CLAUDE_SETUP_LOCAL=1 opts in
#   - fast on resumed/warm sessions: skips npm ci + build — but only when a
#     PREVIOUS full run actually SUCCEEDED (success stamp under gitignored
#     .dev/, written after setup-dev exits 0 — mere existence of node_modules/
#     dist can be the debris of a half-failed cold start and must retry full)
#   - never blocks a session on the optional bits (setup-dev degrades those)
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "${BASH_SOURCE[0]}")/..}"

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${OC_CLAUDE_SETUP_LOCAL:-}" != "1" ]; then
  exit 0   # local session — dev machines manage their own node_modules/dist
fi

SETUP_STAMP=.dev/claude-setup-ok
if [ -f "$SETUP_STAMP" ] && [ -d node_modules ] && [ -f dist/bin/overcast.js ]; then
  echo "[claude-setup] warm session — prior setup succeeded, refreshing media wiring only."
  bash scripts/setup-dev.sh --skip-install --skip-build
else
  bash scripts/setup-dev.sh   # set -e: the stamp below is only reached on success
  mkdir -p .dev && touch "$SETUP_STAMP"
fi
