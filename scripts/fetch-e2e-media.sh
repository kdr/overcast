#!/usr/bin/env bash
# fetch-e2e-media.sh — download + wire the LIVE-e2e media bundle.
#
# Downloads a zip bundle (manifest.env + media/) from the unlisted URL in
# OC_E2E_MEDIA_URL, unpacks it to a cache dir OUTSIDE the repo, and splices the
# resulting ABSOLUTE media paths into .env under a managed marker block —
# leaving everything else in .env (keys, hand edits) untouched. Idempotent:
# re-running with the same inputs rewrites a byte-identical block and skips the
# download when the cache is already valid (the cache is keyed to the URL via a
# stamp file written only after a successful unpack, so a URL change or an
# interrupted unzip forces a re-fetch). With no URL configured it no-ops
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
# is missing are warned + omitted so their e2e cases SKIP. Absolute paths and
# `..` segments in the manifest are rejected (the bundle is semi-trusted; never
# let it wire arbitrary filesystem paths into .env). See
# test/e2e/README.md ("Fetching test media automatically").
#
# The URL may carry a token — it is NEVER printed or stored by this script
# (the cache stamp records only its sha256).
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
STAMP="$CACHE_DIR/.stamp"   # "<url-sha256> <zip-sha256>", written after a good unpack

BLOCK_BEGIN="# >>> overcast e2e media (managed by scripts/fetch-e2e-media.sh) >>>"
BLOCK_END="# <<< overcast e2e media <<<"

