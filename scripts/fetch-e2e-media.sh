#!/usr/bin/env bash
# fetch-e2e-media.sh — download + wire the LIVE-e2e media bundle.
#
# Downloads a zip bundle (manifest.env + media/) from the unlisted URL in
# OC_E2E_MEDIA_URL, unpacks it to a cache dir OUTSIDE the repo, and splices the
# resulting ABSOLUTE media paths into .env under a managed marker block —
# leaving everything else in .env (keys, hand edits) untouched. Idempotent:
# re-running with the same inputs rewrites a byte-identical block and skips the
# download when the cache is already valid. With no URL configured it no-ops
# (exit 0) so it is safe to invoke anywhere (CI, fresh clones).
#
# Inputs (env vars only):
#   OC_E2E_MEDIA_URL       required-to-act; unset/empty → notice + exit 0
#   OC_E2E_MEDIA_SHA256    optional expected sha256 of the zip (verified when set)
#   OC_E2E_MEDIA_DIR       cache dir (default ${XDG_CACHE_HOME:-~/.cache}/overcast-e2e-media)
#   OC_E2E_MEDIA_ENV_FILE  env file to splice (default <repo>/.env)
#   OC_E2E_MEDIA_FORCE     1 → re-download even if the cache looks valid
#
# Bundle format: a zip with manifest.env at its root mapping VAR=relative/path
# (blank lines + # comments allowed); paths resolve against the unzip root and
# may be files OR directories (e.g. OC_CLUSTER_FIXTURE_DIR). Entries whose file
# is missing are warned + omitted so their e2e cases SKIP. See
# test/e2e/README.md ("Fetching test media automatically").
#
# The URL may carry a token — it is NEVER printed by this script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

URL="${OC_E2E_MEDIA_URL:-}"
if [ -z "$URL" ]; then
  echo "[e2e-media] OC_E2E_MEDIA_URL not set — skipping media fetch (media-gated cases will SKIP)."
  exit 0
fi

SHA_EXPECT="${OC_E2E_MEDIA_SHA256:-}"
CACHE_DIR="${OC_E2E_MEDIA_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/overcast-e2e-media}"
ENV_FILE="${OC_E2E_MEDIA_ENV_FILE:-$REPO_ROOT/.env}"
FORCE="${OC_E2E_MEDIA_FORCE:-}"

ZIP="$CACHE_DIR/bundle.zip"
UNPACK="$CACHE_DIR/unpacked"
MANIFEST="$UNPACK/manifest.env"

BLOCK_BEGIN="# >>> overcast e2e media (managed by scripts/fetch-e2e-media.sh) >>>"
BLOCK_END="# <<< overcast e2e media <<<"

sha256_of() { # <file> — empty output when no sha tool is available
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

cache_valid() {
  [ "$FORCE" = "1" ] && return 1
  [ -f "$ZIP" ] || return 1
  [ -f "$MANIFEST" ] || return 1
  if [ -n "$SHA_EXPECT" ]; then
    local got
    got="$(sha256_of "$ZIP")"
    [ -n "$got" ] && [ "$got" = "$SHA_EXPECT" ] || return 1
  fi
  return 0
}

mkdir -p "$CACHE_DIR"

if cache_valid; then
  echo "[e2e-media] cached bundle is valid — skipping download."
else
  command -v curl >/dev/null 2>&1 || { echo "[e2e-media] ERROR: curl is required to download the bundle." >&2; exit 1; }
  command -v unzip >/dev/null 2>&1 || { echo "[e2e-media] ERROR: unzip is required to unpack the bundle." >&2; exit 1; }
  echo "[e2e-media] downloading media bundle…"
  if ! curl -fSL --retry 3 --retry-delay 2 -o "$ZIP.tmp" "$URL" 2>/dev/null; then
    rm -f "$ZIP.tmp"
    echo "[e2e-media] ERROR: download failed — check OC_E2E_MEDIA_URL (value not printed)." >&2
    exit 1
  fi
  mv "$ZIP.tmp" "$ZIP"
  if [ -n "$SHA_EXPECT" ]; then
    got="$(sha256_of "$ZIP")"
    if [ -z "$got" ]; then
      echo "[e2e-media] ERROR: OC_E2E_MEDIA_SHA256 set but no sha256sum/shasum tool found." >&2
      exit 1
    fi
    if [ "$got" != "$SHA_EXPECT" ]; then
      rm -f "$ZIP"
      echo "[e2e-media] ERROR: sha256 mismatch — expected $SHA_EXPECT got $got; removed the bad zip." >&2
      exit 1
    fi
    echo "[e2e-media] sha256 verified."
  else
    echo "[e2e-media] WARNING: OC_E2E_MEDIA_SHA256 not set — skipping integrity verification."
  fi
  rm -rf "$UNPACK"
  mkdir -p "$UNPACK"
  unzip -q -o "$ZIP" -d "$UNPACK"
  if [ ! -f "$MANIFEST" ]; then
    echo "[e2e-media] ERROR: bundle has no manifest.env at its root — not a valid media bundle." >&2
    exit 1
  fi
fi

# --- resolve manifest entries to absolute cache paths ------------------------
block_body=""
wired=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|\#*) continue ;; esac
  var="${line%%=*}"
  rel="${line#*=}"
  [ -n "$var" ] && [ -n "$rel" ] && [ "$var" != "$line" ] || continue
  abs="$UNPACK/$rel"
  if [ -e "$abs" ]; then
    block_body="${block_body}${var}=${abs}"$'\n'
    wired="${wired}${var#OC_} "
  else
    echo "[e2e-media] WARNING: manifest entry $var points at a missing bundle file — omitted (its cases will SKIP)." >&2
  fi
done <"$MANIFEST"

# --- splice the managed block into the env file (atomic, marker-scoped) ------
block_tmp="$(mktemp "${TMPDIR:-/tmp}/oc-e2e-block.XXXXXX")"
trap 'rm -f "$block_tmp"' EXIT
{
  printf '%s\n' "$BLOCK_BEGIN"
  printf '%s' "$block_body"
  printf '%s\n' "$BLOCK_END"
} >"$block_tmp"

env_tmp="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
if [ ! -f "$ENV_FILE" ]; then
  cat "$block_tmp" >"$env_tmp"
elif grep -qF "$BLOCK_BEGIN" "$ENV_FILE"; then
  if ! grep -qF "$BLOCK_END" "$ENV_FILE"; then
    rm -f "$env_tmp"
    echo "[e2e-media] ERROR: env file has the begin marker but no end marker — fix it by hand, then re-run." >&2
    exit 1
  fi
  awk -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" -v blockfile="$block_tmp" '
    $0 == begin { while ((getline l < blockfile) > 0) print l; skipping = 1; next }
    $0 == end   { skipping = 0; next }
    !skipping   { print }
  ' "$ENV_FILE" >"$env_tmp"
else
  cat "$ENV_FILE" >"$env_tmp"
  printf '\n' >>"$env_tmp"
  cat "$block_tmp" >>"$env_tmp"
fi
mv "$env_tmp" "$ENV_FILE"

echo "[e2e-media] wired: ${wired:-'(nothing — empty manifest)'}"
