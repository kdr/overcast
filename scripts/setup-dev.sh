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
#   scripts/setup-dev.sh --bun           # also install the bun runtime (build:bun +
#                                        # the default live-e2e runner; node fallback
#                                        # via OVERCAST_USE_NODE=1)
#   scripts/setup-dev.sh --venv [mode]   # also build the uv Python venv via
#                                        # scripts/visual-db-uv.sh (default mode:
#                                        # all — multi-GB torch download) and wire
#                                        # OC_VISUAL_DB_PY / DETECT_PY into .env
#   scripts/setup-dev.sh --system-deps   # also best-effort install missing system
#                                        # tools via brew/apt (ffmpeg, exiftool;
#                                        # + c2patool/shellcheck on brew) and
#                                        # yt-dlp via uv tool/pipx/pip with the
#                                        # curl-cffi impersonation extra
#   scripts/setup-dev.sh --full          # --tinycloud + --bun + --venv all + --system-deps
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
INSTALL_BUN=0
SYSTEM_DEPS=0
VENV_MODE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --test)         RUN_TESTS=1; shift ;;
    --tinycloud)    INSTALL_TINYCLOUD=1; shift ;;
    --bun)          INSTALL_BUN=1; shift ;;
    --system-deps)  SYSTEM_DEPS=1; shift ;;
    --venv)
      VENV_MODE="all"
      if [ "$#" -gt 1 ] && [[ "$2" != --* ]]; then VENV_MODE="$2"; shift; fi
      shift ;;
    --full)         INSTALL_TINYCLOUD=1; INSTALL_BUN=1; SYSTEM_DEPS=1; VENV_MODE="${VENV_MODE:-all}"; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# --- system tools (opt-in; brew on macOS, apt-get on Debian/Ubuntu) ------------
