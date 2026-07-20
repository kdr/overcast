#!/usr/bin/env bash
# cursor-update.sh — Cursor Cloud "Update Script" for this workspace.
#
# Runs on VM startup (after the repos are pulled, before the agent starts) to
# refresh dependencies so the dev environment is ready. Idempotent + low-risk:
# a per-repo `npm ci` guarded by package.json, plus the optional live-e2e media
# wiring (a clean no-op without the OC_E2E_MEDIA_URL secret). It deliberately
# does NOT build, run tests, or `npm i -g` anything — tinycloud and other
# global/system tools are snapshot-layer, see CLAUDE.md ("Cursor Cloud specific
# instructions"). A single repo/install hiccup is logged but never aborts the
# rest, so a transient failure can't brick session startup.
#
# Point the Cursor environment "Update Script" field at this file, e.g.:
#   bash /agent/repos/overcast/scripts/cursor-update.sh
#
# Paths resolve from THIS script's own location, so it is cwd-independent (the
# Update Script field runs from the workspace root, not the repo).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# npm ci in <dir> when it carries a package.json (skipped cleanly otherwise, so
# this is safe if a repo is absent or a prior PR that added it isn't merged).
# --include=optional matches setup-dev.sh: playwright (the screenshot/browser
# engine) is an OPTIONAL dep, and an environment npm config that omits optional
# deps would otherwise leave the Chromium renderer without its module.
ci() {
  local dir="$1" label="$2"
  if [ -f "$dir/package.json" ]; then
    echo "[cursor-update] npm ci — $label"
    npm --prefix "$dir" ci --include=optional \
      || echo "[cursor-update] WARNING: npm ci failed in $label — continuing." >&2
  fi
}

ci "$REPO_ROOT" "overcast (root)"                       # root postinstall (brand-pi) runs automatically
ci "$REPO_ROOT/vscode" "overcast/vscode"
ci "$REPO_ROOT/../overcast.video" "overcast.video (sibling marketing site)"

# Optional live-e2e media wiring — no-ops without OC_E2E_MEDIA_URL, caches after
# the first fetch, and must never block startup. Same .env bridge as
# setup-dev.sh: the URL/sha may live only in the repo .env (per .env.example)
# rather than in environment Secrets — source it in a subshell (never scrape
# lines), real env vars win, and each gap fills INDEPENDENTLY.
if [ -f "$REPO_ROOT/.env" ]; then
  dotenv_val() { ( set +u; cd "$REPO_ROOT" || exit; # shellcheck disable=SC1091
    . ./.env >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"" ); }
  [ -n "${OC_E2E_MEDIA_URL:-}" ]    || OC_E2E_MEDIA_URL="$(dotenv_val OC_E2E_MEDIA_URL)"
  [ -n "${OC_E2E_MEDIA_SHA256:-}" ] || OC_E2E_MEDIA_SHA256="$(dotenv_val OC_E2E_MEDIA_SHA256)"
  export OC_E2E_MEDIA_URL OC_E2E_MEDIA_SHA256
fi
if [ -f "$REPO_ROOT/scripts/fetch-e2e-media.sh" ]; then
  bash "$REPO_ROOT/scripts/fetch-e2e-media.sh" \
    || echo "[cursor-update] WARNING: e2e media fetch failed — continuing (media-gated cases SKIP)." >&2
fi

echo "[cursor-update] done."
