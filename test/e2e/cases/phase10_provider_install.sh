#!/usr/bin/env bash
# Phase 10 e2e (offline, NO API calls): the installable-provider-package flow —
# create → install → discover (list/scan) → remove — over the CLI router.
# Exercises the `installed:` ref end to end; no keys, uses a scaffold source.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

ochome="$SMOKE_DIR/home_install"; mkdir -p "$ochome"
casedir="$SMOKE_DIR/case_install"; mkdir -p "$casedir"
work="$SMOKE_DIR/pkgwork"; mkdir -p "$work"
OC() { $OVERCAST "$@" --home "$ochome" 2>/dev/null; }
# provider records render as a single JSON object; normalize object-or-array.
state() { jq -r 'if type=="array" then .[0].state else .state end'; }

# 1) scaffold a source package
cr="$(OC provider create demofeed --kind source --out "$work" --json)"
save_json "phase10_create" "$cr" >/dev/null
assert_eq "install.create" "ready" "$(state <<<"$cr")" "provider create emits a package"
pkg="$(jq -r 'if type=="array" then .[0].payload.dir else .payload.dir end' <<<"$cr")"
[ -f "$pkg/provider.json" ] && ok "install.scaffold_files" "provider.json written" || fail "install.scaffold_files" "no provider.json at $pkg"

# 2) install (no --yes → pending), then --yes
assert_eq "install.pending" "pending" "$(OC provider install "$pkg" --json | state)" "install without --yes is a dry run"
inst="$(OC provider install "$pkg" --yes --json)"
save_json "phase10_install" "$inst" >/dev/null
assert_eq "install.ready" "ready" "$(state <<<"$inst")" "install --yes installs"
[ -f "$ochome/providers/demofeed/.overcast-install.json" ] && ok "install.provenance" "provenance stamped" || fail "install.provenance" "no provenance file"

# 3) list --installed shows it
li="$(OC provider list --installed --json)"
assert_eq "install.listed" "demofeed" "$(jq -r 'if type=="array" then .[0] else . end | .payload.installed[0].name' <<<"$li")" "list --installed shows the package"

# 4) the installed source type is discovered by scan (scaffold emits one hit)
OC source add "demofeed:pier9" --case "$casedir" >/dev/null 2>&1
sc="$(OC scan --source demofeed --case "$casedir" --json)"
save_json "phase10_scan" "$sc" >/dev/null
hit="$(jq -r '[if type=="array" then .[] else . end | select(.verb=="scan")][0].state' <<<"$sc")"
assert_eq "install.scan_state" "ready" "$hit" "scan through the installed source succeeds"

# 5) collision with a shipped type is rejected
evil="$work/evil"; mkdir -p "$evil"
printf '%s\n' '{"manifest_version":1,"name":"evil","version":"1.0.0","entries":[{"kind":"source","type":"tiktok","label":"x","summary":"y","base":["bash","installed:evil/e.sh"]}]}' > "$evil/provider.json"
printf 'echo hi\n' > "$evil/e.sh"
assert_eq "install.collision" "error" "$(OC provider install "$evil" --yes --json | state)" "shipped-type collision is rejected"

# 6) remove
assert_eq "install.removed" "ready" "$(OC provider remove demofeed --yes --json | state)" "remove --yes uninstalls"
[ -d "$ochome/providers/demofeed" ] && fail "install.gone" "package dir still present" || ok "install.gone" "package dir removed"
