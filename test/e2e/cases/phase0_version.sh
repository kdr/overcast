#!/usr/bin/env bash
# Phase 0 e2e: the version surface (offline, no cloud).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

out="$($OVERCAST --version --json 2>/dev/null)"
save_json "phase0_version" "$out" >/dev/null

over="$(jq -r '.overcast' <<<"$out")"
pi="$(jq -r '.pi' <<<"$out")"

assert_nonempty "version.overcast" "$over" "overcast version present"
assert_eq "version.pi_pinned" "0.79.10" "$pi" "pi pinned at 0.79.10"
