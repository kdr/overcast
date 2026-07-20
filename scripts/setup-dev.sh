#!/usr/bin/env bash
# setup-dev.sh — one-shot dev-environment initialization for overcast.
#
# Intended for a fresh clone (human or coding agent): installs deps, builds the
# dev CLI, wires optional e2e media (when OC_E2E_MEDIA_URL is configured — see
# scripts/fetch-e2e-media.sh), sanity-checks the built CLI, and reports which
# OPTIONAL system tools are present. Idempotent; safe to re-run.
#
# Usage:
#   scripts/setup-dev.sh                 # install + build + media fetch + checks
#   scripts/setup-dev.sh --skip-install  # reuse existing node_modules
#   scripts/setup-dev.sh --skip-build    # reuse existing dist/
#   scripts/setup-dev.sh --test          # also run unit + offline e2e suites
#   scripts/setup-dev.sh --tinycloud     # also npm i -g the tinycloud CLI (>= 0.3.12)
#   scripts/setup-dev.sh --venv [mode]   # also build the uv Python venv via
#                                        # scripts/visual-db-uv.sh (default mode:
#                                        # all — multi-GB torch download) and wire
#                                        # OC_VISUAL_DB_PY / DETECT_PY into .env
#   scripts/setup-dev.sh --full          # --tinycloud + --venv all
#
# Everything optional stays optional: no creds, media, bun, or Python needed
# for the core dev loop (build / typecheck / npm test / offline e2e). The
# tinycloud install needs no creds either — CLOUDGLUE_API_KEY is a RUNTIME env
# var, picked up from .env / Secrets when verbs run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_INSTALL=0
SKIP_BUILD=0
RUN_TESTS=0
INSTALL_TINYCLOUD=0
VENV_MODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --test)         RUN_TESTS=1; shift ;;
    --tinycloud)    INSTALL_TINYCLOUD=1; shift ;;
    --venv)
      VENV_MODE="all"
      if [ "$#" -gt 1 ] && [[ "$2" != --* ]]; then VENV_MODE="$2"; shift; fi
      shift ;;
    --full)         INSTALL_TINYCLOUD=1; VENV_MODE="${VENV_MODE:-all}"; shift ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[setup-dev] unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# --- node version -------------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "[setup-dev] ERROR: node not found (need >= 22)." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[setup-dev] ERROR: node $(node -v) < 22 — install Node 22+." >&2
  exit 1
fi
echo "[setup-dev] node $(node -v)"

# --- install ------------------------------------------------------------------
if [ "$SKIP_INSTALL" = "1" ]; then
  echo "[setup-dev] skipping npm install (--skip-install)."
else
  echo "[setup-dev] installing deps (npm ci --include=optional)…"
  # --include=optional pulls playwright for the screenshot/browser engine; an
  # EBADENGINE warning from pi-tui on node < 22.19 is expected and harmless.
  npm ci --include=optional
fi

# --- build --------------------------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  echo "[setup-dev] skipping build (--skip-build)."
else
  echo "[setup-dev] building (npm run build)…"
  npm run build
fi

# --- tinycloud CLI (opt-in; the default watch/listen/face/index backend) -------
if [ "$INSTALL_TINYCLOUD" = "1" ]; then
  if command -v tinycloud >/dev/null 2>&1; then
    echo "[setup-dev] tinycloud already installed ($(tinycloud --version 2>/dev/null | head -1)) — skipping (floor is 0.3.12; 'tinycloud update' to bump)."
  else
    echo "[setup-dev] installing tinycloud CLI (npm i -g @cloudglue/tinycloud)…"
    npm i -g @cloudglue/tinycloud
    echo "[setup-dev] tinycloud $(tinycloud --version 2>/dev/null | head -1) installed."
  fi
  # No creds needed to install — CLOUDGLUE_API_KEY is read at runtime from the
  # environment (.env / Secrets) when watch/listen/face/index verbs run.
fi

# --- uv Python venv (opt-in; local visual/audio DB + enhance providers) --------
if [ -n "$VENV_MODE" ]; then
  echo "[setup-dev] building the visual-db Python venv (mode: --$VENV_MODE — torch stacks are multi-GB)…"
  bash scripts/visual-db-uv.sh "--$VENV_MODE"
  VENV_PY="${OVERCAST_VISUAL_DB_VENV:-$REPO_ROOT/.dev/visual-db-py}/bin/python"
  # Wire the venv into .env only when the keys are absent — never overwrite a
  # hand-set value.
  touch .env
  grep -q '^OC_VISUAL_DB_PY=' .env || printf 'OC_VISUAL_DB_PY=%s\n' "$VENV_PY" >>.env
  grep -q '^DETECT_PY=' .env || printf 'DETECT_PY=%s\n' "$VENV_PY" >>.env
  echo "[setup-dev] venv ready; OC_VISUAL_DB_PY / DETECT_PY wired into .env (existing values kept)."
fi

# --- optional e2e media (no-ops without OC_E2E_MEDIA_URL) ----------------------
# fetch-e2e-media.sh reads its knobs from the environment; also honor a .env
# that already carries OC_E2E_MEDIA_URL so setup works either way.
if [ -z "${OC_E2E_MEDIA_URL:-}" ] && [ -f .env ]; then
  OC_E2E_MEDIA_URL="$(sed -n 's/^OC_E2E_MEDIA_URL=//p' .env | tail -1)"
  OC_E2E_MEDIA_SHA256="${OC_E2E_MEDIA_SHA256:-$(sed -n 's/^OC_E2E_MEDIA_SHA256=//p' .env | tail -1)}"
  export OC_E2E_MEDIA_URL OC_E2E_MEDIA_SHA256
fi
bash scripts/fetch-e2e-media.sh

# --- sanity check the built CLI ------------------------------------------------
if node dist/bin/overcast.js version --json >/dev/null 2>&1; then
  echo "[setup-dev] CLI OK: node dist/bin/overcast.js ($(node dist/bin/overcast.js version 2>/dev/null | head -1))"
else
  echo "[setup-dev] ERROR: built CLI does not run (node dist/bin/overcast.js version failed)." >&2
  exit 1
fi

# --- optional tools report ------------------------------------------------------
echo "[setup-dev] optional tools:"
for tool in ffmpeg ffprobe bun uv exiftool c2patool shellcheck tinycloud; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "  present: $tool"
  else
    echo "  missing: $tool (optional)"
  fi
done
echo "  (ffmpeg/ffprobe: media ops · bun: binary build + default live-e2e runner ·"
echo "   uv: local visual/audio DB venv via scripts/visual-db-uv.sh · exiftool/c2patool:"
echo "   forensic senses · shellcheck: CI shell lint · tinycloud: default cloud senses)"

# --- tests (opt-in) -------------------------------------------------------------
if [ "$RUN_TESTS" = "1" ]; then
  echo "[setup-dev] running unit tests…"
  npm test
  echo "[setup-dev] running offline e2e…"
  SKIP_BUILD=1 npm run test:e2e
fi

echo "[setup-dev] done. Next steps:"
echo "  npm test                # unit tests (offline)"
echo "  SKIP_BUILD=1 npm run test:e2e   # offline e2e (fixture providers)"
echo "  npm run test:e2e:live   # live e2e (needs .env creds + media; OVERCAST_USE_NODE=1 without bun)"
echo "  scripts/clean-dev.sh    # prune old e2e run output in .dev/"
