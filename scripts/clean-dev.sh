#!/usr/bin/env bash
# clean-dev.sh — prune the gitignored .dev/ workspace (e2e run output, scratch
# cases, stray logs). Everything under .dev/ is disposable EXCEPT the uv-managed
# Python venv (.dev/visual-db-py), which is expensive to rebuild — it is only
# removed with --purge.
#
# Usage:
#   scripts/clean-dev.sh                # prune .dev/smoke runs, keep newest 5
#   scripts/clean-dev.sh --keep 10      # keep the newest 10 runs instead
#   scripts/clean-dev.sh --days 7       # prune runs OLDER than 7 days instead
#   scripts/clean-dev.sh --scratch      # also remove scratch dirs + logs
#                                       # (everything in .dev except smoke/ + the venv)
#   scripts/clean-dev.sh --purge        # remove ALL of .dev, venv included
#   scripts/clean-dev.sh --dry-run ...  # print what would be removed, remove nothing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$REPO_ROOT/.dev"
SMOKE_DIR="$DEV_DIR/smoke"
VENV_NAME="visual-db-py"

KEEP=5
DAYS=""
DRY=0
SCRATCH=0
PURGE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)    KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --days)    DAYS="${2:?--days needs a number}"; shift 2 ;;
    --scratch) SCRATCH=1; shift ;;
    --purge)   PURGE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[clean-dev] unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
done

[ -d "$DEV_DIR" ] || { echo "[clean-dev] no .dev/ — nothing to clean."; exit 0; }

# Prefer the system find: dev shells sometimes shim `find` (e.g. rtk) with a
# subset that rejects the compound predicates used below.
FIND=/usr/bin/find; [ -x "$FIND" ] || FIND="find"

freed_before="$(du -sk "$DEV_DIR" 2>/dev/null | cut -f1 || echo 0)"

remove() { # <path>
  if [ "$DRY" = "1" ]; then
    echo "  would remove: ${1#"$REPO_ROOT"/}"
  else
    echo "  removing: ${1#"$REPO_ROOT"/}"
    rm -rf "$1"
  fi
}

if [ "$PURGE" = "1" ]; then
  echo "[clean-dev] purging ALL of .dev (including the $VENV_NAME venv)…"
  remove "$DEV_DIR"
else
  # --- e2e smoke runs (offline <UTC>/ + live live-<UTC>/) --------------------
  if [ -d "$SMOKE_DIR" ]; then
    if [ -n "$DAYS" ]; then
      echo "[clean-dev] pruning .dev/smoke runs older than $DAYS days…"
      while IFS= read -r d; do
        [ -n "$d" ] && remove "$d"
      done < <("$FIND" "$SMOKE_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$DAYS")
    else
      echo "[clean-dev] pruning .dev/smoke runs (keeping the newest $KEEP)…"
      # run dirs sort chronologically by name (UTC timestamps); ls -1t is the
      # tiebreak-friendly order. tail past the keep count = the old ones.
      while IFS= read -r name; do
        [ -n "$name" ] && remove "$SMOKE_DIR/$name"
      done < <(cd "$SMOKE_DIR" && ls -1t 2>/dev/null | tail -n +"$((KEEP + 1))")
    fi
  fi

  # --- scratch dirs + logs (opt-in) ------------------------------------------
  if [ "$SCRATCH" = "1" ]; then
    echo "[clean-dev] removing scratch dirs + logs (keeping smoke/ + $VENV_NAME/)…"
    while IFS= read -r entry; do
      base="$(basename "$entry")"
      case "$base" in smoke|"$VENV_NAME") continue ;; esac
      remove "$entry"
    done < <("$FIND" "$DEV_DIR" -mindepth 1 -maxdepth 1)
  fi
fi

if [ "$DRY" = "1" ]; then
  echo "[clean-dev] dry run — nothing removed."
else
  freed_after="$(du -sk "$DEV_DIR" 2>/dev/null | cut -f1 || echo 0)"
  freed_mb=$(( (freed_before - freed_after) / 1024 ))
  echo "[clean-dev] done — freed ~${freed_mb}MB."
fi
