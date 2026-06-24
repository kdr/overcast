#!/usr/bin/env bash
# overcast e2e suite — cumulative entrypoint.
#
#   bash test/e2e/run.sh [phaseN ...]
#
# Runs the committed case scripts in test/e2e/cases/ (all of them, or only the
# named phases). Each run gets a fresh, timestamped, UNCOMMITTED folder
# ./.dev/smoke/<UTC>/ holding every case's raw JSON plus a generated report.md
# (timestamp + phase + git SHA, what was tested, per-case results, summary).
#
# Cases hit real clips (~/Downloads/test-videos) and the Cloudglue LLM — kept
# small/few. Only test/e2e/ is committed; .dev/smoke/* stays local.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# --- build the CLI so cases run against fresh dist -------------------------
if [ ! -f dist/bin/overcast.js ] || [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "[run.sh] building CLI…"
  npm run build >/dev/null 2>&1 || { echo "[run.sh] build FAILED"; exit 1; }
fi

export OVERCAST="node $REPO_ROOT/dist/bin/overcast.js"
export TEST_MEDIA="${TEST_MEDIA:-$HOME/Downloads/test-videos}"

UTC="$(date -u +%Y%m%dT%H%M%SZ)"
export SMOKE_DIR="$REPO_ROOT/.dev/smoke/$UTC"
mkdir -p "$SMOKE_DIR"
export RESULTS_TSV="$SMOKE_DIR/results.tsv"
: >"$RESULTS_TSV"

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# --- select cases ----------------------------------------------------------
shopt -s nullglob
if [ "$#" -gt 0 ]; then
  cases=()
  for p in "$@"; do cases+=(test/e2e/cases/"$p"_*.sh); done
else
  cases=(test/e2e/cases/*.sh)
fi

# A run that executes zero cases is a failure, not an "all green" pass —
# usually a typo in the phase filter.
if [ "${#cases[@]}" -eq 0 ]; then
  echo "[run.sh] no case scripts matched ${*:-(all)} — nothing to run" >&2
  exit 1
fi

echo "=== overcast e2e — $UTC — $BRANCH@$GIT_SHA ==="
echo "smoke dir: $SMOKE_DIR"
echo "test media: $TEST_MEDIA"
echo

for c in "${cases[@]}"; do
  echo "--- case file: $(basename "$c") ---"
  # shellcheck disable=SC1090
  bash "$c"
  rc=$?
  # A case that dies before writing its own result row (missing dep, script
  # error) would otherwise be silently counted as zero failures. Record it.
  if [ "$rc" -ne 0 ]; then
    printf '%s\tfail\tcase script exited rc=%s\n' \
      "$(basename "$c" .sh)" "$rc" >>"$RESULTS_TSV"
  fi
  echo
done

# --- summarize (bash 3.2 compatible: macOS ships 3.2) ----------------------
pass=$(grep -c $'\tpass\t' "$RESULTS_TSV" 2>/dev/null); pass=${pass:-0}
fail=$(grep -c $'\tfail\t' "$RESULTS_TSV" 2>/dev/null); fail=${fail:-0}
total=$((pass + fail))

REPORT="$SMOKE_DIR/report.md"
{
  echo "# overcast e2e report"
  echo
  echo "- **timestamp:** $UTC"
  echo "- **phase(s):** ${*:-all}"
  echo "- **branch / sha:** \`$BRANCH@$GIT_SHA\`"
  echo "- **test media:** \`$TEST_MEDIA\`"
  echo
  echo "## What was tested"
  echo
  for c in "${cases[@]}"; do echo "- \`$(basename "$c")\`"; done
  echo
  echo "## Results"
  echo
  echo "| case | result | note |"
  echo "|---|---|---|"
  while IFS=$'\t' read -r name res note; do
    res_uc=$(printf '%s' "$res" | tr '[:lower:]' '[:upper:]')
    note_esc=$(printf '%s' "$note" | sed 's/|/\\|/g')
    echo "| $name | $res_uc | $note_esc |"
  done <"$RESULTS_TSV"
  echo
  echo "## Summary"
  echo
  echo "- total: **$total**, pass: **$pass**, fail: **$fail**"
  if [ "$fail" -gt 0 ]; then
    echo "- ❌ failures present"
  else
    echo "- ✅ all green"
  fi
} >"$REPORT"

echo "=== summary: $pass/$total passed, $fail failed ==="
echo "report: $REPORT"
[ "$fail" -eq 0 ]
