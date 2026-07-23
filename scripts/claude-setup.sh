#!/bin/bash
# claude-setup.sh — SessionStart hook for Claude Code cloud sessions.
#
# IMPORTANT: this is NOT for the cloud environment's "Setup script" field.
# That field runs BEFORE Claude Code launches, as root, with the repo NOT as
# the working directory (a bare `npm install` there fails with
# "Could not read package.json: … open '/package.json'" and the non-zero exit
# blocks the session). Per the Claude Code web docs, the Setup script field is for
# SYSTEM tools (apt packages — snapshot-cached). That content is source-controlled
# as a ready-to-paste script — scripts/claude-cloud-system-setup.sh — namely:
#
#   #!/bin/bash
#   apt-get update && apt-get install -y ffmpeg libimage-exiftool-perl || true
#   # yt-dlp from apt is too old for current YouTube — latest from PyPI, with
#   # curl-cffi impersonation (TLS-fingerprinting hosts 401 without it):
#   pip install -U --break-system-packages "yt-dlp[default,curl-cffi]" || true
#   npm i -g @cloudglue/tinycloud || true   # default watch/listen/face/index backend
#
# The `screenshot`/`browser:` renderer needs Chromium: the managed cloud image
# usually pre-installs one under PLAYWRIGHT_BROWSERS_PATH (the engine auto-detects
# it — no extra step). If it doesn't, add `npx playwright install chromium` to the
# hook, or point OVERCAST_PLAYWRIGHT_EXECUTABLE at a chrome binary.
#
# Session ENV VARS to set in the environment config (Secrets / env — NOT installed
# here; these are read at runtime, not by this script):
#   - provider keys: CLOUDGLUE_API_KEY (default senses), a brain key
#     (ANTHROPIC_API_KEY/…), plus OSINT keys per .env.example (APIFY_TOKEN,
#     SERPER_API_KEY, SHODAN_API_KEY, WINDY_API_KEY, FIRMS_MAP_KEY, HF_TOKEN, …)
#   - OVERCAST_USE_NODE=1        — run the CLI/live-suite under node (no bun needed)
#   - OVERCAST_TINYCLOUD_DIRECT_EGRESS=1 — REQUIRED for the Cloudglue senses
#     (watch/listen/face) when egress goes through a TLS-re-terminating (MITM)
#     proxy: tinycloud is a bun binary and bun can't do tunneled TLS through such
#     a proxy, so its calls fail with "socket connection closed unexpectedly".
#     This makes tinycloud connect directly (opt-in; bypasses the proxy for
#     tinycloud only). Omit it if your policy forbids bypassing the egress proxy.
#   - OC_E2E_MEDIA_URL (+ OC_E2E_MEDIA_SHA256) — the live-e2e media bundle (wired
#     into .env by fetch-e2e-media.sh, which this hook runs)
#
# …while REPO setup (this script) runs as a SessionStart hook — wired in
# .claude/settings.json via "$CLAUDE_PROJECT_DIR"/scripts/claude-setup.sh —
# which executes after launch, inside the clone, on every session start.
#
# Behavior:
#   - cloud-only by default (CLAUDE_CODE_REMOTE=true); locally it exits 0
#     silently unless OC_CLAUDE_SETUP_LOCAL=1 opts in
#   - fast on resumed/warm sessions: skips the slow npm ci (but ALWAYS rebuilds,
#     so a source-only resume isn't left on stale compiled CLI) — and only skips
#     npm ci when a PREVIOUS full run SUCCEEDED on the CURRENT package-lock.json
#     (the stamp under gitignored .dev/ records the lockfile hash — mere existence
#     of node_modules can be debris of a half-failed cold start, and a resume that
#     pulled dependency changes must npm ci again)
#   - a failed warm refresh clears the stamp and falls back to a full setup in
#     the SAME session, so a broken warm state can't wedge every later resume
#   - never blocks a session on the optional bits (setup-dev degrades those)
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "${BASH_SOURCE[0]}")/..}"

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${OC_CLAUDE_SETUP_LOCAL:-}" != "1" ]; then
  # local session — dev machines manage their own node_modules/dist. Say so on
  # stderr rather than exiting silently: if some OTHER startup surface (e.g. a
  # Cursor Cloud Update Script) was pointed here by mistake, a mute exit 0 would
  # look like a successful setup while installing nothing.
  echo "[claude-setup] skipped: not a Claude Code cloud session (CLAUDE_CODE_REMOTE != true)." >&2
  echo "[claude-setup] Cursor Cloud startup → scripts/cursor-update.sh; full dev setup → scripts/setup-dev.sh; force this hook locally → OC_CLAUDE_SETUP_LOCAL=1." >&2
  exit 0
fi

SETUP_STAMP=.dev/claude-setup-ok
LOCK_HASH="$( { sha256sum package-lock.json 2>/dev/null || shasum -a 256 package-lock.json; } | awk '{print $1}' )"

full_setup() {
  rm -f "$SETUP_STAMP"
  bash scripts/setup-dev.sh   # set -e: the stamp below is only reached on success
  mkdir -p .dev && printf '%s\n' "$LOCK_HASH" >"$SETUP_STAMP"
}

if [ "$(cat "$SETUP_STAMP" 2>/dev/null)" = "$LOCK_HASH" ] && [ -d node_modules ]; then
  # Warm path: deps already match this lockfile, so skip the slow npm ci — but
  # ALWAYS rebuild (tsup is seconds). A resume that pulled SOURCE-only changes
  # leaves the lockfile hash unchanged, so skipping the build here would keep the
  # session on stale compiled CLI; rebuilding every warm start avoids that. Media
  # wiring refreshes too.
  echo "[claude-setup] warm session — deps match this lockfile; skipping npm ci, rebuilding + refreshing media."
  if ! bash scripts/setup-dev.sh --skip-install; then
    echo "[claude-setup] warm refresh failed — clearing the stamp and retrying a full setup." >&2
    full_setup
  fi
else
  full_setup
fi
