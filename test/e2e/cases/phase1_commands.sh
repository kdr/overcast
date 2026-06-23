#!/usr/bin/env bash
# Phase 1 e2e: the verb registry surface (offline). `commands --json` is the
# source of truth — assert against it, not memory.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

out="$($OVERCAST commands --json 2>/dev/null)"
save_json "phase1_commands" "$out" >/dev/null

watch_name="$(jq -r '.verbs[] | select(.name=="watch") | .name' <<<"$out")"
watch_kind="$(jq -r '.verbs[] | select(.name=="watch") | .outputKind' <<<"$out")"
watch_group="$(jq -r '.verbs[] | select(.name=="watch") | .group' <<<"$out")"

assert_eq "commands.watch_present" "watch" "$watch_name" "watch verb listed"
assert_eq "commands.watch_kind" "video.analysis" "$watch_kind" "watch outputKind"
assert_eq "commands.watch_group" "sense" "$watch_group" "watch grouped as sense"
