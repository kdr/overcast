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
ci() {
  local dir="$1" label="$2"
  if [ -f "$dir/package.json" ]; then
    echo "[cursor-update] npm ci — $label"
    npm --prefix "$dir" ci \
      || echo "[cursor-update] WARNING: npm ci failed in $label — continuing." >&2
  fi
}

ci "$REPO_ROOT" "overcast (root)"                       # root postinstall (brand-pi) runs automatically
ci "$REPO_ROOT/vscode" "overcast/vscode"
ci "$REPO_ROOT/../overcast.video" "overcast.video (sibling marketing site)"

# Optional live-e2e media wiring — no-ops without OC_E2E_MEDIA_URL, caches after
# the first fetch, and must never block startup.
if [ -f "$REPO_ROOT/scripts/fetch-e2e-media.sh" ]; then
  bash "$REPO_ROOT/scripts/fetch-e2e-media.sh" \
    || echo "[cursor-update] WARNING: e2e media fetch failed — continuing (media-gated cases SKIP)." >&2
fi

echo "[cursor-update] done."