# Best-effort and non-fatal: only installs what's MISSING, and a tool that can't
# be installed (no package manager, no sudo, not packaged for the distro) is
# just reported — its verbs/cases degrade or SKIP cleanly, like everything else.
if [ "$SYSTEM_DEPS" = "1" ]; then
  # ffmpeg = the internal media toolkit (invariant: system prerequisite, not
  # bundled); exiftool/c2patool = the exif/verify forensic senses; shellcheck =
  # the CI shell lint. yt-dlp is deliberately NOT in this list — it gets its own
  # install chain below (brew/apt builds lack curl_cffi impersonation).
  want=(ffmpeg exiftool c2patool shellcheck)
  missing=()
  for t in "${want[@]}"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  if [ "${#missing[@]}" -eq 0 ]; then
    echo "[setup-dev] system tools all present — nothing to install."
  elif command -v brew >/dev/null 2>&1; then
    echo "[setup-dev] installing via brew: ${missing[*]}"
    brew install "${missing[@]}" || echo "[setup-dev] WARNING: brew install had failures — continuing (missing tools degrade/SKIP)." >&2
  elif command -v apt-get >/dev/null 2>&1; then
    # c2patool + shellcheck-current aren't reliably in apt; install what is.
    # Tool → apt package name mapping (exiftool ships as libimage-exiftool-perl).
    aptpkgs=()
    for t in "${missing[@]}"; do
      case "$t" in
        c2patool) echo "[setup-dev] NOTE: c2patool is not apt-packaged — install from https://github.com/contentauth/c2patool releases." ;;
        exiftool) aptpkgs+=(libimage-exiftool-perl) ;;
        *)        aptpkgs+=("$t") ;;
      esac
    done
    if [ "${#aptpkgs[@]}" -gt 0 ]; then
      SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
      echo "[setup-dev] installing via apt-get: ${aptpkgs[*]}"
      $SUDO apt-get update -qq || echo "[setup-dev] WARNING: apt-get update failed — trying installs anyway." >&2
      # One package per transaction: a single unavailable package must not abort
      # the rest.
      for p in "${aptpkgs[@]}"; do
        $SUDO apt-get install -y -qq "$p" \
          || echo "[setup-dev] WARNING: apt-get install $p failed (not packaged for this distro? no sudo?) — continuing." >&2
      done
    fi
  else
    echo "[setup-dev] WARNING: no brew/apt-get found — install manually: ${missing[*]}" >&2
  fi

  # yt-dlp — the youtube/dl sources + tiktok/x/instagram/telegram post-page
  # fetches. Installed via its OWN chain, not brew/apt: TLS-fingerprinting hosts
  # (e.g. domain-restricted Vimeo embeds) need curl_cffi impersonation, which
  # the brew formula's sealed venv can't grow (you can't pip-inject it) and the
  # stale apt package never ships. Newest-first channels that carry the
  # [default,curl-cffi] extras: uv tool → pipx → pip3 --user; brew/apt only as
  # a warned last resort. An EXISTING install is left alone — `overcast doctor`
  # reports impersonation-less builds, and replacing a user's install under
  # them is ruder than flagging it.
  if command -v yt-dlp >/dev/null 2>&1; then
    echo "[setup-dev] yt-dlp already installed ($(yt-dlp --version 2>/dev/null || echo '?')) — leaving it (run \`overcast doctor\` to check impersonation support)."
  else
    ytdlp_done=""
    if command -v uv >/dev/null 2>&1; then
      echo "[setup-dev] installing yt-dlp via uv tool (with curl-cffi impersonation)…"
      if uv tool install "yt-dlp[default,curl-cffi]"; then ytdlp_done=1; fi
    fi
    if [ -z "$ytdlp_done" ] && command -v pipx >/dev/null 2>&1; then
      echo "[setup-dev] installing yt-dlp via pipx (with curl-cffi impersonation)…"
      if pipx install "yt-dlp[default,curl-cffi]"; then ytdlp_done=1; fi
    fi
    if [ -z "$ytdlp_done" ] && command -v pip3 >/dev/null 2>&1; then
      echo "[setup-dev] installing yt-dlp via pip3 --user (with curl-cffi impersonation)…"
      # PEP 668 distros (Debian 12+/Ubuntu 24+) refuse a bare --user install;
      # retry with --break-system-packages (older pips don't know the flag,
      # hence the two-step rather than passing it unconditionally).
      if pip3 install --user -U "yt-dlp[default,curl-cffi]" \
         || pip3 install --user --break-system-packages -U "yt-dlp[default,curl-cffi]"; then
        ytdlp_done=1
      fi
    fi
    if [ -n "$ytdlp_done" ]; then
      if command -v yt-dlp >/dev/null 2>&1; then
        echo "[setup-dev] yt-dlp $(yt-dlp --version 2>/dev/null || echo '?') installed (impersonation-capable)."
      else
        echo "[setup-dev] yt-dlp installed but not on PATH yet — add ~/.local/bin (pipx/pip/uv's bin dir) to PATH, or point OVERCAST_YTDLP_CMD at it."
      fi
    else
      # last resort: the package-manager build (no curl_cffi — TLS-fingerprinting
      # hosts will fail; doctor flags it).
      echo "[setup-dev] WARNING: no uv/pipx/pip3 usable — falling back to brew/apt for yt-dlp (that build lacks curl_cffi impersonation; hosts like Vimeo embeds will fail)." >&2
      if command -v brew >/dev/null 2>&1; then
        brew install yt-dlp || echo "[setup-dev] WARNING: brew install yt-dlp failed — install manually (https://github.com/yt-dlp/yt-dlp#installation)." >&2
      elif command -v apt-get >/dev/null 2>&1; then
        SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
        $SUDO apt-get install -y -qq yt-dlp || echo "[setup-dev] WARNING: apt-get install yt-dlp failed — install manually (https://github.com/yt-dlp/yt-dlp#installation)." >&2
      else
        echo "[setup-dev] WARNING: install yt-dlp manually: https://github.com/yt-dlp/yt-dlp#installation" >&2
      fi
    fi
  fi
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

# --- bun runtime (opt-in; build:bun + the default live-e2e runner) -------------
# Needed only for the COMPILED binary path (`npm run build:bun`, and the live e2e
# suite's default runner); the whole node dev loop + `OVERCAST_USE_NODE=1` live
# runs work without it. Installs to ~/.bun via the official installer (no root),
# which also appends ~/.bun/bin to the shell profile so later sessions resolve it.
if [ "$INSTALL_BUN" = "1" ]; then
  if command -v bun >/dev/null 2>&1; then
    echo "[setup-dev] bun already installed ($(bun --version 2>/dev/null)) — skipping."
  else
    echo "[setup-dev] installing bun (https://bun.sh/install)…"
    if curl -fsSL https://bun.sh/install | bash; then
      export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
      export PATH="$BUN_INSTALL/bin:$PATH"
      echo "[setup-dev] bun $(bun --version 2>/dev/null) installed (open a new shell or PATH=\"\$HOME/.bun/bin:\$PATH\")."
    else
      echo "[setup-dev] WARNING: bun install failed — continuing (build:bun unavailable; use OVERCAST_USE_NODE=1)." >&2
    fi
  fi
