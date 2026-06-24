#!/usr/bin/env bash
# overcast LIVE (real-data) e2e suite.
#
#   bash test/e2e/live/run.sh [caseN ...]
#
# Differences from the offline suite (test/e2e/run.sh):
#   • runs against the COMPILED BUN BINARY (dist/bin/overcast) by default
#     (set OVERCAST_USE_NODE=1 to run `node dist/bin/overcast.js` instead)
#   • sources .env so REAL provider creds flow to the providers
#     (CLOUDGLUE_API_KEY, HF_TOKEN, FAL_KEY, ELEVENLABS_API_KEY, TAVILY_API_KEY,
#      APIFY_TOKEN, …) — cases gate themselves and SKIP when a key/tool is absent
#   • uses REAL clips from ~/Downloads/test-videos and hits real backends
#
# Output → ./.dev/smoke/live-<UTC>/ (raw JSON + report.md), gitignored.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

# --- creds: source .env (do not echo values) -------------------------------
if [ -f .env ]; then
  set -a; # shellcheck disable=SC1091
  . ./.env; set +a
fi

# --- build the CLI under test ----------------------------------------------
if [ "${OVERCAST_USE_NODE:-}" = "1" ]; then
  [ "${SKIP_BUILD:-}" = "1" ] || { echo "[live] building dist (tsup)…"; npm run build >/dev/null 2>&1 || { echo "build FAILED"; exit 1; }; }
  export OVERCAST="node $REPO_ROOT/dist/bin/overcast.js"
else
  if [ "${SKIP_BUILD:-}" != "1" ] || [ ! -x dist/bin/overcast ]; then
    echo "[live] building bun binary (build:bun)…"
    npm run build:bun >/dev/null 2>&1 || { echo "bun build FAILED (is bun installed?)"; exit 1; }
  fi
  export OVERCAST="$REPO_ROOT/dist/bin/overcast"
fi

export TEST_MEDIA="${TEST_MEDIA:-$HOME/Downloads/test-videos}"
export FFMPEG="$(node -e "console.log(require('ffmpeg-static'))" 2>/dev/null || echo ffmpeg)"

UTC="$(date -u +%Y%m%dT%H%M%SZ)"
export SMOKE_DIR="$REPO_ROOT/.dev/smoke/live-$UTC"
mkdir -p "$SMOKE_DIR"
export RESULTS_TSV="$SMOKE_DIR/results.tsv"; : >"$RESULTS_TSV"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# --- select cases ----------------------------------------------------------
shopt -s nullglob
if [ "$#" -gt 0 ]; then
  cases=(); for p in "$@"; do cases+=(test/e2e/live/cases/"$p"*.sh); done
else
  cases=(test/e2e/live/cases/*.sh)
fi
if [ "${#cases[@]}" -eq 0 ]; then echo "[live] no cases matched ${*:-(all)}" >&2; exit 1; fi

echo "=== overcast LIVE e2e — $UTC — $BRANCH@$GIT_SHA ==="
echo "binary:     $OVERCAST"
echo "test media: $TEST_MEDIA"
echo "creds:      $(for k in CLOUDGLUE_API_KEY HF_TOKEN FAL_KEY ELEVENLABS_API_KEY TAVILY_API_KEY APIFY_TOKEN; do [ -n "${!k:-}" ] && printf '%s ' "${k%%_*}"; done)"
echo "$OVERCAST" version --json 2>/dev/null | head -1 || true
echo

for c in "${cases[@]}"; do
  echo "--- $(basename "$c") ---"
  before=$(wc -l <"$RESULTS_TSV")
  bash "$c"; rc=$?
  after=$(wc -l <"$RESULTS_TSV")
  if [ "$rc" -ne 0 ] && [ "$after" -eq "$before" ]; then
    printf '%s\tfail\tcase exited rc=%s\n' "$(basename "$c" .sh)" "$rc" >>"$RESULTS_TSV"
  fi
  echo
done

# --- report ----------------------------------------------------------------
pass=$(grep -c $'\tpass\t' "$RESULTS_TSV" 2>/dev/null); pass=${pass:-0}
fail=$(grep -c $'\tfail\t' "$RESULTS_TSV" 2>/dev/null); fail=${fail:-0}
total=$((pass + fail))
REPORT="$SMOKE_DIR/report.md"
{
  echo "# overcast LIVE e2e report"; echo
  echo "- **timestamp:** $UTC"
  echo "- **branch / sha:** \`$BRANCH@$GIT_SHA\`"
  echo "- **binary:** \`$OVERCAST\`"
  echo "- **test media:** \`$TEST_MEDIA\`"; echo
  echo "## Results"; echo
  echo "| case | result | note |"; echo "|---|---|---|"
  while IFS=$'\t' read -r name res note; do
    note_esc=$(printf '%s' "$note" | sed 's/|/\\|/g')
    echo "| $name | $(printf '%s' "$res" | tr a-z A-Z) | $note_esc |"
  done <"$RESULTS_TSV"
  echo; echo "## Summary"; echo
  echo "- total: **$total**, pass/skip: **$pass**, fail: **$fail**"
  [ "$fail" -gt 0 ] && echo "- ❌ failures present" || echo "- ✅ all green"
} >"$REPORT"

echo "=== LIVE summary: $pass/$total passed (incl. skips), $fail failed ==="
echo "report: $REPORT"
if [ "$total" -eq 0 ]; then echo "[live] no results recorded" >&2; exit 1; fi
[ "$fail" -eq 0 ]