sha256_of() { # <file> — empty output when no sha tool is available
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
sha256_str() { # <string> — sha of a string (used to key the cache to the URL)
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

URL_HASH="$(sha256_str "$URL")"

# Cache is valid only when the stamp (written after a successful unpack) matches
# the CURRENT url, the zip + manifest are present, and — when the caller pins a
# sha — the stamped zip sha matches it. This makes a URL change, an interrupted
# unzip, or a sha bump each force a clean re-fetch.
cache_valid() {
  [ "$FORCE" = "1" ] && return 1
  [ -f "$STAMP" ] && [ -f "$ZIP" ] && [ -f "$MANIFEST" ] || return 1
  local stamped_url stamped_zip
  read -r stamped_url stamped_zip <"$STAMP" || return 1
  [ -n "$URL_HASH" ] && [ "$stamped_url" = "$URL_HASH" ] || return 1
  if [ -n "$SHA_EXPECT" ]; then
    [ "$stamped_zip" = "$SHA_EXPECT" ] || return 1
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
  # Verify BEFORE replacing any previously good cached zip.
  ZIP_SHA="$(sha256_of "$ZIP.tmp")"
  if [ -z "$ZIP_SHA" ]; then
    rm -f "$ZIP.tmp"
    echo "[e2e-media] ERROR: no sha256sum/shasum tool found — cannot stamp/verify the bundle." >&2
    exit 1
  fi
  if [ -n "$SHA_EXPECT" ]; then
    if [ "$ZIP_SHA" != "$SHA_EXPECT" ]; then
      rm -f "$ZIP.tmp"
      echo "[e2e-media] ERROR: sha256 mismatch — expected $SHA_EXPECT got $ZIP_SHA; discarded the download (existing cache untouched)." >&2
      exit 1
    fi
    echo "[e2e-media] sha256 verified."
  else
    echo "[e2e-media] WARNING: OC_E2E_MEDIA_SHA256 not set — skipping integrity verification."
  fi
  rm -f "$STAMP"                # invalidate until the new unpack completes
  mv "$ZIP.tmp" "$ZIP"
  rm -rf "$UNPACK"
  mkdir -p "$UNPACK"
  # NOTE: Info-ZIP unzip refuses `../` path components by default — do not pass
  # the `-:` flag (it re-enables extraction traversal).
  unzip -q -o "$ZIP" -d "$UNPACK"
  if [ ! -f "$MANIFEST" ]; then
    echo "[e2e-media] ERROR: bundle has no manifest.env at its root — not a valid media bundle." >&2
    exit 1
  fi
  printf '%s %s\n' "$URL_HASH" "$ZIP_SHA" >"$STAMP"
fi

# --- resolve manifest entries to absolute cache paths ------------------------
# Values are double-quoted in the managed block so paths containing spaces
# survive both bash `source` (run.sh) and the CLI's dotenv parser (src/env.ts),
# which both unquote. The bundle is SEMI-TRUSTED and .env gets bash-sourced, so
# var names and paths are strictly validated: names must be identifier-shaped,
# paths a conservative charset (no quotes/$/backticks/backslashes — nothing a
# double-quoted bash expansion could execute), no absolute/../ traversal, and
# no symlinked components (a zip can carry symlinks that point outside the
# cache; unzip restores them and -e would happily follow).
VAR_RE='^[A-Za-z_][A-Za-z0-9_]*$'
REL_RE='^[A-Za-z0-9._/ -]+$'
has_symlink_component() { # <relpath> — true if any component under $UNPACK is a symlink
  local p="$UNPACK" seg
  local IFS='/'
  for seg in $1; do
    [ -n "$seg" ] || continue
    p="$p/$seg"
    [ -L "$p" ] && return 0
  done
  return 1
}
block_body=""
wired=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|\#*) continue ;; esac
  var="${line%%=*}"
  rel="${line#*=}"
  [ -n "$var" ] && [ -n "$rel" ] && [ "$var" != "$line" ] || continue
  if ! [[ "$var" =~ $VAR_RE ]] || ! [[ "$rel" =~ $REL_RE ]]; then
    echo "[e2e-media] WARNING: manifest entry with an invalid var name or unsafe path characters — rejected." >&2
    continue
  fi
  case "/$rel/" in
    //*|*/../*|*/./*)
      echo "[e2e-media] WARNING: manifest entry $var has an absolute or traversal path — rejected." >&2
      continue ;;
  esac
  if has_symlink_component "$rel"; then
    echo "[e2e-media] WARNING: manifest entry $var resolves through a symlink — rejected." >&2
    continue
  fi
  abs="$UNPACK/$rel"
  if [ -e "$abs" ]; then
    block_body="${block_body}${var}=\"${abs}\""$'\n'
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

# Markers are matched as WHOLE lines (-x) everywhere — a substring occurrence
# (say, inside a comment) must neither count as "block present" nor desync the
# awk splice below, and the awk guards against an unterminated block instead of
# silently truncating everything after the begin marker.
env_tmp="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
if [ ! -f "$ENV_FILE" ]; then
  cat "$block_tmp" >"$env_tmp"
elif grep -qxF "$BLOCK_BEGIN" "$ENV_FILE"; then
  if ! grep -qxF "$BLOCK_END" "$ENV_FILE"; then
    rm -f "$env_tmp"
    echo "[e2e-media] ERROR: env file has the begin marker but no end marker — fix it by hand, then re-run." >&2
    exit 1
  fi
  if ! awk -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" -v blockfile="$block_tmp" '
    $0 == begin { while ((getline l < blockfile) > 0) print l; skipping = 1; next }
    $0 == end   { skipping = 0; next }
    !skipping   { print }
    END         { if (skipping) exit 3 }
  ' "$ENV_FILE" >"$env_tmp"; then
    rm -f "$env_tmp"
    echo "[e2e-media] ERROR: managed block markers are malformed (end before begin?) — fix the env file by hand, then re-run." >&2
    exit 1
  fi
else
  cat "$ENV_FILE" >"$env_tmp"
  printf '\n' >>"$env_tmp"
  cat "$block_tmp" >>"$env_tmp"
fi
mv "$env_tmp" "$ENV_FILE"

echo "[e2e-media] wired: ${wired:-'(nothing — empty manifest)'}"