fi

# --- uv Python venv (opt-in; local visual/audio DB + enhance providers) --------
if [ -n "$VENV_MODE" ]; then
  echo "[setup-dev] building the visual-db Python venv (mode: --$VENV_MODE — torch stacks are multi-GB)…"
  bash scripts/visual-db-uv.sh "--$VENV_MODE"
  VENV_PY="${OVERCAST_VISUAL_DB_VENV:-$REPO_ROOT/.dev/visual-db-py}/bin/python"
  # Wire the venv into .env only when a key has no NON-EMPTY value yet — an
  # empty `OC_VISUAL_DB_PY=` placeholder (copied from .env.example) must not
  # block wiring, and a hand-set value is never overwritten. Appending is safe
  # either way: last assignment wins for both bash source and the CLI parser.
  # Values are double-quoted so a repo path with spaces survives sourcing.
  touch .env
  grep -Eq '^OC_VISUAL_DB_PY=.+' .env || printf 'OC_VISUAL_DB_PY="%s"\n' "$VENV_PY" >>.env
  grep -Eq '^DETECT_PY=.+' .env || printf 'DETECT_PY="%s"\n' "$VENV_PY" >>.env
  echo "[setup-dev] venv ready; OC_VISUAL_DB_PY / DETECT_PY wired into .env (existing values kept)."
fi

# --- optional e2e media (no-ops without OC_E2E_MEDIA_URL) ----------------------
# fetch-e2e-media.sh reads its knobs from the environment; also honor a .env
# that already carries them, so setup works either way. Bridge by SOURCING .env
# in a subshell — the same semantics as the live runner (quotes, inline values)
# — never by scraping lines. Real env vars win; .env fills each gap
# INDEPENDENTLY (a Secret-provided URL still picks up a .env-only sha).
if [ -f .env ]; then
  dotenv_val() { ( set +u; # shellcheck disable=SC1091
    . ./.env >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"" ); }
  [ -n "${OC_E2E_MEDIA_URL:-}" ]    || OC_E2E_MEDIA_URL="$(dotenv_val OC_E2E_MEDIA_URL)"
  [ -n "${OC_E2E_MEDIA_SHA256:-}" ] || OC_E2E_MEDIA_SHA256="$(dotenv_val OC_E2E_MEDIA_SHA256)"
  export OC_E2E_MEDIA_URL OC_E2E_MEDIA_SHA256
fi
# Media is OPTIONAL by design — a hosting outage or bad sha must not abort dev
# setup (media-gated e2e cases just SKIP). The fetch script's own error output
# says what went wrong.
bash scripts/fetch-e2e-media.sh \
  || echo "[setup-dev] WARNING: e2e media fetch failed — continuing (media-gated e2e cases will SKIP)." >&2

# --- sanity check the built CLI ------------------------------------------------
if node dist/bin/overcast.js version --json >/dev/null 2>&1; then
  echo "[setup-dev] CLI OK: node dist/bin/overcast.js ($(node dist/bin/overcast.js version 2>/dev/null | head -1))"
else
  echo "[setup-dev] ERROR: built CLI does not run (node dist/bin/overcast.js version failed)." >&2
  exit 1
fi

# --- optional tools report ------------------------------------------------------
echo "[setup-dev] optional tools:"
for tool in ffmpeg ffprobe bun uv yt-dlp exiftool c2patool shellcheck tinycloud; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "  present: $tool"
  else
    echo "  missing: $tool (optional — re-run with --system-deps to install what brew/apt/pipx can)"
  fi
done
echo "  (ffmpeg/ffprobe: media ops · bun: binary build + default live-e2e runner ·"
echo "   uv: local visual/audio DB venv via scripts/visual-db-uv.sh · yt-dlp:"
echo "   youtube/dl sources · exiftool/c2patool: forensic senses · shellcheck:"
echo "   CI shell lint · tinycloud: default cloud senses)"

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
